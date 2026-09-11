// The tag -> artifact binding.
//
// A tag is the only thing that triggers a publish, and nothing else in the package tied the tag
// to the bytes it would ship: `package.json` has no publish hook, so a tag pushed against a tree
// whose edition was never bumped would publish an internally-consistent but STALE kit, and every
// test in the package would still pass. This check is what refuses that.
//
// It lives here, not only inside the workflow, so the refusal is provable off CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { checkPublishTag, normalizeTag } from '../scripts/check-publish-tag.mjs';
import { run } from '../src/run.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const SCRIPT = join(PKG_ROOT, 'scripts', 'check-publish-tag.mjs');

const GOOD = { version: '1.20260911.1', serpensSddEdition: '2026-09-11.1' };

test('a tag that matches version AND editionToSemver(edition) passes', () => {
  const r = checkPublishTag({ tag: '1.20260911.1', pkg: GOOD });
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.deepEqual(r.problems, []);
});

test('the conventional leading v is accepted and normalized', () => {
  assert.equal(normalizeTag('v1.20260911.1'), '1.20260911.1');
  assert.equal(normalizeTag('refs/tags/v1.20260911.1'), '1.20260911.1');
  assert.equal(checkPublishTag({ tag: 'v1.20260911.1', pkg: GOOD }).ok, true);
  assert.equal(checkPublishTag({ tag: 'refs/tags/v1.20260911.1', pkg: GOOD }).ok, true);
});

test('a tag disagreeing with package.json.version fails, printing BOTH values', () => {
  const r = checkPublishTag({ tag: '1.20260910.1', pkg: GOOD });
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /1\.20260910\.1/, 'the tag must appear in the failure');
  assert.match(text, /1\.20260911\.1/, 'the package version must appear in the failure');
});

test('a stale edition fails even when the tag matches package.json.version', () => {
  // The exact stale-kit shape: someone bumped `version` and forgot `serpensSddEdition`, so the
  // kits on disk are still the old edition. Tag == version is NOT enough.
  const r = checkPublishTag({ tag: '1.20260911.1', pkg: { version: '1.20260911.1', serpensSddEdition: '2026-09-10.1' } });
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /2026-09-10\.1/);
  assert.match(text, /1\.20260910\.1/, 'editionToSemver of the stale edition must be printed');
});

test('a malformed edition fails rather than throwing', () => {
  const r = checkPublishTag({ tag: '1.20260911.1', pkg: { version: '1.20260911.1', serpensSddEdition: 'latest' } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /latest/);
});

test('an empty or missing tag fails loudly, and says the job needs a TAG', () => {
  // Distinguished from "tag is not a version": a branch push reaching this job is a workflow
  // wiring bug, and the message has to say so rather than complaining about version syntax.
  for (const tag of ['', undefined, '   ', 'refs/tags/']) {
    const r = checkPublishTag({ tag, pkg: GOOD });
    assert.equal(r.ok, false, `tag ${JSON.stringify(tag)} must be refused`);
    assert.match(r.problems.join('\n'), /no release tag was supplied/,
      `tag ${JSON.stringify(tag)} must be refused as a MISSING tag, not as a bad version`);
  }
  // A branch ref is a different failure: something was supplied, it just is not a version.
  const branch = checkPublishTag({ tag: 'refs/heads/main', pkg: GOOD });
  assert.equal(branch.ok, false);
  assert.match(branch.problems.join('\n'), /does not name a version/);
});

test('the CLI exits 0 on the real package.json with its own version as the tag', async () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  const r = await run(process.execPath, [SCRIPT, `v${pkg.version}`], { cwd: PKG_ROOT });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(pkg.version.replace(/\./g, '\\.')));
});

test('the CLI exits non-zero and prints both values on a mismatched tag', async () => {
  const r = await run(process.execPath, [SCRIPT, 'v1.20250101.9'], { cwd: PKG_ROOT });
  assert.notEqual(r.code, 0, 'a mismatched tag must fail the job');
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /1\.20250101\.9/, 'the tag must be printed');
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.match(out, new RegExp(pkg.version.replace(/\./g, '\\.')), 'the package version must be printed');
});

test('the CLI refuses to run with no tag argument at all', async () => {
  const r = await run(process.execPath, [SCRIPT], { cwd: PKG_ROOT });
  assert.notEqual(r.code, 0);
});
