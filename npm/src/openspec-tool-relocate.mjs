import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { OPENSPEC_TOOL_SKILLS_DIR, needsOpenspecRelocation } from './ports.mjs';

// spec-openspec-coexistence-2026-09-22.md: `serpens-sdd init` for a port whose `openspec_tool`
// differs from its own id (GigaCode -> qwen) has to run OpenSpec against a tool id OpenSpec
// actually knows, then move what OpenSpec just wrote into the port's REAL agent_dir — GigaCode
// reads `.gigacode/`, not `.qwen/`. This module is the "move what OpenSpec just wrote" half.
//
// SNAPSHOT-BASED, never a blind directory move: a repository may already have a real `.qwen/`
// (the operator also uses Qwen Code directly) and its files are NOT ours to touch. We snapshot
// the tool's OpenSpec directory before running `openspec init`/`update`, and afterwards move only
// the files that snapshot did not contain — see `relocateAfterOpenspecRun`.

/** Every regular file under `root`, as paths relative to `root` (POSIX-joined). Empty when
 * `root` does not exist. */
function listFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/**
 * A snapshot of the OpenSpec tool directory a port maps onto, taken BEFORE running
 * `openspec init`/`openspec update` — the "what was already there" half of the diff that decides
 * which files relocation is allowed to move.
 * @param {string} repoRoot
 * @param {object} port
 * @returns {{sourceDir: string|null, existedBefore: boolean, filesBefore: Set<string>}}
 */
export function snapshotOpenspecToolDir(repoRoot, port) {
  if (!needsOpenspecRelocation(port)) return { sourceDir: null, existedBefore: false, filesBefore: new Set() };
  const toolDirName = OPENSPEC_TOOL_SKILLS_DIR[port.openspec_tool];
  if (!toolDirName) {
    throw new Error(`openspec-tool-relocate: no known OpenSpec skillsDir for tool "${port.openspec_tool}" — add one to OPENSPEC_TOOL_SKILLS_DIR in src/ports.mjs`);
  }
  const sourceDir = join(repoRoot, toolDirName);
  return { sourceDir, existedBefore: existsSync(sourceDir), filesBefore: new Set(listFiles(sourceDir)) };
}

/** Rewrites every `.qwen`-style in-file path reference to the port's own agent_dir. Only
 * touches UTF-8 text; a file that fails to decode as text is left byte-for-byte. */
function rewriteToolRefs(content, fromDirName, toDirName) {
  const fromToken = fromDirName.replace(/^\./, '');
  const toToken = toDirName.replace(/^\./, '');
  return content.split(`.${fromToken}`).join(`.${toToken}`);
}

/**
 * The second half of the diff: after `openspec init`/`openspec update` has run, move every file
 * under the OpenSpec tool directory that the pre-run snapshot did NOT contain into the port's own
 * `agent_dir`, rewriting `.qwen`-style path references inside each moved text file to the port's
 * own dir name. Files the snapshot DID contain (a pre-existing real Qwen Code install) are never
 * touched or moved. If the tool directory did not exist before this run and ends up empty after
 * the move, it is removed — never otherwise.
 *
 * @param {string} repoRoot
 * @param {object} port
 * @param {{sourceDir: string|null, existedBefore: boolean, filesBefore: Set<string>}} snapshot
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{moved: string[], skippedPreexisting: string[], removedEmptySourceDir: boolean}}
 */
export function relocateAfterOpenspecRun(repoRoot, port, snapshot, opts = {}) {
  const result = { moved: [], skippedPreexisting: [], removedEmptySourceDir: false };
  if (!needsOpenspecRelocation(port)) return result;
  const { sourceDir, filesBefore } = snapshot;
  if (!sourceDir || !existsSync(sourceDir)) return result;
  const dryRun = Boolean(opts.dryRun);
  const toolDirName = OPENSPEC_TOOL_SKILLS_DIR[port.openspec_tool];
  const destRoot = join(repoRoot, port.agent_dir);
  const filesAfter = listFiles(sourceDir);

  for (const rel of filesAfter) {
    if (filesBefore.has(rel)) {
      result.skippedPreexisting.push(rel);
      continue;
    }
    const srcPath = join(sourceDir, rel);
    const destPath = join(destRoot, rel);
    result.moved.push(rel);
    if (dryRun) continue;
    mkdirSync(dirname(destPath), { recursive: true });
    let raw;
    try {
      raw = readFileSync(srcPath, 'utf8');
    } catch {
      raw = null;
    }
    if (raw !== null && !/\0/.test(raw)) {
      writeFileSync(destPath, rewriteToolRefs(raw, toolDirName, port.agent_dir), 'utf8');
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
    }
    rmSync(srcPath);
  }

  // Only remove the source dir (and only it, never anything the snapshot found already there)
  // when it did not exist before this run AND is now empty of everything but empty subdirs.
  if (!snapshot.existedBefore && existsSync(sourceDir) && listFiles(sourceDir).length === 0) {
    rmSync(sourceDir, { recursive: true, force: true });
    result.removedEmptySourceDir = true;
  }
  return result;
}
