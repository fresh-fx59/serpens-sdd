import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { stage1 } from '../src/stages/stage1-inventory.mjs';
import { makeStoreWithSubmodules } from './helpers/fixture.mjs';

test('.gitmodules wins when the store already has submodules', async () => {
  const { storeRoot } = makeStoreWithSubmodules([
    { name: 'service-a', url: 'ssh://git@forge/acme/service-a.git', base_branch: 'develop' },
  ]);
  const config = { project: 'acme', repositories: [], facts: {} };
  const ctx = { config, run, storeRoot };
  const result = await stage1(ctx);
  assert.equal(result.ok, true);
  // Stage 1 no longer writes project-repositories.json — it hands the resolved rows to the
  // caller on ctx.repositoryRows, which stage 4/stage 9 feed to sync-submodules on stdin.
  assert.equal(existsSync(join(storeRoot, 'project-repositories.json')), false);
  assert.equal(ctx.repositoryRows.length, 1);
  assert.equal(ctx.repositoryRows[0].name, 'service-a');
});

test('config.repositories is used when the store has no submodules', async () => {
  const { storeRoot } = makeStoreWithSubmodules([]);
  const config = {
    project: 'acme',
    repositories: [{ name: 'service-b', url: 'ssh://git@forge/acme/service-b.git', base_branch: 'develop' }],
    facts: { repository_source: 'manual' },
  };
  const ctx = { config, run, storeRoot };
  const result = await stage1(ctx);
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(storeRoot, 'project-repositories.json')), false);
  assert.equal(ctx.repositoryRows.length, 1);
  assert.equal(ctx.repositoryRows[0].name, 'service-b');
});

test('the empty-config.repositories-with-existing-submodules case resolves rows from .gitmodules, not an empty list', async () => {
  // stage1-inventory.mjs:33's `if (configRows.length)` guard exists precisely so this case
  // (a store that already has submodules, and a config whose repositories[] is empty) is
  // legitimate — the resolved rows must be the .gitmodules ones, never zero rows.
  const { storeRoot } = makeStoreWithSubmodules([
    { name: 'service-a', url: 'ssh://git@forge/acme/service-a.git', base_branch: 'develop' },
    { name: 'service-c', url: 'ssh://git@forge/acme/service-c.git', base_branch: 'main' },
  ]);
  const config = { project: 'acme', repositories: [], facts: {} };
  const ctx = { config, run, storeRoot };
  const result = await stage1(ctx);
  assert.equal(result.ok, true);
  assert.equal(ctx.repositoryRows.length, 2);
  assert.deepEqual(ctx.repositoryRows.map((r) => r.name).sort(), ['service-a', 'service-c']);
});

test('a disagreement between .gitmodules and config.repositories stops before any write', async () => {
  const { storeRoot } = makeStoreWithSubmodules([
    { name: 'service-a', url: 'ssh://git@forge/acme/service-a.git', base_branch: 'develop' },
  ]);
  const config = {
    project: 'acme',
    repositories: [{ name: 'service-a', url: 'ssh://git@forge/OTHER/service-a.git', base_branch: 'develop' }],
    facts: {},
  };
  const result = await stage1({ config, run, storeRoot });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /disagree/);
  assert.equal(existsSync(join(storeRoot, 'project-repositories.json')), false);
});

test('--dry-run writes nothing', async () => {
  const { storeRoot } = makeStoreWithSubmodules([]);
  const config = { project: 'acme', repositories: [{ name: 'service-b', url: 'ssh://x', base_branch: 'develop' }], facts: {} };
  const result = await stage1({ config, run, storeRoot, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(storeRoot, 'project-repositories.json')), false);
});

test('a pre-existing project-repositories.json is left untouched, not deleted', async () => {
  const { storeRoot } = makeStoreWithSubmodules([]);
  const stalePath = join(storeRoot, 'project-repositories.json');
  const staleContent = '{"schema_version":1,"project":"someone-elses","repositories":[]}\n';
  writeFileSync(stalePath, staleContent, 'utf8');
  const config = { project: 'acme', repositories: [{ name: 'service-b', url: 'ssh://x', base_branch: 'develop' }], facts: {} };
  const result = await stage1({ config, run, storeRoot });
  assert.equal(result.ok, true);
  assert.equal(existsSync(stalePath), true);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(stalePath, 'utf8'), staleContent);
});
