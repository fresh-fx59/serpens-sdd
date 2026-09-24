import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../run.mjs';
import { kitPath } from '../integrity.mjs';

/** The package's own tools/ directory — the single home of the eleven executables. */
const TOOLS_DIR = fileURLToPath(new URL('../../tools/', import.meta.url)).replace(/\/$/, '');

/**
 * Subcommand -> shipped script mapping. Every entry ships in the package's own tools/
 * and is read-only: we wrap it, never edit it.
 */
export const TOOL_COMMANDS = {
  lint: 'serpens-lint.mjs',
  index: 'gen-index.mjs',
  'split-brain': 'check-contract-split-brain.mjs',
  state: 'repository-state.sh',
  'git-naming': 'check-git-naming.sh',
  delivery: 'delivery.sh',
  'openspec-root': 'check-openspec-root.sh',
  'sync-submodules': 'sync-submodules.sh',
  catalog: 'aggregate-index.mjs',
  'index-code': 'index-all.sh',
  version: 'kit-version.sh',
};

/**
 * The absolute path of the shipped script for a subcommand.
 * @param {string} name - a TOOL_COMMANDS key
 * @param {string} [_lang] - accepted and ignored; the executables are language-neutral
 * @returns {string}
 */
export function toolPath(name, _lang = 'en') {
  const script = TOOL_COMMANDS[name];
  if (!script) throw new Error(`unknown tool subcommand "${name}"`);
  return join(TOOLS_DIR, script);
}

/**
 * Resolve a tool subcommand to an executable {cmd, args}, argv forwarded untouched.
 * @param {string} name - a TOOL_COMMANDS key
 * @param {string[]} [argv] - arguments to forward to the script verbatim
 * @param {string} [lang] - which vendored kit to resolve against (default 'en')
 * @returns {{cmd: string, args: string[]}}
 */
export function resolveTool(name, argv = [], lang = 'en') {
  const script = toolPath(name, lang);
  if (script.endsWith('.sh')) {
    return { cmd: 'bash', args: [script, ...argv] };
  }
  return { cmd: process.execPath, args: [script, ...argv] };
}

/**
 * The git root of `from`, or `from` itself when it is not inside a repository. Exported so
 * `src/cli/verify-docs.mjs` — the one subcommand implemented in the CLI layer instead of
 * wrapped from a vendored script — can resolve the same way every other tool subcommand does.
 * @param {string} from
 * @returns {string}
 */
export function findGitRoot(from) {
  try {
    // `stdio: ['ignore', 'pipe', 'ignore']` — the `catch` below already handles "not a git
    // repository" as the ordinary, expected case (a globally-installed CLI run anywhere), so
    // git's own message on stderr is noise, not information. Reproduced by installing the real
    // tarball and running `serpens-sdd version` in /tmp: the command WORKED — the edition on
    // stdout, exit 0 — while `fatal: not a git repository` went to stderr, which is what a user
    // sees on their terminal. The first command the README tells them to run looked broken.
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return from;
  }
}

/**
 * `serpens-sdd version` supplies the two things `kit-version.sh` cannot guess, and nothing else.
 *
 * `kit-version.sh` requires `--root` in EVERY mode (deliberately: a script living in the package
 * cannot know which kit tree it is being asked about) and exits 2 with a usage dump without one.
 * So bare `version` — which docs/SETUP.md's stage 8 runs as its very first proof that the shim
 * resolves — and every mode given without `--root` (`version show`, `version check`, ...) would
 * both fail. The CLI layer is the one place that DOES know the default: the package's own
 * vendored kit, via `kitPath`. Both kits ship the same edition (VERSION is identical across
 * `kits/en` and `kits/ru`), so `en` is a safe default regardless of which language a given
 * install actually uses.
 *
 * An explicit `--root` is never touched, and no mode is ever substituted for another: only a
 * missing mode (bare call) becomes `show`, and only a missing `--root` is filled in.
 * @param {string[]} argv - as given by the caller, before any default is applied
 * @returns {string[]} argv to actually forward to kit-version.sh
 */
export function defaultVersionArgv(argv) {
  const withMode = argv.length > 0 ? argv : ['show'];
  if (withMode.some((a) => a === '--root' || a.startsWith('--root='))) return withMode;
  // `-h`/`--help` wants the usage text, not a kit: leave it alone.
  if (withMode.some((a) => a === '-h' || a === '--help')) return withMode;
  return [...withMode, '--root', kitPath('en')];
}

/**
 * Run a tool subcommand, forwarding the child's exit code unchanged.
 * @param {string} name - a TOOL_COMMANDS key
 * @param {string[]} argv - arguments to forward verbatim
 * @returns {Promise<number>}
 */
export async function runTool(name, argv) {
  const effectiveArgv = name === 'version' ? defaultVersionArgv(argv) : argv;
  const { cmd, args } = resolveTool(name, effectiveArgv);
  const cwd = findGitRoot(process.cwd());
  const result = await run(cmd, args, { cwd });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

/**
 * CLI entry point for every tool subcommand. `name` is passed by the dispatcher
 * (bin/serpens-sdd.mjs) as the second argument, alongside the forwarded argv.
 * @param {string[]} argv
 * @param {string} name - a TOOL_COMMANDS key
 * @returns {Promise<number>}
 */
export default async function main(argv, name) {
  return runTool(name, argv);
}

/**
 * The bin dispatcher's full COMMANDS table: 'help' plus every TOOL_COMMANDS key, all pointing
 * at the file that implements them. Built here — the single source of names — so bin/serpens-sdd.mjs
 * never hand-maintains a second copy of the tool names that could drift out of sync.
 * @returns {Record<string, string>}
 */
export function buildCommandTable() {
  return {
    help: 'help.mjs',
    // 'verify-docs' is the one subcommand implemented in the CLI layer rather than wrapped
    // from a vendored script (see src/cli/verify-docs.mjs) — every other wrapped script takes
    // its working root from argv, cwd, or --repo, but verify-docs.sh alone derives it from its
    // own script location on disk, which breaks once it is no longer copied into the target
    // repository's tools/.
    'verify-docs': 'verify-docs.mjs',
    // 'uninstall' (step 7, gap 6): the reverse of `init`, so it lives in the CLI layer the same
    // way — a real command with its own file, not a wrapped tools/ script.
    uninstall: 'uninstall.mjs',
    // 'opsx-sync' (spec-openspec-coexistence-2026-09-22.md): re-runs `openspec update` for a
    // port whose OpenSpec artifacts live under a RELOCATED agent_dir (openspec_tool set — e.g.
    // GigaCode) and relocates the refreshed output again. Same CLI-layer shape as `uninstall`.
    'opsx-sync': 'opsx-sync.mjs',
    // 'check-schema' (item 4b, Option C): the shared entry-precondition kit commands run
    // before doing anything else — same CLI-layer shape as `uninstall`/`opsx-sync`.
    'check-schema': 'check-schema.mjs',
    ...Object.fromEntries(Object.keys(TOOL_COMMANDS).map((name) => [name, 'tools.mjs'])),
  };
}
