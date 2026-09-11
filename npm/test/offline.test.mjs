import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOfflineRoutes, callSiteRoots } from '../src/offline.mjs';
import { writeShim } from '../src/shim.mjs';

function store({ submodules = [] } = {}) {
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-offline-store-'));
  for (const name of submodules) mkdirSync(join(storeRoot, 'submodules', name), { recursive: true });
  return storeRoot;
}

test('callSiteRoots is the store plus every materialized submodule', () => {
  const storeRoot = store({ submodules: ['svc-b', 'svc-a'] });
  assert.deepEqual(callSiteRoots(storeRoot), [
    storeRoot,
    join(storeRoot, 'submodules', 'svc-a'),
    join(storeRoot, 'submodules', 'svc-b'),
  ]);
});

test('route 1 (the generated shim) satisfies --offline for every call site', () => {
  const storeRoot = store({ submodules: ['svc-a'] });
  writeShim(storeRoot, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });
  writeShim(join(storeRoot, 'submodules', 'svc-a'), { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });

  const r = assertOfflineRoutes({ roots: callSiteRoots(storeRoot) });
  assert.equal(r.ok, true, r.evidence.join('\n'));
  assert.deepEqual(r.missing, []);
  assert.equal(r.evidence.filter((e) => e.includes('route 1')).length, 2);
});

test('route 2 (node_modules/.bin) satisfies --offline where a repository has its own package.json', () => {
  const storeRoot = store();
  mkdirSync(join(storeRoot, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(storeRoot, 'node_modules', '.bin', 'serpens-sdd'), '#!/bin/sh\n', 'utf8');

  const r = assertOfflineRoutes({ roots: [storeRoot] });
  assert.equal(r.ok, true);
  assert.match(r.evidence[0], /route 2/);
});

test('a call site with neither route fails, names the repository, and does not count npx as a route', () => {
  const storeRoot = store({ submodules: ['svc-a'] });
  writeShim(storeRoot, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });
  // svc-a gets nothing: its generated lefthook.yml would fall through to `npx --no-install`.

  const r = assertOfflineRoutes({ roots: callSiteRoots(storeRoot) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [join(storeRoot, 'submodules', 'svc-a')]);
  const failure = r.evidence.find((e) => e.startsWith('✗'));
  assert.match(failure, /svc-a/);
  assert.match(failure, /npx --no-install/);
});

test('a shim that is present but not executable is not a route', () => {
  const storeRoot = store();
  const shim = writeShim(storeRoot, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });
  chmodSync(shim, 0o644);
  const r = assertOfflineRoutes({ roots: [storeRoot] });
  assert.equal(r.ok, false);
});

test('no call site at all is a failure, never a silent pass', () => {
  const r = assertOfflineRoutes({ roots: [] });
  assert.equal(r.ok, false);
});
