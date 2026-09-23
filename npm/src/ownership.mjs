import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LAYOUT, OWNED_PREFIXES } from './layout.mjs';

// Which OpenSpec change directories are OURS — gap 2, serpens-openspec-coexistence-gaps-2026-09-22.md.
//
// Nothing distinguished a Serpens change from a hand-made one before this file: serpens-lint.mjs
// judged every dir under openspec/changes/ the same way, and OWNED_PREFIXES (src/layout.mjs) was
// declared and never read. This module is the one place that answers "is this change ours?" and
// "is this path ours?" — everyone else (serpens-lint.mjs, verify-docs.mjs, check-git-naming.sh via
// tools/lib/ownership.sh, the shell twin) calls in here rather than re-deriving the rule.
//
// WHY A SIBLING FILE, NOT A KEY INSIDE .openspec.yaml. Upstream owns that file (writeChangeMetadata,
// src/utils/change-utils.ts:197); its schema is a plain z.object, not .strict(), today — but one
// upstream line making it strict would make readChangeMetadata throw on an unknown key and break
// vanilla `status`/`validate` on every Serpens-marked change. `.serpens.yaml` is a sibling upstream
// never reads, so upstream can tighten its own schema without ever breaking us.

/** First line of every `.serpens.yaml` this kit writes — read back to tell "ours" from a
 * coincidentally-named file a human or another tool created. */
export const CHANGE_MARKER_FIRST_LINE = '# serpens-sdd:change-marker';

/** The marker's filename, inside `openspec/changes/<id>/`, sibling of upstream's `.openspec.yaml`. */
export const CHANGE_MARKER_FILE = LAYOUT.changeMarker;

const OWNER_LINE_RE = /^owner:\s*serpens-sdd\s*$/m;

/**
 * True iff `changeDir` carries our marker with `owner: serpens-sdd`. False for a missing
 * directory, a missing marker, or a marker whose owner is anything else — never throws.
 * @param {string} changeDir absolute path to `openspec/changes/<id>` (active or archived)
 * @returns {boolean}
 */
export function isOwnedChange(changeDir) {
  const markerPath = join(changeDir, CHANGE_MARKER_FILE);
  if (!existsSync(markerPath)) return false;
  let text;
  try {
    text = readFileSync(markerPath, 'utf8');
  } catch {
    return false;
  }
  return OWNER_LINE_RE.test(text);
}

function listChangeDirs(base) {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => name !== 'archive' && !name.startsWith('.'))
    .map((name) => join(base, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Every owned change directory under `repoRoot`, active AND archived (the marker rides into
 * `openspec/changes/archive/<date>-<id>/` on `openspec archive` — upstream's `copyDirContents`
 * copies dotfiles too).
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function ownedChanges(repoRoot) {
  const changesRoot = join(repoRoot, 'openspec', 'changes');
  const active = listChangeDirs(changesRoot);
  const archived = listChangeDirs(join(changesRoot, 'archive'));
  return [...active, ...archived].filter(isOwnedChange);
}

/**
 * True iff `relPath` (relative to `repoRoot`, forward-slash separated) is ours: under an
 * `OWNED_PREFIXES` entry (today: `serpens/`), OR under a marked `openspec/changes/<id>/`
 * directory (active or archived).
 * @param {string} relPath
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isOwnedPath(relPath, repoRoot) {
  const norm = relPath.split('\\').join('/');
  if (OWNED_PREFIXES.some((prefix) => norm.startsWith(prefix))) return true;

  const archivePrefix = 'openspec/changes/archive/';
  const changesPrefix = 'openspec/changes/';
  let changeId;
  if (norm.startsWith(archivePrefix)) {
    changeId = norm.slice(archivePrefix.length).split('/')[0];
    if (!changeId) return false;
    return isOwnedChange(join(repoRoot, 'openspec', 'changes', 'archive', changeId));
  }
  if (norm.startsWith(changesPrefix)) {
    const rest = norm.slice(changesPrefix.length);
    changeId = rest.split('/')[0];
    if (!changeId || changeId === 'archive') return false;
    return isOwnedChange(join(repoRoot, 'openspec', 'changes', changeId));
  }
  return false;
}
