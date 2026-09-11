#!/usr/bin/env node
// check-publish-tag.mjs — bind the release tag to the artifact it will publish.
//
// A publish is triggered by a tag and nothing else. Nothing in the package tied that tag to the
// bytes it ships: `package.json` carries no publish hook, so a tag pushed against a tree whose
// edition was never bumped publishes a STALE kit while every test in the package still passes,
// because a stale kit is internally consistent. This check refuses that.
//
// It asserts BOTH halves, because either alone can pass while the artifact is wrong:
//   tag == package.json.version                        (the version npm will register)
//   tag == editionToSemver(package.json.serpensSddEdition)  (the edition the kits are stamped as)
//
// Exported as a function so the refusal is provable off CI; usable as a CLI so the release job
// is one line:
//
//   node scripts/check-publish-tag.mjs "$TAG"     exit 0 = safe to publish, non-zero = refuse
//
// It reads only `package.json`. It never publishes, tags, or touches the network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editionToSemver } from '../src/version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

/**
 * Reduce a tag reference to the bare version it claims. Accepts the full ref a CI runner hands
 * over (`refs/tags/v1.20260911.1`), the bare tag (`v1.20260911.1`) and the version itself; the
 * leading `v` is the universal tag convention and stripping it is not a loosening of the check
 * — everything AFTER it must still match exactly.
 * @param {string|undefined} tag
 * @returns {string} the normalized version string ('' when there is nothing usable)
 */
export function normalizeTag(tag) {
  if (typeof tag !== 'string') return '';
  let t = tag.trim();
  if (t.startsWith('refs/tags/')) t = t.slice('refs/tags/'.length);
  if (/^v\d/.test(t)) t = t.slice(1);
  return t;
}

/**
 * Decide whether `tag` may publish `pkg`.
 * Never throws — a malformed edition is a reported problem, not a stack trace in a release log.
 * @param {{tag: string|undefined, pkg: {version?: string, serpensSddEdition?: string}}} input
 * @returns {{ok: boolean, tag: string, problems: string[]}}
 */
export function checkPublishTag({ tag, pkg }) {
  const problems = [];
  const normalized = normalizeTag(tag);

  if (normalized === '') {
    problems.push(`no release tag was supplied (got ${JSON.stringify(tag ?? null)}) — this job may only run for a pushed tag`);
    return { ok: false, tag: normalized, problems };
  }
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    problems.push(`tag "${tag}" does not name a version (normalized to "${normalized}", expected 1.YYYYMMDD.N)`);
    return { ok: false, tag: normalized, problems };
  }

  if (normalized !== pkg.version) {
    problems.push(`tag (${normalized}) != package.json.version (${pkg.version})`);
  }

  let editionVersion;
  try {
    editionVersion = editionToSemver(pkg.serpensSddEdition);
  } catch (err) {
    problems.push(`package.json.serpensSddEdition ("${pkg.serpensSddEdition}") is not a well-formed edition: ${err.message}`);
    return { ok: false, tag: normalized, problems };
  }
  if (normalized !== editionVersion) {
    problems.push(
      `tag (${normalized}) != editionToSemver(package.json.serpensSddEdition) `
      + `(${pkg.serpensSddEdition} -> ${editionVersion}) — the kits on disk are stamped as `
      + `${pkg.serpensSddEdition}, so this tag would publish a stale kit`,
    );
  }

  return { ok: problems.length === 0, tag: normalized, problems };
}

function main() {
  const tag = process.argv[2];
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  const result = checkPublishTag({ tag, pkg });
  if (!result.ok) {
    console.error('REFUSING TO PUBLISH — the tag does not match the artifact:');
    for (const p of result.problems) console.error(`  ${p}`);
    console.error(`\n  tag:                       ${tag ?? '(none)'}`);
    console.error(`  package.json.version:      ${pkg.version}`);
    console.error(`  package.json.serpensSddEdition: ${pkg.serpensSddEdition}`);
    process.exit(1);
  }
  console.log(`tag ${result.tag} matches package.json.version (${pkg.version}) and edition ${pkg.serpensSddEdition} — safe to publish`);
}

// Importing this file (from a test) must never exit the process.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
