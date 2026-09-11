import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.mjs';
import { validatePort } from '../src/ports.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTS_DIR = join(__dirname, '..', 'ports');

// Fallback instruction-file names for ports that write no ALL-CAPS root .md of their own.
// Purely data — never branch on a vendor name in logic. Anything not listed here falls
// through to DEFAULT_INSTRUCTION_FILE (the cross-tool "AGENTS.md" convention).
const INSTRUCTION_FILE_OVERRIDES = {
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md',
  qwen: 'QWEN.md',
};
const DEFAULT_INSTRUCTION_FILE = 'AGENTS.md';

// Per-probe-process timeout. Generous enough for a cold `npx` fetch of the openspec package on
// a slow link, but bounded so one hung tool can't stall the whole serial ~40-port run forever
// (the generator is a release gate — it must fail loudly, never hang).
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Parse the tool-name list out of `openspec init --help` text.
 * Returns names sorted ascending and deduped.
 * @param {{helpText: string}} opts
 * @returns {Promise<string[]>}
 */
export async function toolNames({ helpText }) {
  const match = helpText.match(/comma-separated list of:\s*([^.]+)\./);
  if (!match) {
    const err = new Error('could not find a "comma-separated list of: ..." clause in --help text');
    err.exitCode = 2;
    throw err;
  }
  const names = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(names)].sort();
}

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir)) {
    // Only skip the OpenSpec metadata dir and .git at the project ROOT — a port may legitimately
    // nest its own output under a directory that happens to be named "openspec" too (observed:
    // costrict writes `.cospec/openspec/commands/...`).
    if (dir === root && (entry === '.git' || entry === 'openspec' || entry === '.fakehome')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(root, full, out);
    } else {
      out.push(full.slice(root.length + 1));
    }
  }
  return out;
}

/**
 * Classify the relative paths a probe wrote into a raw layout description.
 * @param {string[]} relativePaths
 * @returns {{agent_dir: string|undefined, command_dir: string|undefined, command_layout: string|undefined,
 *   command_format: string|undefined, commands_supported: boolean}}
 */
export function classifyLayout(relativePaths) {
  // A "command" path is any file under the agent dir whose second segment is not the skills
  // dir — the second-segment name itself varies by port (`commands`, `prompts`, ...).
  const commandPaths = relativePaths.filter((p) => {
    const parts = p.split('/');
    return parts.length >= 3 && parts[1] !== 'skills';
  });

  if (commandPaths.length === 0) {
    return {
      agent_dir: undefined,
      command_dir: undefined,
      command_layout: undefined,
      command_format: undefined,
      commands_supported: false,
    };
  }

  const first = commandPaths[0];
  const parts = first.split('/');
  const agent_dir = parts[0];
  const filename = parts[parts.length - 1];
  // Everything between the agent dir and the filename — whatever its depth (observed: a plain
  // one-level `commands/`, but also `openspec/commands/` for costrict). This is the directory
  // that actually holds the command files, derived from where the files are, never from a fixed
  // path index.
  const dirParts = parts.slice(1, -1);
  // OpenSpec always namespaces its own generated commands under a directory or filename prefix
  // literally called "opsx" — that's the probe's own convention, not a per-vendor branch. When
  // the innermost directory IS that namespace, the real command_dir is everything above it and
  // the layout nests one level further (our own commands will nest under our own "spns"
  // namespace there instead); otherwise the namespace lives in the filename prefix and the whole
  // directory chain is the command_dir.
  const hasNamespaceSubdir = dirParts[dirParts.length - 1] === 'opsx';
  const command_dir = (hasNamespaceSubdir ? dirParts.slice(0, -1) : dirParts).join('/');
  const command_layout = hasNamespaceSubdir ? 'subdir' : 'flat-prefixed';
  const extMatch = filename.match(/\.([^.]+)$/);
  const command_format = extMatch ? extMatch[1] : undefined;

  return { agent_dir, command_dir, command_layout, command_format, commands_supported: true };
}

/**
 * Classify skill layout from the relative paths a probe wrote.
 * @param {string[]} relativePaths
 * @returns {{agent_dir: string|undefined, skill_dir: string|undefined, skill_layout: string|undefined,
 *   skills_supported: boolean}}
 */
function classifySkills(relativePaths) {
  const skillPaths = relativePaths.filter((p) => /\/skills\//.test(`/${p}`) || p.includes('/skills/'));
  if (skillPaths.length === 0) {
    return { agent_dir: undefined, skill_dir: undefined, skill_layout: undefined, skills_supported: false };
  }
  const first = skillPaths[0];
  const parts = first.split('/');
  const skillsIdx = parts.indexOf('skills');
  const agent_dir = parts.slice(0, skillsIdx).join('/');
  const skill_dir = parts[skillsIdx];
  // dir-per-skill: skills/<name>/SKILL.md
  const skill_layout = 'dir-per-skill';
  return { agent_dir, skill_dir, skill_layout, skills_supported: true };
}

function findInstructionFile(relativePaths) {
  const rootCaps = relativePaths.find((p) => {
    if (p.includes('/')) return false;
    if (!p.endsWith('.md')) return false;
    const base = p.slice(0, -3);
    return base === base.toUpperCase() && /[A-Z]/.test(base);
  });
  return rootCaps;
}

// Mechanical title-case of the hyphenated tool id (e.g. "amazon-q" -> "Amazon Q"). Not a
// per-vendor lookup — just a generic string transform, so it won't always match a brand's
// own internal capitalization, but it's non-branching and good enough for a label.
function titleCase(name) {
  return name
    .split('-')
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function normalizeCommandLayout(raw) {
  if (raw === 'subdir') return 'subdir-unprefixed';
  return raw;
}

/**
 * Probe `openspec init --tools <name>` for each name in a fresh temp dir and build a port object
 * for each, validating against validatePort before returning.
 * @param {{openspecInvocation: string, names: string[], tmpRoot?: string}} opts
 * @returns {Promise<object[]>}
 */
export async function generatePorts({ openspecInvocation, names, tmpRoot }) {
  const [cmd, ...invocationArgs] = openspecInvocation.split(' ');
  const versionMatch = openspecInvocation.match(/@([0-9]+\.[0-9]+\.[0-9]+)/);
  const version = versionMatch ? versionMatch[1] : 'unknown';
  const today = new Date().toISOString().slice(0, 10);
  const fallbacksUsed = [];
  const skipped = [];
  const ports = [];

  for (const name of names) {
    const dir = mkdtempSync(join(tmpRoot ?? tmpdir(), `gen-port-${name}-`));
    // Some probed tools write outside the project directory entirely (observed: minimax-code
    // writes to "$HOME/.minimax/skills"). Point HOME at a disposable directory OUTSIDE the
    // project dir so any such writes land there instead of on the real machine, and never get
    // walked as part of this port's own output.
    const fakeHome = mkdtempSync(join(tmpRoot ?? tmpdir(), `gen-port-${name}-home-`));
    // Redirect every env var a tool or the npx layer beneath it could use to resolve a GLOBAL
    // path — not just HOME/USERPROFILE. `npx` itself honours npm_config_cache over HOME, and a
    // probed tool could consult any of the XDG dirs. All of them get pointed inside fakeHome so a
    // stray global write lands in the disposable sandbox, never on the real machine (this is the
    // same class of incident as the ~/.minimax/skills write already caught and cleaned up; this
    // closes the rest of it).
    const xdgConfigHome = join(fakeHome, '.config');
    const xdgDataHome = join(fakeHome, '.local', 'share');
    const xdgCacheHome = join(fakeHome, '.cache');
    const xdgStateHome = join(fakeHome, '.local', 'state');
    const npmCacheDir = join(fakeHome, '.npm-cache');
    const npmPrefixDir = join(fakeHome, '.npm-prefix');
    const npmUserconfig = join(fakeHome, '.npmrc');
    for (const d of [xdgConfigHome, xdgDataHome, xdgCacheHome, xdgStateHome, npmCacheDir, npmPrefixDir]) {
      mkdirSync(d, { recursive: true });
    }
    const probeEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_STATE_HOME: xdgStateHome,
      npm_config_cache: npmCacheDir,
      npm_config_prefix: npmPrefixDir,
      NPM_CONFIG_USERCONFIG: npmUserconfig,
    };
    try {
      const gitResult = await run('git', ['init', '-q'], { cwd: dir, env: probeEnv, timeout: PROBE_TIMEOUT_MS });
      if (gitResult.code !== 0) {
        throw new Error(`git init failed for ${name} in ${dir}: ${gitResult.stderr}`);
      }

      const initArgs = [...invocationArgs, 'init', '--tools', name, '--no-animation', '.'];
      const initResult = await run(cmd, initArgs, { cwd: dir, env: probeEnv, timeout: PROBE_TIMEOUT_MS });
      if (initResult.code !== 0) {
        const reason = initResult.timedOut
          ? `timed out after ${PROBE_TIMEOUT_MS}ms`
          : (initResult.stderr || initResult.stdout);
        throw new Error(`openspec init failed for ${name}: ${reason}`);
      }

      const relativePaths = walk(dir);
      const commandInfo = classifyLayout(relativePaths);
      const skillInfo = classifySkills(relativePaths);
      const agent_dir = commandInfo.agent_dir ?? skillInfo.agent_dir;

      if (!commandInfo.commands_supported && !skillInfo.skills_supported) {
        // Nothing written inside the project directory at all (observed: minimax-code, which
        // writes only to a global, outside-the-project location) — there is no port to record.
        skipped.push(name);
        continue;
      }

      let instruction_file = findInstructionFile(relativePaths);
      let instructionFileWasProbed = true;
      if (!instruction_file) {
        instruction_file = INSTRUCTION_FILE_OVERRIDES[name] ?? DEFAULT_INSTRUCTION_FILE;
        instructionFileWasProbed = false;
        fallbacksUsed.push(name);
      }

      // A conventional (not probed) instruction_file is a guess, not a verified fact — disclose
      // it in `verified` itself so `--list-ports` can show an operator which is which, per
      // controller ruling. An entry whose instruction_file really came from the probe carries no
      // such clause.
      const verified = instructionFileWasProbed
        ? `${today}, @fission-ai/openspec ${version}`
        : `${today}, @fission-ai/openspec ${version}; instruction_file conventional (not probed)`;

      const port = {
        id: name,
        label: titleCase(name),
        agent_dir,
        scope_preference: ['project'],
        commands_supported: commandInfo.commands_supported,
        skills_supported: skillInfo.skills_supported,
        instruction_file,
        verified,
      };

      if (commandInfo.commands_supported) {
        port.command_dir = commandInfo.command_dir;
        port.command_layout = normalizeCommandLayout(commandInfo.command_layout);
        port.command_format = commandInfo.command_format;
        // command_prefix is serpens-sdd's own namespace token, not anything the probe observed
        // (the probe's own commands are namespaced "opsx-"/"opsx/" — ours will be "spns").
        // flat-prefixed layouts prepend it to the filename; subdir layouts use it as the
        // namespacing subdirectory name instead.
        port.command_prefix = commandInfo.command_layout === 'flat-prefixed' ? 'spns-' : 'spns';
        port.args_token = '{{args}}';
      }

      if (skillInfo.skills_supported) {
        port.skill_dir = skillInfo.skill_dir;
        port.skill_layout = skillInfo.skill_layout;
      }

      const { ok, errors } = validatePort(port);
      if (!ok) {
        const err = new Error(`generated port "${name}" failed validation: ${errors.join('; ')}`);
        err.exitCode = 2;
        throw err;
      }

      ports.push(port);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  if (fallbacksUsed.length > 0) {
    process.stderr.write(
      `Note: instruction_file came from the override map (not probed) for: ${fallbacksUsed.sort().join(', ')}\n`,
    );
  }
  if (skipped.length > 0) {
    process.stderr.write(
      `Note: skipped (probe wrote nothing inside the project directory): ${skipped.sort().join(', ')}\n`,
    );
  }

  return ports;
}

function writePortFile(port, registryDir = PORTS_DIR) {
  const sortedKeys = Object.keys(port).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = port[k];
  const json = `${JSON.stringify(sorted, null, 2)}\n`;
  writeFileSync(join(registryDir, `${port.id}.json`), json, 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--openspec');
  if (idx === -1 || !args[idx + 1]) {
    process.stderr.write('usage: gen-ports.mjs --openspec "<invocation>"\n');
    process.exitCode = 2;
    return;
  }
  const openspecInvocation = args[idx + 1];
  const [cmd, ...invocationArgs] = openspecInvocation.split(' ');

  const helpResult = await run(cmd, [...invocationArgs, 'init', '--help']);
  if (helpResult.code !== 0) {
    process.stderr.write(`could not run --help: ${helpResult.stderr || helpResult.stdout}\n`);
    process.exitCode = 3;
    return;
  }

  const names = await toolNames({ helpText: helpResult.stdout });
  if (names.length === 0) {
    process.stderr.write('no tool names parsed from --help output\n');
    process.exitCode = 2;
    return;
  }

  if (!existsSync(PORTS_DIR)) {
    process.stderr.write(`ports directory missing: ${PORTS_DIR}\n`);
    process.exitCode = 3;
    return;
  }

  const ports = await generatePorts({ openspecInvocation, names });
  for (const port of ports) {
    writePortFile(port);
  }

  process.stdout.write(`Generated ${ports.length} ports: ${ports.map((p) => p.id).join(', ')}\n`);
}

/**
 * Map a thrown error to the process exit code the package-wide contract requires: an explicit
 * `err.exitCode` (2 = bad usage/config, 3 = missing precondition) when the error set one, else 1
 * (generic gate failure). Exported and unit-testable without launching a probe.
 * @param {Error & {exitCode?: number}} err
 * @returns {number}
 */
export function exitCodeFor(err) {
  return err?.exitCode ?? 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = exitCodeFor(err);
  });
}
