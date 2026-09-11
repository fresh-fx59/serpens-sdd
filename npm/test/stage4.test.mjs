import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { stage1 } from '../src/stages/stage1-inventory.mjs';
import { stage4 } from '../src/stages/stage4-submodules.mjs';

const BASE = 'develop';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeStore() {
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-store-'));
  git(storeRoot, ['init', '-q', '-b', BASE, storeRoot]);
  git(storeRoot, ['config', 'user.email', 'fixture@example.com']);
  git(storeRoot, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(storeRoot, 'README.md'), '# store\n');
  git(storeRoot, ['add', '-A']);
  git(storeRoot, ['commit', '-q', '-m', 'initial commit']);
  return storeRoot;
}

test('stage4 syncs submodules from ctx.repositoryRows (stdin) and records submodule status + .gitmodules diff', async () => {
  const storeRoot = makeStore();
  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-work-'));
  git(workDir, ['init', '-q', '-b', BASE, workDir]);
  git(workDir, ['config', 'user.email', 'fixture@example.com']);
  git(workDir, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(workDir, 'README.md'), '# service-a\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);

  const ctx = {
    run: (cmd, args, opts = {}) => run(cmd, args, { ...opts, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } }),
    storeRoot,
    repositoryRows: [{ name: 'service-a', url: bareDir, base_branch: BASE }],
  };
  const result = await stage4(ctx);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.evidence.some((e) => e.startsWith('$ bash') || e.includes('sync-submodules.sh')));
  assert.ok(result.evidence.some((e) => e.includes('--repos-from -')), 'expected --repos-from - in the evidence, not --inventory');
  assert.ok(result.evidence.some((e) => e.includes('submodule status')));
  assert.ok(result.evidence.some((e) => /git -C .* submodule status → exit 0/.test(e)));
});

test('the empty-config.repositories-with-existing-submodules case: stage4 syncs the .gitmodules rows stage1 resolved, and the checkout is REALLY materialized', async () => {
  // spec-drop-inventory-file-2026-09-11.md §6's central fix: an empty ctx.repositoryRows would
  // silently reconcile ZERO submodules, wiping out an existing registration. Stage 1 must have
  // already resolved the real rows (from .gitmodules) before stage4 runs; this test proves
  // stage4 actually uses them via --repos-from -, not a stale/absent inventory file — and it
  // proves the checkout is REAL (HEAD sha + a file that only exists inside the checkout), not
  // just `.gitmodules` metadata, which `git submodule add` writes even when the checkout itself
  // never lands (the exact gap a mutated sync-submodules.sh could hide behind — see the
  // `if ! true; then` regression test below).
  const storeRoot = makeStore();
  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-remote-empty-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-work-empty-'));
  git(workDir, ['init', '-q', '-b', BASE, workDir]);
  git(workDir, ['config', 'user.email', 'fixture@example.com']);
  git(workDir, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(workDir, 'README.md'), '# service-a\n');
  writeFileSync(join(workDir, 'only-in-checkout.txt'), 'proof of real checkout\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);
  const expectedHead = git(bareDir, ['rev-parse', BASE]).trim();

  const testRun = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });

  // Register the submodule for real (via a first stage4 pass), so the store ends up in the
  // exact "existing but not yet deinitialized" state the second pass below will disturb.
  const firstPass = await stage4({
    run: testRun,
    storeRoot,
    config: { repositories: [{ name: 'service-a', url: bareDir, base_branch: BASE }] },
  });
  assert.equal(firstPass.ok, true, firstPass.error);
  assert.equal(readFileSync(join(storeRoot, 'submodules', 'service-a', 'only-in-checkout.txt'), 'utf8'), 'proof of real checkout\n');

  // Deinitialize it — .gitmodules and the gitlink survive, but the checkout is emptied. This is
  // exactly the state a partial `--only 4` rerun (defect 1) hits after `git submodule deinit`.
  git(storeRoot, ['submodule', 'deinit', '-f', 'submodules/service-a']);
  assert.equal(existsSync(join(storeRoot, 'submodules', 'service-a', 'only-in-checkout.txt')), false,
    'sanity check: deinit must have actually emptied the checkout');

  // Exercise the REAL stage-1 resolution (from .gitmodules) instead of hand-injecting
  // repositoryRows — config.repositories is deliberately empty here, so a bug that fell back
  // to the raw config instead of stage1's resolved rows would resolve zero rows.
  const stage1Ctx = { run: testRun, storeRoot, config: { repositories: [] } };
  const stage1Result = await stage1(stage1Ctx);
  assert.equal(stage1Result.ok, true, stage1Result.error);
  assert.equal(stage1Ctx.repositoryRows.length, 1);
  assert.equal(stage1Ctx.repositoryRows[0].name, 'service-a');

  const ctx = {
    run: testRun,
    storeRoot,
    config: { repositories: [] },
    repositoryRows: stage1Ctx.repositoryRows,
  };
  const result = await stage4(ctx);
  assert.equal(result.ok, true, result.error);
  const status = await run('git', ['-C', storeRoot, 'config', '-f', join(storeRoot, '.gitmodules'), '--get', 'submodule.service-a.path']);
  assert.equal(status.stdout.trim(), 'submodules/service-a');

  // The real proof: the submodule must actually be checked out again, not merely registered.
  const restoredHead = git(join(storeRoot, 'submodules', 'service-a'), ['rev-parse', 'HEAD']).trim();
  assert.equal(restoredHead, expectedHead, 'the submodule checkout must be restored to the expected commit');
  assert.equal(readFileSync(join(storeRoot, 'submodules', 'service-a', 'only-in-checkout.txt'), 'utf8'), 'proof of real checkout\n',
    'a file that only exists inside the checkout must be present again after stage4 reruns');
});

test('a successful commit+push of the staged submodule registration leaves matching evidence lines', async () => {
  const storeRoot = makeStore();
  const storeRemote = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-store-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, storeRemote]);
  git(storeRoot, ['remote', 'add', 'origin', storeRemote]);
  git(storeRoot, ['push', '-q', 'origin', BASE]);

  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-remote2-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage4-work2-'));
  git(workDir, ['init', '-q', '-b', BASE, workDir]);
  git(workDir, ['config', 'user.email', 'fixture@example.com']);
  git(workDir, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(workDir, 'README.md'), '# service-b\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);

  const ctx = {
    run: (cmd, args, opts = {}) => run(cmd, args, { ...opts, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } }),
    storeRoot,
    config: { store: { base_branch: BASE } },
    repositoryRows: [{ name: 'service-b', url: bareDir, base_branch: BASE }],
  };
  const result = await stage4(ctx);
  assert.equal(result.ok, true, result.error);

  // The commit gets a generic step() line AND a descriptive summary line...
  assert.ok(result.evidence.some((e) => /\$ git -C .* commit -m chore\(serpens-sdd\): register project submodules → exit 0/.test(e)));
  assert.ok(result.evidence.some((e) => e.startsWith('committed staged submodule registration:')));
  // ...and the push must carry BOTH the same way: never silent on success.
  assert.ok(result.evidence.some((e) => new RegExp(`\\$ git -C .* push origin ${BASE} → exit 0`).test(e)), 'expected a generic push evidence line');
  assert.ok(result.evidence.some((e) => e === `pushed submodule registration commit to origin/${BASE}`), 'expected a descriptive push summary line');

  // Prove it actually reached the remote, not just that the exit code was 0.
  const remoteLog = execFileSync('git', ['log', '--oneline', BASE], { cwd: storeRemote, encoding: 'utf8' });
  assert.match(remoteLog, /register project submodules/);
});

test('--dry-run skips sync entirely and executes nothing', async () => {
  let calls = 0;
  const ctx = {
    run: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    storeRoot: '/nonexistent',
    dryRun: true,
  };
  const result = await stage4(ctx);
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});
