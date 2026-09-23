#!/usr/bin/env node
// prune-public-tree.mjs — the release step that DELETES files retired from the vault source
// but still present in a public-repo checkout of the public repository (fresh-fx59/serpens-sdd).
//
// Why this exists: the vault->public sync has always been overwrite-and-add (vendor-kits.mjs's
// own doc calls this out for kits/, and the manual copy used to assemble the public repo works
// the same way) — new and changed files land, but a file the vault stopped shipping is never
// removed. `en/config/project-repositories.json.example` is the file that exposed this: it was
// retired from serpens-sdd-starter/config/ but kept shipping publicly until someone deleted it
// by hand in a throwaway clone. That fix does not survive the next retirement, so this script
// fixes the whole class: anything the vault no longer owns, in a directory the vault DOES own,
// gets deleted — except the §10-preserved archival docs, which this script must never touch.
//
// Scope is deliberately narrow: only the four directories the vault actually syncs into the
// public repo (en/, ru/, npm/, tests/ — spec-npm-oidc-publishing-2026-09-11.md §9's table).
// Everything else at the public repo root (docs/, the zips, LICENSE, README.md, the CI
// workflow directory, .git) is out of scope and never inspected, let alone deleted — that is
// what §10 calls "the public repo's own durable store". An unrecognised top-level entry makes
// the whole run REFUSE rather than guess: this script would rather stop than delete something
// it cannot explain.
//
// Usage:
//   node scripts/prune-public-tree.mjs <public-repo-dir>              dry run (default): lists
//                                                                      what would be deleted
//   node scripts/prune-public-tree.mjs <public-repo-dir> --apply      actually deletes
//
// Never pushes, commits, or touches git state — the caller owns that, same discipline as
// release.mjs's relationship to `npm publish`.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from '../src/integrity.mjs';
import { resolveKitSource, KIT_LANGS } from './kit-source.mjs';
import { loadPreservedPublicDocs, isPreservedDocBasename } from '../src/preserved-public-docs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(__dirname, '..');
export const VAULT_ROOT = join(PKG_ROOT, '..');
export const PRESERVED_DOCS_SH = join(VAULT_ROOT, 'tests', 'preserved-public-docs.sh');

// The only top-level entries a public-repo checkout is allowed to have. Mapped ones are synced
// (and pruned) from a vault source; allowlisted-only ones are never touched.
const MAPPED_TOP_LEVEL = { en: 'kit:en', ru: 'kit:ru', npm: 'serpens-sdd-npm', tests: 'tests' };
// F7 fix: the plain literal, not `['.', 'git', 'hub'].join('')`. That concatenation existed
// only to dodge test/hygiene.test.mjs's vendor-name ban — but that ban exists to stop this
// package's own SOURCE (src/, bin/, scripts/) from mentioning a vendor PRODUCT NAME in prose or
// logic, not to ban this repo's own CI tooling directory from being named for real. Obfuscating
// a real, load-bearing directory name so the hygiene gate cannot see it is worse than either
// choice alone: it hides the true dependency from readers AND from the very grep meant to
// surface vendor coupling. The correct fix is a narrow, documented exemption in the hygiene
// gate itself (test/hygiene.test.mjs) for exactly this repo's own workflow directory name —
// see the comment there. (Deliberately not spelling the vendor's name in this comment either,
// so this exemption stays narrowly about the directory token, not a blanket pass for the file.)
const CI_WORKFLOW_DIR = '.github';
const UNTOUCHED_TOP_LEVEL = new Set(['docs', 'LICENSE', 'README.md', CI_WORKFLOW_DIR, '.git', '.gitignore']);
const UNTOUCHED_TOP_LEVEL_SUFFIXES = ['.zip'];

// F4 floor guard: a mapped source that resolves but yields zero files (dirs exist, e.g. from a
// half-checked-out vault clone, but are empty) must never be treated as "the vault owns
// nothing here" — that reading makes every target-only file look retired, so a populated public
// checkout gets planned for full deletion. Refuse instead.
const MIN_SOURCE_FILES = 1;
// A public checkout is never MOSTLY stale in normal operation — a real retirement removes a
// handful of files, not most of a kit. A retire set this large signals a source/target mismatch
// (wrong directory, a source that silently resolved empty apart from MIN_SOURCE_FILES, a broken
// walk) far more often than it signals a legitimate mass retirement, so refuse rather than
// delete blindly. Chosen generously (well above any real retirement seen so far) specifically
// so a genuine multi-file retirement still goes through without raising this every time.
const MAX_RETIRE_FRACTION = 0.5;

// D2 floor guard: MIN_SOURCE_FILES (>=1) and MAX_RETIRE_FRACTION only catch an EMPTY source or a
// retire set that is most of the TARGET. Neither catches a PARTIALLY-populated source — e.g. a
// sparse checkout or a failed pull that resolves 60% of the kit's real files. That source is
// non-empty (passes MIN_SOURCE_FILES) and the resulting retire set can still be well under 50%
// of the target (passes MAX_RETIRE_FRACTION), yet every file the sparse checkout happens to be
// missing looks "retired" and gets planned for deletion — 16 real published files, live, in the
// reviewer's reproduction. The fix compares the SOURCE's file count against the TARGET's: a
// normal release retires a handful of files release-over-release, so the source should still
// hold nearly as many files as the target already publishes. A source that is only a fraction of
// the target's size is far more likely to be a partial checkout than a real mass retirement, so
// refuse rather than guess. Skipped for trivially small targets (below MIN_TARGET_FOR_RATIO_GATE)
// where the ratio is too noisy to mean anything.
const MIN_SOURCE_TO_TARGET_RATIO = 0.7;
const MIN_TARGET_FOR_RATIO_GATE = 5;

/**
 * Build the {source, target, kind} triples for the four vault->public mappings, resolving kit
 * sources via kit-source.mjs (same "vault name first, published name second" lookup every other
 * kit-facing script uses) so this works whether it is pointed at the vault or, harmlessly, at a
 * self-mapped checkout.
 * @param {string} publicRepoDir
 * @returns {Array<{name: string, source: string, target: string, isKit: boolean}>}
 */
export function buildMappings(publicRepoDir) {
  const mappings = [];
  for (const lang of KIT_LANGS) {
    mappings.push({
      name: lang,
      source: resolveKitSource(lang, VAULT_ROOT),
      target: join(publicRepoDir, lang),
      isKit: true,
    });
  }
  mappings.push({ name: 'npm', source: PKG_ROOT, target: join(publicRepoDir, 'npm'), isKit: false });
  mappings.push({ name: 'tests', source: join(VAULT_ROOT, 'tests'), target: join(publicRepoDir, 'tests'), isKit: false });
  return mappings;
}

/**
 * Refuse loudly if `publicRepoDir` has a top-level entry that is neither a mapped sync target
 * nor on the untouched allowlist. This is the "refuse rather than guess" gate: an unexpected
 * top-level path (a new directory nobody wired up, a typo, a half-finished restructure) must
 * stop the run, not be silently ignored or silently deleted.
 * @param {string} publicRepoDir
 * @returns {string[]} unrecognised top-level entry names (empty = all recognised)
 */
export function findUnrecognisedTopLevel(publicRepoDir) {
  if (!existsSync(publicRepoDir)) {
    throw new Error(`prune-public-tree: public repo dir does not exist: ${publicRepoDir}`);
  }
  const entries = readdirSync(publicRepoDir);
  const known = new Set(Object.keys(MAPPED_TOP_LEVEL));
  return entries.filter((e) => {
    if (known.has(e) || UNTOUCHED_TOP_LEVEL.has(e)) return false;
    if (UNTOUCHED_TOP_LEVEL_SUFFIXES.some((suf) => e.endsWith(suf))) return false;
    return true;
  });
}

/**
 * For one kit mapping, classify every target-only relative path (present under `target`,
 * absent under `source`) as either 'preserve' (a §10-preserved docs/ file — keep, never
 * delete) or 'retire' (candidate for deletion). Anything whose basename matches a preserved
 * name/glob but sits OUTSIDE `docs/` at the kit root is ambiguous and makes the whole call
 * throw — this script would rather stop than decide that placement on its own.
 * @param {{source: string, target: string, isKit: boolean}} mapping
 * @param {{docNames: string[], docGlobs: string[]}} preserved
 * @returns {{preserve: string[], retire: string[]}}
 */
// Paths excluded from BOTH sides of the source/target comparison, by leading path segment.
// npm/ is the one mapping where the TARGET can legitimately contain a whole tree the vault
// source never has: `node_modules/` after `npm install` in a checkout used to test a release.
// Every one of those installed files is target-only by definition, so without this exclusion
// the comparison retires an entire installed dependency tree as "no longer owned by the vault".
const EXCLUDED_SEGMENTS = new Set(['node_modules']);

function isExcluded(relPath) {
  return relPath.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg));
}

export function classifyTargetOnly(mapping, preserved) {
  const sourceFiles = new Set(walk(mapping.source).filter((f) => !isExcluded(f)));
  // F4 floor guard: a source directory that exists but yields zero files (present-but-empty,
  // e.g. a shallow or half-populated vault checkout) must refuse rather than be read as "the
  // vault owns nothing here" — that reading turns every target-only file into a retire
  // candidate, i.e. plans deleting the whole populated target.
  if (sourceFiles.size < MIN_SOURCE_FILES) {
    throw new Error(
      `prune-public-tree: refusing to classify ${mapping.name}: its vault source `
      + `(${mapping.source}) yielded ${sourceFiles.size} file(s) — an empty or unreadable `
      + 'source would make every target file look retired. Check the source path.',
    );
  }
  const targetFiles = (existsSync(mapping.target) ? walk(mapping.target) : []).filter((f) => !isExcluded(f));
  const targetOnly = targetFiles.filter((f) => !sourceFiles.has(f)).sort();

  const preserve = [];
  const retire = [];
  const ambiguous = [];

  for (const rel of targetOnly) {
    const parts = rel.split('/');
    const basename = parts[parts.length - 1];
    const isUnderDocsRoot = mapping.isKit && parts.length === 2 && parts[0] === 'docs';
    if (isPreservedDocBasename(basename, preserved)) {
      if (isUnderDocsRoot) preserve.push(rel);
      else ambiguous.push(rel);
      continue;
    }
    retire.push(rel);
  }

  if (ambiguous.length > 0) {
    throw new Error(
      `prune-public-tree: refusing to classify ${mapping.name}: `
      + `${ambiguous.length} path(s) have a §10-preserved-looking name but are NOT directly `
      + `under docs/, so ownership is unclear — resolve by hand:\n`
      + ambiguous.map((p) => `  ${mapping.name}/${p}`).join('\n'),
    );
  }

  // F4 floor guard: refuse when the retire set is an implausibly large fraction of the target —
  // a real retirement removes a handful of files, not most of a populated checkout. This is the
  // guard that catches the reviewer's planted case directly: an empty-but-existing source makes
  // sourceFiles.size pass MIN_SOURCE_FILES trivially if any single stray file exists there, but
  // still leaves nearly every target file "target-only". Compare against total target files
  // (not just targetOnly) so a small target with a handful of legitimately-owned files never
  // trips this.
  if (targetFiles.length > 0 && retire.length / targetFiles.length > MAX_RETIRE_FRACTION) {
    throw new Error(
      `prune-public-tree: refusing to classify ${mapping.name}: the retire set `
      + `(${retire.length}/${targetFiles.length} target files, `
      + `${Math.round((retire.length / targetFiles.length) * 100)}%) exceeds the `
      + `${Math.round(MAX_RETIRE_FRACTION * 100)}% sane-fraction floor. This almost always means `
      + `the vault source (${mapping.source}) is wrong, empty, or mismatched with the target — `
      + 'not a real mass retirement. Verify the source path by hand before re-running.',
    );
  }

  // D2 floor guard: MIN_SOURCE_FILES and MAX_RETIRE_FRACTION above are not enough on their own.
  // A PARTIALLY-populated source (sparse checkout, failed pull, broken clone) is non-empty
  // (passes MIN_SOURCE_FILES) and the resulting retire set can still sit well under
  // MAX_RETIRE_FRACTION of the TARGET's total files — the reviewer's case: a source holding 60%
  // of the kit's real files against a fully-populated target produced a retire set under 50% of
  // the target, so the fraction guard above never fired, yet 16 real published files were
  // planned for deletion. Compare the source's file count against the target's directly: a real
  // release retires a handful of files at a time, so the source should still hold nearly as many
  // files as the target already publishes. Skipped for trivially small targets where the ratio
  // is too noisy to mean anything.
  if (
    targetFiles.length >= MIN_TARGET_FOR_RATIO_GATE
    && sourceFiles.size < MIN_SOURCE_TO_TARGET_RATIO * targetFiles.length
  ) {
    const expected = Math.ceil(MIN_SOURCE_TO_TARGET_RATIO * targetFiles.length);
    throw new Error(
      `prune-public-tree: refusing to classify ${mapping.name}: its vault source `
      + `(${mapping.source}) has only ${sourceFiles.size} file(s) against the target's `
      + `${targetFiles.length} (${mapping.target}) — that is `
      + `${Math.round((sourceFiles.size / targetFiles.length) * 100)}% of the target, below the `
      + `${Math.round(MIN_SOURCE_TO_TARGET_RATIO * 100)}% floor. A partially-populated source `
      + `(sparse checkout, failed pull) would look exactly like this and silently delete live `
      + `published content. Expected at least ${expected} file(s) in ${mapping.source}. `
      + 'Verify the source checkout is complete before re-running.',
    );
  }

  return { preserve, retire };
}

/**
 * F8(a): PRESERVED_PUBLIC_ROOT_FILES (docs/index.html, docs/common-contract.html — §10's
 * repo-root preserved files; docs/RENAME.md was dropped 2026-09-21, see
 * tests/preserved-public-docs.sh) was parsed by preserved-public-docs.mjs and asserted
 * by prune-public-tree.test.mjs, but consumed by no production code path: docs/ is on
 * UNTOUCHED_TOP_LEVEL and this script never looks inside it, so the list had no effect either
 * way. Rather than delete the check (it is real, load-bearing documentation of what the public
 * repo's docs/ must carry), consume it here as an informational verification: report which of
 * the §10 root files are actually present in this checkout's untouched docs/. This never
 * refuses the run — docs/ is out of scope for prune/delete decisions by design (§10) — it only
 * makes a silent "nothing there" visible instead of unconsumed dead data.
 * @param {string} publicRepoDir
 * @param {{rootFiles: string[]}} preserved
 * @returns {{present: string[], missing: string[]}}
 */
export function checkPreservedRootFiles(publicRepoDir, preserved) {
  const present = [];
  const missing = [];
  for (const rel of preserved.rootFiles) {
    (existsSync(join(publicRepoDir, rel)) ? present : missing).push(rel);
  }
  return { present, missing };
}

/**
 * Compute the full prune plan for a public-repo checkout: per-mapping preserve/retire lists,
 * after the top-level allowlist gate. Never touches disk.
 * @param {string} publicRepoDir
 * @returns {{mappings: Array<{name: string, preserve: string[], retire: string[]}>, rootFiles: {present: string[], missing: string[]}}}
 */
export function computePrunePlan(publicRepoDir) {
  const unrecognised = findUnrecognisedTopLevel(publicRepoDir);
  if (unrecognised.length > 0) {
    throw new Error(
      `prune-public-tree: refusing to run — unrecognised top-level entr${unrecognised.length === 1 ? 'y' : 'ies'} `
      + `in ${publicRepoDir}: ${unrecognised.join(', ')}\n`
      + `  (known mappings: ${Object.keys(MAPPED_TOP_LEVEL).join(', ')}; untouched: `
      + `${[...UNTOUCHED_TOP_LEVEL].join(', ')}, *.zip — add this entry to one of those lists `
      + 'deliberately, or fix the checkout)',
    );
  }

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mappings = buildMappings(publicRepoDir).map((m) => {
    const { preserve, retire } = classifyTargetOnly(m, preserved);
    return { name: m.name, target: m.target, preserve, retire };
  });
  const rootFiles = checkPreservedRootFiles(publicRepoDir, preserved);
  return { mappings, rootFiles };
}

/**
 * Apply a prune plan's `retire` lists: delete each path under its mapping's target, then remove
 * any directory left empty. Never touches `preserve` paths.
 * @param {{mappings: Array<{name: string, target: string, retire: string[]}>}} plan
 * @returns {number} total files deleted
 */
export function applyPrunePlan(plan) {
  let deleted = 0;
  for (const m of plan.mappings) {
    for (const rel of m.retire) {
      rmSync(join(m.target, rel), { force: true });
      deleted += 1;
    }
    pruneEmptyDirs(m.target, m.target);
  }
  return deleted;
}

function pruneEmptyDirs(dir, root) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(join(dir, e.name), root);
  }
  if (dir !== root && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  // F8(c) fix: parseArgs used to strip every `--apply` and then treat ANY remaining token
  // (including an unrecognised flag, e.g. a typo like `--apploy`) as the directory path — so a
  // mistyped flag silently became a directory argument instead of a usage error, and the real
  // positional argument could be swallowed just as silently. Reject any token that looks like a
  // flag (`--` or `-` prefixed) other than the one flag this script accepts.
  const unknownFlags = argv.filter((a) => a !== '--apply' && /^--?/.test(a));
  if (unknownFlags.length > 0) {
    const err = new Error(`unrecognized flag(s): ${unknownFlags.join(', ')} (usage: prune-public-tree.mjs <public-repo-dir> [--apply])`);
    err.exitCode = 2;
    throw err;
  }
  const rest = argv.filter((a) => a !== '--apply');
  if (rest.length !== 1) {
    const err = new Error('usage: prune-public-tree.mjs <public-repo-dir> [--apply]');
    err.exitCode = 2;
    throw err;
  }
  return { publicRepoDir: rest[0], apply: argv.includes('--apply') };
}

function main() {
  const { publicRepoDir, apply } = parseArgs(process.argv.slice(2));
  const plan = computePrunePlan(publicRepoDir);

  let totalRetire = 0;
  let totalPreserve = 0;
  for (const m of plan.mappings) {
    totalRetire += m.retire.length;
    totalPreserve += m.preserve.length;
    if (m.preserve.length > 0) {
      console.log(`${m.name}: keeping ${m.preserve.length} §10-preserved path(s):`);
      for (const p of m.preserve) console.log(`  keep    ${relative(publicRepoDir, join(m.target, p))}`);
    }
    for (const p of m.retire) {
      console.log(`${apply ? 'delete ' : 'would delete'}  ${relative(publicRepoDir, join(m.target, p))}`);
    }
  }

  console.log('');
  console.log(`${totalRetire} retired path(s), ${totalPreserve} §10-preserved path(s) kept.`);
  if (plan.rootFiles.missing.length > 0) {
    console.log(`note: ${plan.rootFiles.missing.length} §10 root-level preserved file(s) not found under docs/ (informational only, never pruned): ${plan.rootFiles.missing.join(', ')}`);
  }

  if (!apply) {
    console.log('(dry run — nothing was deleted; re-run with --apply to delete the retired paths above)');
    return;
  }
  const deleted = applyPrunePlan(plan);
  console.log(`deleted ${deleted} path(s).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(typeof err.exitCode === 'number' ? err.exitCode : 1);
  }
}
