import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computePrunePlan,
  applyPrunePlan,
  findUnrecognisedTopLevel,
  buildMappings,
  classifyTargetOnly,
  checkPreservedRootFiles,
  parseArgs,
  PRESERVED_DOCS_SH,
  VAULT_ROOT,
} from '../scripts/prune-public-tree.mjs';
import { loadPreservedPublicDocs } from '../src/preserved-public-docs.mjs';

// Fixture builder: a minimal public-repo-shaped checkout plus a matching vault kit source, so
// every test controls both sides of the diff and does not depend on this repo's real content.
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'prune-public-tree-'));
  const vault = join(root, 'vault');
  const pub = join(root, 'public');
  for (const dir of [
    join(vault, 'serpens-sdd-starter', 'commands'),
    join(vault, 'serpens-sdd-starter', 'docs'),
    join(vault, 'serpens-sdd-npm'),
    join(vault, 'tests'),
    join(pub, 'en', 'commands'),
    join(pub, 'en', 'docs'),
    join(pub, 'ru', 'commands'),
    join(pub, 'ru', 'docs'),
    join(pub, 'npm'),
    join(pub, 'tests'),
    join(pub, 'docs'),
  ]) mkdirSync(dir, { recursive: true });

  // vault owns exactly these:
  writeFileSync(join(vault, 'serpens-sdd-starter', 'commands', 'do.md'), 'do\n');
  writeFileSync(join(vault, 'serpens-sdd-starter', 'docs', 'SETUP.md'), 'setup\n');
  writeFileSync(join(vault, 'serpens-sdd-npm', 'package.json'), '{}\n');
  writeFileSync(join(vault, 'tests', 'a-test.sh'), '#!/bin/sh\n');

  // ru kit source mirrors en's shape minimally (resolveKitSource needs the dir to exist)
  mkdirSync(join(vault, 'serpens-sdd-starter-ru', 'commands'), { recursive: true });
  mkdirSync(join(vault, 'serpens-sdd-starter-ru', 'docs'), { recursive: true });
  writeFileSync(join(vault, 'serpens-sdd-starter-ru', 'commands', 'do.md'), 'do\n');
  writeFileSync(join(vault, 'serpens-sdd-starter-ru', 'docs', 'SETUP.md'), 'setup\n');

  // public en/ has the same owned files, PLUS a retired leftover and a preserved doc
  writeFileSync(join(pub, 'en', 'commands', 'do.md'), 'do\n');
  writeFileSync(join(pub, 'en', 'docs', 'SETUP.md'), 'setup\n');
  writeFileSync(join(pub, 'en', 'commands', 'retired-command.md'), 'stale\n'); // RETIRE
  writeFileSync(join(pub, 'en', 'docs', 'FLOW.md'), 'archival flow doc\n'); // PRESERVE

  writeFileSync(join(pub, 'ru', 'commands', 'do.md'), 'do\n');
  writeFileSync(join(pub, 'ru', 'docs', 'SETUP.md'), 'setup\n');

  writeFileSync(join(pub, 'npm', 'package.json'), '{}\n');
  writeFileSync(join(pub, 'tests', 'a-test.sh'), '#!/bin/sh\n');

  return { root, vault, pub };
}

test('preserved-public-docs.sh parses to the eight §10 docs plus three root files', () => {
  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  assert.deepEqual(preserved.docNames.sort(), ['FLOW-SCHEMA.md', 'FLOW-TABLE.md', 'FLOW.md']);
  assert.ok(preserved.docGlobs.includes('MIGRATION-*-to-current.md'));
  assert.deepEqual(
    preserved.rootFiles.sort(),
    ['docs/RENAME.md', 'docs/common-contract.html', 'docs/index.html'],
  );
});

test('a retired file (not in vault, not preserved) is planned for deletion', (t) => {
  const { root, vault, pub } = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source: join(vault, 'serpens-sdd-starter'), target: join(pub, 'en'), isKit: true };
  const { preserve, retire } = classifyTargetOnly(mapping, preserved);

  assert.ok(retire.includes('commands/retired-command.md'), `expected retired-command.md in retire list: ${retire}`);
  assert.ok(preserve.includes('docs/FLOW.md'), `expected docs/FLOW.md in preserve list: ${preserve}`);
});

test('a §10-preserved file is never deleted, even in --apply mode', (t) => {
  const { root, vault, pub } = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  process.env.VAULT_ROOT_OVERRIDE_UNUSED = '1'; // no-op, documents this test does not stub VAULT_ROOT
  const mappings = buildMappings(pub).map((m) => (
    m.name === 'en' ? { ...m, source: join(vault, 'serpens-sdd-starter') }
      : m.name === 'ru' ? { ...m, source: join(vault, 'serpens-sdd-starter-ru') }
        : m.name === 'npm' ? { ...m, source: join(vault, 'serpens-sdd-npm') }
          : { ...m, source: join(vault, 'tests') }
  ));
  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const planMappings = mappings.map((m) => {
    const { preserve, retire } = classifyTargetOnly(m, preserved);
    return { name: m.name, target: m.target, preserve, retire };
  });
  applyPrunePlan({ mappings: planMappings });

  assert.ok(existsSync(join(pub, 'en', 'docs', 'FLOW.md')), 'FLOW.md must survive apply');
  assert.ok(!existsSync(join(pub, 'en', 'commands', 'retired-command.md')), 'retired file must be gone');
});

test('a preserved-looking name OUTSIDE docs/ is ambiguous and throws rather than guesses', (t) => {
  const { root, vault, pub } = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(pub, 'en', 'FLOW.md'), 'misplaced\n'); // ambiguous: preserved name, wrong location
  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source: join(vault, 'serpens-sdd-starter'), target: join(pub, 'en'), isKit: true };

  assert.throws(() => classifyTargetOnly(mapping, preserved), /ownership is unclear/);
});

test('an unrecognised top-level entry in the public repo dir makes the whole run refuse', (t) => {
  const { root, pub } = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(pub, 'mystery-dir'));
  const unrecognised = findUnrecognisedTopLevel(pub);
  assert.deepEqual(unrecognised, ['mystery-dir']);
  assert.throws(() => computePrunePlan(pub), /unrecognised top-level/);
});

test('dry run (no --apply) never deletes anything', (t) => {
  const { root, vault, pub } = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(vault, 'serpens-sdd-starter-ru'), { recursive: true });

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source: join(vault, 'serpens-sdd-starter'), target: join(pub, 'en'), isKit: true };
  classifyTargetOnly(mapping, preserved); // computing the plan alone must not touch disk
  assert.ok(existsSync(join(pub, 'en', 'commands', 'retired-command.md')));
});

// F4 regressions ---------------------------------------------------------------------------

test('F4: a source dir that EXISTS but is EMPTY refuses instead of planning a full-target delete', (t) => {
  // Reviewer's confirmed case: dirs exist but yield zero files (e.g. a shallow/half-populated
  // vault checkout). Before the fix, classifyTargetOnly read "vault owns nothing here" and
  // planned deletion of every one of the target's 101 files with exit 0.
  const root = mkdtempSync(join(tmpdir(), 'prune-empty-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const emptySource = join(root, 'empty-vault-source');
  mkdirSync(emptySource, { recursive: true }); // exists, but has no files at all

  const populatedTarget = join(root, 'target');
  for (let i = 0; i < 20; i += 1) {
    mkdirSync(join(populatedTarget, 'commands'), { recursive: true });
    writeFileSync(join(populatedTarget, 'commands', `file-${i}.md`), `content ${i}\n`);
  }

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source: emptySource, target: populatedTarget, isKit: true };

  assert.throws(
    () => classifyTargetOnly(mapping, preserved),
    /yielded 0 file/,
    'an empty vault source must refuse loudly, not plan deleting the whole populated target',
  );
  // Confirm nothing was touched.
  assert.equal(readdirSync(join(populatedTarget, 'commands')).length, 20);
});

test('F4: a retire set exceeding the sane-fraction floor refuses even with a non-empty source', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prune-retire-fraction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'kept.md'), 'kept\n'); // exactly one file the vault owns

  const target = join(root, 'target');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'kept.md'), 'kept\n');
  for (let i = 0; i < 19; i += 1) {
    writeFileSync(join(target, `stale-${i}.md`), `stale ${i}\n`); // 19/20 target-only = 95%
  }

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source, target, isKit: false };

  assert.throws(
    () => classifyTargetOnly(mapping, preserved),
    /sane-fraction floor/,
    'a retire set this large a fraction of the target must refuse, not delete blindly',
  );
});

// D2 regression -----------------------------------------------------------------------------

test('D2: a partially-populated source (60% of the target file count) refuses instead of '
  + 'planning a partial-content deletion', (t) => {
  // Reviewer's confirmed case: a source holding 60% of the kit's real files against a fully
  // populated target. MIN_SOURCE_FILES passes trivially (source is non-empty) and the retire
  // set (the 40% the source is missing) sits under MAX_RETIRE_FRACTION of the target's total, so
  // neither prior guard fires — before this fix, that planned 16 real published files (e.g.
  // slides/src/content/talk5.json) for deletion.
  const root = mkdtempSync(join(tmpdir(), 'prune-partial-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });

  // Target: 20 real published files. Source: only 12 of them (60%) — a sparse/failed checkout.
  const TOTAL = 20;
  const SOURCE_COUNT = 12; // 60%
  for (let i = 0; i < TOTAL; i += 1) {
    writeFileSync(join(target, `file-${i}.md`), `content ${i}\n`);
    if (i < SOURCE_COUNT) writeFileSync(join(source, `file-${i}.md`), `content ${i}\n`);
  }

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source, target, isKit: false };

  assert.throws(
    () => classifyTargetOnly(mapping, preserved),
    /below the 70% floor/,
    'a source holding only 60% of the target file count must refuse, not plan deleting the '
    + 'files it happens to be missing',
  );
  // Confirm nothing was touched.
  assert.equal(readdirSync(target).length, TOTAL);
});

test('D2: a source close to the target file count (real small retirement) does NOT trip the '
  + 'ratio guard', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prune-real-retirement-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });

  // Target has 20 files; source has 19 of them (95%) — one legitimately retired file.
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(join(target, `file-${i}.md`), `content ${i}\n`);
    if (i < 19) writeFileSync(join(source, `file-${i}.md`), `content ${i}\n`);
  }

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'en', source, target, isKit: false };

  const { retire } = classifyTargetOnly(mapping, preserved);
  assert.deepEqual(retire, ['file-19.md']);
});

test('F4: node_modules is excluded from the npm mapping comparison (installed deps never retire)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'prune-node-modules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const source = join(root, 'npm-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), '{}\n');

  const target = join(root, 'npm-target');
  mkdirSync(join(target, 'node_modules', 'some-dep'), { recursive: true });
  writeFileSync(join(target, 'package.json'), '{}\n');
  writeFileSync(join(target, 'node_modules', 'some-dep', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(target, 'node_modules', '.package-lock.json'), '{}\n');

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const mapping = { name: 'npm', source, target, isKit: false };

  const { retire } = classifyTargetOnly(mapping, preserved);
  assert.deepEqual(retire, [], `installed node_modules files must never be planned for deletion, got: ${retire}`);
});

// F8(c) regression --------------------------------------------------------------------------

// F8(a) regression --------------------------------------------------------------------------

test('F8(a): PRESERVED_PUBLIC_ROOT_FILES is now consumed — computePrunePlan reports which §10 root files are present', (t) => {
  const { root, vault, pub } = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(vault, 'serpens-sdd-starter-ru'), { recursive: true });

  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);

  // Fixture's pub/docs/ is empty, so every §10 root file should be reported missing.
  const { present: presentEmpty, missing: missingEmpty } = checkPreservedRootFiles(pub, preserved);
  assert.deepEqual(presentEmpty, []);
  assert.deepEqual(missingEmpty.sort(), preserved.rootFiles.slice().sort());

  // Create one of them; it must now be reported present, the other two still missing.
  writeFileSync(join(pub, 'docs', 'RENAME.md'), 'renamed\n');
  const { present, missing } = checkPreservedRootFiles(pub, preserved);
  assert.deepEqual(present, ['docs/RENAME.md']);
  assert.deepEqual(missing.sort(), preserved.rootFiles.filter((f) => f !== 'docs/RENAME.md').sort());
});

test('F8(a): computePrunePlan wires rootFiles through its return value', (t) => {
  // computePrunePlan resolves its npm/tests mappings against the REAL vault (module-level
  // VAULT_ROOT), not a fixture, so this uses the real repo's own tests/ and serpens-sdd-npm/ as
  // both source and target sides (target == source's own directory structure minus any files
  // truly retired) — the same real-repo dry run VERIFY FOR REAL exercises directly. Only
  // asserts the rootFiles field is threaded through; not a claim about retire/preserve here.
  const preserved = loadPreservedPublicDocs(PRESERVED_DOCS_SH);
  const rootFiles = checkPreservedRootFiles(VAULT_ROOT, preserved);
  assert.ok(Array.isArray(rootFiles.present) && Array.isArray(rootFiles.missing));
});

test('F8(c): an unknown flag is rejected instead of silently becoming the directory argument', () => {
  assert.throws(
    () => parseArgs(['--apploy', '/some/public/repo']),
    (err) => {
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--apploy/);
      return true;
    },
  );
  // The legitimate flag still works, alone or combined with the positional argument.
  assert.deepEqual(parseArgs(['/some/public/repo', '--apply']), { publicRepoDir: '/some/public/repo', apply: true });
  assert.deepEqual(parseArgs(['/some/public/repo']), { publicRepoDir: '/some/public/repo', apply: false });
});
