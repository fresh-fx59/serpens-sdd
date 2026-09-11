import { cpSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from '../src/integrity.mjs';
import { resolveKitSource } from './kit-source.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
// Sources are RESOLVED (see kit-source.mjs): the vault spells them `serpens-sdd-starter*`, the
// public repository spells the same trees `en/` and `ru/`. The vendored TARGETS are always
// kits/en and kits/ru — that is the package's own layout and it does not move.
export const KITS = [
  { source: resolveKitSource('en'), target: join(ROOT, 'kits', 'en') },
  { source: resolveKitSource('ru'), target: join(ROOT, 'kits', 'ru') },
];

/**
 * Every path that differs between a vault kit tree and its vendored copy: missing on either
 * side, or present on both with different bytes.
 * @param {string} source
 * @param {string} target
 * @returns {string[]} sorted relative paths
 */
export function diff(source, target) {
  const sourceFiles = new Set(walk(source));
  const targetFiles = new Set(walk(target));
  const differing = [];
  for (const f of sourceFiles) {
    const sPath = join(source, f);
    const tPath = join(target, f);
    if (!targetFiles.has(f)) {
      differing.push(f);
      continue;
    }
    if (!readFileSync(sPath).equals(readFileSync(tPath))) differing.push(f);
  }
  for (const f of targetFiles) {
    if (!sourceFiles.has(f)) differing.push(f);
  }
  return differing.sort();
}

/**
 * Remove every path under `target` that has no counterpart under `source` (a "target-only"
 * path — e.g. a file or whole subtree the vault kit no longer ships), then remove any directory
 * left empty by those deletions, walking bottom-up so a parent empties out only after its
 * children are gone.
 *
 * This exists because `cpSync(source, target, { recursive: true })` only ever ADDS or
 * overwrites — it never deletes — so without this step a `--resync` could never converge:
 * a path removed from the vault tree (e.g. Task 3 deleting `scripts/tools/`) would stay in the
 * vendored copy forever, `diff()` would report it every single run, and a plain
 * `node scripts/vendor-kits.mjs` would refuse in perpetuity even immediately after a resync.
 * @param {string} source
 * @param {string} target
 * @returns {string[]} the target-only relative paths that were removed
 */
function pruneEmptyDirs(dir, root) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(join(dir, e.name), root);
  }
  if (dir !== root && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pruneTargetOnly(source, target) {
  const sourceFiles = new Set(walk(source));
  const targetOnly = walk(target).filter((f) => !sourceFiles.has(f)).sort();
  for (const f of targetOnly) {
    rmSync(join(target, f), { force: true });
  }
  // A removed file can leave its whole ancestor chain of directories empty (e.g. removing every
  // file under scripts/tools/ also empties scripts/ itself) — walk the full target tree bottom-up
  // and remove any directory left with nothing in it, rather than only the removed files'
  // immediate parents.
  pruneEmptyDirs(target, target);
  return targetOnly;
}

/**
 * Vendor one kit tree.
 *
 * Default (`resync: false`): an existing target that differs is REFUSED, naming every differing
 * path — the guard that keeps `kits/` from quietly becoming a second source of truth for kit
 * bytes, and the behaviour a direct `node scripts/vendor-kits.mjs` still gets.
 *
 * With `resync: true`: an existing, differing target is overwritten from the source AND any
 * target-only path is deleted (via pruneTargetOnly, above) — what an edition bump needs, and
 * what convergence needs: `release.mjs` stamps both vault trees a step earlier, so by the time
 * vendoring runs the vendored copies are ALWAYS behind, and a source deletion (a script moving
 * out of the kit, say) must actually disappear from `kits/` too, or `kits/` becomes a second,
 * silently-diverging copy of the kit bytes — exactly the invariant this file exists to protect.
 * @param {{source: string, target: string, resync?: boolean}} opts
 * @returns {{ok: boolean, action: string, differing?: string[], message: string}}
 */
export function vendorKit({ source, target, resync = false }) {
  if (existsSync(target)) {
    const differing = diff(source, target);
    if (differing.length === 0) {
      return { ok: true, action: 'unchanged', message: `${target} already matches ${source}, skipping` };
    }
    if (!resync) {
      return {
        ok: false,
        action: 'refused',
        differing,
        message: `refusing to vendor: ${target} already exists and differs from ${source}:\n`
          + differing.map((f) => `  ${f}`).join('\n')
          + '\n  (re-run with --resync to overwrite the vendored copy from the vault tree)',
      };
    }
    cpSync(source, target, { recursive: true });
    const removed = pruneTargetOnly(source, target);
    return {
      ok: true,
      action: 'resynced',
      differing,
      message: `re-synced ${source} -> ${target} (${differing.length} differing path(s)`
        + (removed.length ? `, ${removed.length} target-only path(s) removed: ${removed.join(', ')})` : ')'),
    };
  }
  cpSync(source, target, { recursive: true });
  return { ok: true, action: 'vendored', message: `vendored ${source} -> ${target}` };
}

/**
 * Parse argv (excluding node + script path): no arguments, or exactly `--resync`. Anything else
 * is a usage error (exit 2) rather than being ignored, so a typo can never silently take the
 * refusing path when a re-sync was intended (or the other way round).
 * @param {string[]} argv
 * @returns {{resync: boolean}}
 */
export function parseArgs(argv) {
  if (argv.length === 0) return { resync: false };
  if (argv.length === 1 && argv[0] === '--resync') return { resync: true };
  const err = new Error(`unrecognized argument(s): ${argv.join(' ')} (expected no arguments, or exactly --resync)`);
  err.exitCode = 2;
  throw err;
}

function main() {
  const { resync } = parseArgs(process.argv.slice(2));
  let failed = false;
  for (const kit of KITS) {
    const result = vendorKit({ ...kit, resync });
    if (result.ok) console.log(result.message);
    else {
      console.error(result.message);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

// Importing this file (from a test, to reach vendorKit/parseArgs) must never vendor anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(typeof err.exitCode === 'number' ? err.exitCode : 1);
  }
}
