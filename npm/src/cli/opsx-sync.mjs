import {
  existsSync, mkdirSync, readdirSync, copyFileSync, cpSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { run } from '../run.mjs';
import { loadPort, needsOpenspecRelocation, OPENSPEC_TOOL_SKILLS_DIR } from '../ports.mjs';
import { snapshotOpenspecToolDir, relocateAfterOpenspecRun } from '../openspec-tool-relocate.mjs';
import { portIdFromFacts, openspecTokenFromFacts } from './uninstall.mjs';
import { splitInvocation } from '../invocation.mjs';

// spec-openspec-coexistence-2026-09-22.md: for a port whose OpenSpec artifacts were relocated
// away from OpenSpec's own tool dir (openspec_tool set, e.g. GigaCode from `.qwen`),
// `openspec update` alone cannot see them — `getAvailableTools()` (OpenSpec 1.13.1
// `dist/core/available-tools.js`) detects a configured tool by checking whether ITS OWN
// directory exists on disk, and after relocation it no longer does. `opsx-sync` is the supported
// path: it stages the tool's directory back (copied, not moved — so a real crash mid-run leaves
// the relocated copy intact), runs `openspec update`, then relocates the refreshed output again.

function readFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--') ? argv[idx + 1] : undefined;
}

/**
 * Copies ONLY the OpenSpec-owned subset of a relocated port's agent_dir back into OpenSpec's
 * own tool dir, so `openspec update`'s directory-existence detection sees it, WITHOUT dragging
 * along Serpens' own commands/skills (whose filenames never start with `opsx-`/`openspec-`, so
 * this filter cannot mix the two up) or corrupting anything a real, separate install of that
 * tool already has there — this is only called when the tool dir does not already exist.
 * @param {string} root
 * @param {object} port
 * @param {string} toolDir
 */
function stageOpsxFilesInto(root, port, toolDir) {
  const agentRoot = join(root, port.agent_dir);
  const commandSrc = join(agentRoot, port.command_dir);
  if (existsSync(commandSrc)) {
    const commandDest = join(toolDir, 'commands');
    for (const f of readdirSync(commandSrc).filter((f) => f.startsWith('opsx-'))) {
      mkdirSync(commandDest, { recursive: true });
      copyFileSync(join(commandSrc, f), join(commandDest, f));
    }
  }
  const skillSrc = join(agentRoot, port.skill_dir);
  if (existsSync(skillSrc)) {
    const skillDest = join(toolDir, 'skills');
    for (const d of readdirSync(skillSrc, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('openspec-'))
      .map((e) => e.name)) {
      cpSync(join(skillSrc, d), join(skillDest, d), { recursive: true });
    }
  }
}

export default async function main(argv = []) {
  const root = readFlagValue(argv, '--root') ?? process.cwd();
  const dryRun = !argv.includes('--apply');

  const portId = portIdFromFacts(root);
  if (!portId) {
    console.error(`✗ opsx-sync: no serpens/port-facts.md found at ${root} — is this an onboarded root?`);
    return 2;
  }
  let port;
  try {
    port = loadPort({ id: portId });
  } catch (e) {
    console.error(`✗ opsx-sync: ${e.message}`);
    return e.exitCode ?? 2;
  }
  if (!needsOpenspecRelocation(port)) {
    console.log(`opsx-sync: port "${portId}" is not a relocated port (no openspec_tool override) — run \`openspec update\` directly instead.`);
    return 0;
  }
  const openspecToken = openspecTokenFromFacts(root);
  if (!openspecToken) {
    console.error(`✗ opsx-sync: could not recover the OpenSpec invocation from serpens/port-facts.md at ${root}`);
    return 2;
  }
  const { cmd: openspecCmd, args: openspecBaseArgs } = splitInvocation(openspecToken);

  console.log(`opsx-sync ${dryRun ? '(dry-run — pass --apply to actually run it)' : ''}: ${root} — port ${portId}, OpenSpec tool ${port.openspec_tool}`);
  if (dryRun) {
    console.log(`  $ (stage relocated opsx-*/openspec-* files from ${port.agent_dir}/ back into .${port.openspec_tool}/)`);
    console.log(`  $ ${openspecToken} update   # cwd=${root}`);
    console.log(`  $ (relocate the refreshed .${port.openspec_tool}/ output back into ${port.agent_dir}/, remove the staged dir again)`);
    return 0;
  }

  const toolDirName = OPENSPEC_TOOL_SKILLS_DIR[port.openspec_tool];
  const toolDir = join(root, toolDirName);
  const stagedNow = !existsSync(toolDir);
  if (stagedNow) {
    // Stage COPIES of only the opsx-owned subset, not a move and not the whole agent_dir:
    // `openspec update` runs next, and any failure there must leave the current, working
    // `<agent_dir>/` content untouched, and Serpens' own commands/skills must never appear
    // inside OpenSpec's tool dir even transiently.
    stageOpsxFilesInto(root, port, toolDir);
  }

  const snapshot = stagedNow
    ? { sourceDir: toolDir, existedBefore: false, filesBefore: new Set() }
    : snapshotOpenspecToolDir(root, port);

  const updated = await run(openspecCmd, [...openspecBaseArgs, 'update'], { cwd: root });
  if (updated.code !== 0) {
    console.error(`✗ openspec update failed:\n${updated.stderr || updated.stdout}`);
    if (stagedNow) rmSync(toolDir, { recursive: true, force: true });
    return 1;
  }

  const relocation = relocateAfterOpenspecRun(root, port, stagedNow
    ? { sourceDir: toolDir, existedBefore: false, filesBefore: new Set() }
    : snapshot);
  console.log(`  relocated ${relocation.moved.length} refreshed file(s) into ${port.agent_dir}/`);
  if (relocation.skippedPreexisting.length > 0) {
    console.log(`  left ${relocation.skippedPreexisting.length} pre-existing file(s) untouched under .${port.openspec_tool}/`);
  }
  return 0;
}
