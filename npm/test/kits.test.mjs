import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyManifest, kitPath, kitFileList } from '../src/integrity.mjs';
import { editionToSemver } from '../src/version.mjs';

test('both kits verify against their own MANIFEST.sha256', () => {
  for (const lang of ['en', 'ru']) {
    const r = verifyManifest(kitPath(lang));
    assert.deepEqual(r.mismatches, []);
    assert.equal(r.ok, true);
  }
});

test('en and ru ship identical path sets', () => {
  assert.deepEqual(kitFileList('en'), kitFileList('ru'));
});

test('package version, serpensSddEdition and both VERSION files agree', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.version, editionToSemver(pkg.serpensSddEdition));
  for (const lang of ['en', 'ru']) {
    assert.equal(readFileSync(`${kitPath(lang)}/VERSION`, 'utf8').trim(), pkg.serpensSddEdition);
  }
});

// The edition a kit's own prose CLAIMS must be the edition it IS. `docs/SETUP.md` tells the
// installing agent which edition `serpens-sdd version` should print, and that line went stale
// the moment the edition was bumped from 2026-09-09.1 to 2026-09-10.1 — a documented gate that
// fails for a human reading it, in the one file the whole install is driven from. Nothing was
// checking it, so nothing caught it. This does.
test('every kit doc that names the CURRENT edition names the one in VERSION', () => {
  for (const lang of ['en', 'ru']) {
    const root = kitPath(lang);
    const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    const setup = readFileSync(join(root, 'docs', 'SETUP.md'), 'utf8');
    const claimed = [...setup.matchAll(/`(\d{4}-\d{2}-\d{2}\.\d+)`/g)].map((m) => m[1]);
    assert.ok(claimed.length > 0, `${lang}/docs/SETUP.md names no edition at all`);
    for (const edition of claimed) {
      assert.equal(edition, version,
        `${lang}/docs/SETUP.md tells the installing agent to expect edition ${edition}, but this kit is ${version}`);
    }
  }
});
