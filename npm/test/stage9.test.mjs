import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { stage4 } from '../src/stages/stage4-submodules.mjs';
import { stage9 } from '../src/stages/stage9-accept.mjs';

const BASE = 'develop';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeStore() {
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage9-store-'));
  git(storeRoot, ['init', '-q', '-b', BASE, storeRoot]);
  git(storeRoot, ['config', 'user.email', 'fixture@example.com']);
  git(storeRoot, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(storeRoot, 'README.md'), '# store\n');
  git(storeRoot, ['add', '-A']);
  git(storeRoot, ['commit', '-q', '-m', 'initial commit']);
  return storeRoot;
}

test('stage9 re-run is idempotent WITHOUT project-repositories.json ever existing '
  + '(spec-drop-inventory-file-2026-09-11.md §6 amended acceptance)', async () => {
  const storeRoot = makeStore();
  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage9-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage9-work-'));
  git(workDir, ['init', '-q', '-b', BASE, workDir]);
  git(workDir, ['config', 'user.email', 'fixture@example.com']);
  git(workDir, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(workDir, 'README.md'), '# service-a\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);

  const runFile = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
  const repositoryRows = [{ name: 'service-a', url: bareDir, base_branch: BASE }];

  // Stage 4 first (real init order): materializes the submodule and commits the registration.
  const stage4Result = await stage4({ run: runFile, storeRoot, config: {}, repositoryRows });
  assert.equal(stage4Result.ok, true, stage4Result.error);

  // Never written, by design (stage1 stops writing it, and nothing else ever creates it).
  assert.equal(existsSync(join(storeRoot, 'project-repositories.json')), false);

  // Stage 9's own re-run must be a genuine no-op: it feeds the SAME resolved rows again.
  const stage9Result = await stage9({ run: runFile, storeRoot, config: {}, port: { id: 'claude' }, repositoryRows });
  assert.equal(stage9Result.ok, true, stage9Result.error);
  assert.ok(stage9Result.evidence.some((e) => e.includes('--repos-from -')));

  const status = await run('git', ['-C', storeRoot, 'status', '--short']);
  assert.equal(status.stdout.trim(), '', 're-syncing identical rows must leave the store worktree clean');
});

test('--dry-run does not execute anything', async () => {
  let calls = 0;
  const ctx = {
    run: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    storeRoot: '/nonexistent',
    dryRun: true,
  };
  const result = await stage9(ctx);
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});
