// The kit-source resolver's own gate.
//
// The two starter kit trees live beside the package. In this vault they are named
// `serpens-sdd-starter` and `serpens-sdd-starter-ru`; in the public repository the SAME trees
// are published as `en/` and `ru/`, and those names cannot change without breaking published
// links and the release zips. Every place that resolved a kit tree hard-coded the vault's
// spelling, so the suite could only run in one of the two layouts.
//
// One resolver now answers for both, and it FAILS LOUDLY naming every candidate it tried when
// none exists — the failure mode that matters, because the silent alternative is a check that
// quietly scans nothing and reports green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KIT_SOURCE_CANDIDATES,
  resolveKitSource,
  resolveKitSources,
  VAULT_ROOT,
} from '../scripts/kit-source.mjs';
import { resolvePublishWorkflow } from './helpers/workflow-path.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

/** Build a throwaway root containing the given sibling directory names. */
function layout(...names) {
  const root = mkdtempSync(join(tmpdir(), 'serpens-kit-source-'));
  for (const n of names) {
    mkdirSync(join(root, n), { recursive: true });
    writeFileSync(join(root, n, 'VERSION'), '2026-09-11.1\n');
  }
  return root;
}

test('resolves the vault layout (serpens-sdd-starter / serpens-sdd-starter-ru)', () => {
  const root = layout('serpens-sdd-starter', 'serpens-sdd-starter-ru');
  assert.equal(resolveKitSource('en', root), join(root, 'serpens-sdd-starter'));
  assert.equal(resolveKitSource('ru', root), join(root, 'serpens-sdd-starter-ru'));
});

test('resolves the public-repository layout (en / ru)', () => {
  const root = layout('en', 'ru');
  assert.equal(resolveKitSource('en', root), join(root, 'en'));
  assert.equal(resolveKitSource('ru', root), join(root, 'ru'));
});

test('the vault spelling wins when BOTH layouts are present', () => {
  // Not a hypothetical: a working copy of the public repo checked out inside the vault tree
  // would have both. The first candidate is the authoritative source of truth, so order is
  // part of the contract, not an accident of the loop.
  const root = layout('serpens-sdd-starter', 'serpens-sdd-starter-ru', 'en', 'ru');
  assert.equal(resolveKitSource('en', root), join(root, 'serpens-sdd-starter'));
  assert.equal(resolveKitSource('ru', root), join(root, 'serpens-sdd-starter-ru'));
});

test('throws naming EVERY candidate path when no kit tree exists', () => {
  const root = layout(); // empty
  for (const lang of ['en', 'ru']) {
    assert.throws(
      () => resolveKitSource(lang, root),
      (err) => {
        for (const candidate of KIT_SOURCE_CANDIDATES[lang]) {
          assert.ok(
            err.message.includes(join(root, candidate)),
            `the failure must name the candidate ${join(root, candidate)}; got: ${err.message}`,
          );
        }
        return true;
      },
    );
  }
});

test('a half-present layout still fails loudly rather than resolving one kit', () => {
  const root = layout('serpens-sdd-starter'); // en only
  assert.equal(resolveKitSource('en', root), join(root, 'serpens-sdd-starter'));
  assert.throws(() => resolveKitSource('ru', root), /serpens-sdd-starter-ru/);
  assert.throws(() => resolveKitSources(root), /serpens-sdd-starter-ru/);
});

test('an unknown language is a programming error, not a missing directory', () => {
  assert.throws(() => resolveKitSource('de', layout('en', 'ru')), /unknown kit language "de"/);
});

test('resolveKitSources returns both kits, en first, with their language names', () => {
  const root = layout('en', 'ru');
  assert.deepEqual(resolveKitSources(root), [
    { name: 'en', dir: join(root, 'en') },
    { name: 'ru', dir: join(root, 'ru') },
  ]);
});

test('the default root is the package\'s own parent, and it resolves here', () => {
  assert.equal(VAULT_ROOT, join(PKG_ROOT, '..'));
  const kits = resolveKitSources();
  assert.equal(kits.length, 2);
  for (const kit of kits) {
    assert.ok(kit.dir.length > 0, `${kit.name} must resolve in this checkout`);
  }
});

// --- the publish workflow's location moves the same way, for the same reason ---

test('finds the workflow INSIDE the package (this vault\'s layout)', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-wf-'));
  const pkg = join(root, 'serpens-sdd-npm');
  mkdirSync(join(pkg, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(pkg, '.github', 'workflows', 'publish.yml'), 'name: publish\n');
  assert.equal(resolvePublishWorkflow(pkg), join(pkg, '.github', 'workflows', 'publish.yml'));
});

test('finds the workflow at the REPOSITORY root (the published layout)', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-wf-'));
  const pkg = join(root, 'npm');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'publish.yml'), 'name: publish\n');
  assert.equal(resolvePublishWorkflow(pkg), join(pkg, '..', '.github', 'workflows', 'publish.yml'));
});

test('throws naming BOTH workflow locations when there is no workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-wf-'));
  const pkg = join(root, 'npm');
  mkdirSync(pkg, { recursive: true });
  assert.throws(
    () => resolvePublishWorkflow(pkg),
    (err) => {
      assert.ok(err.message.includes(join(pkg, '.github', 'workflows', 'publish.yml')), err.message);
      assert.ok(err.message.includes(join(pkg, '..', '.github', 'workflows', 'publish.yml')), err.message);
      return true;
    },
  );
});
