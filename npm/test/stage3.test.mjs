import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { kitPath } from '../src/integrity.mjs';
import { stage3 } from '../src/stages/stage3-store.mjs';
import { makeBareRemote, fakeOpenspec } from './helpers/fixture.mjs';

const KIT_DIR = kitPath('en');

function makeCtx({ storeRoot, remote, base = 'develop', storeId = 'acme-store' }) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-openspec-'));
  const oss = fakeOpenspec(fixtureDir);
  const env = oss.pathPrepend(process.env);
  const wrappedRun = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env });
  const config = {
    project: 'acme',
    store: { id: storeId, root: storeRoot, remote, base_branch: base },
    openspec: { invocation: 'openspec', pinned_version: '1.2.3' },
  };
  return { config, run: wrappedRun, storeRoot, kitDir: KIT_DIR };
}

test('remote already has the base ref: clones, never git-inits a second history', async () => {
  const remote = makeBareRemote('clone-case', { base: 'develop' });
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');

  const ctx = makeCtx({ storeRoot, remote: remote.remotePath, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.case, 'clone');

  const log = execFileSync('git', ['-C', storeRoot, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, new RegExp(remote.headCommit.slice(0, 7)));

  // Never a second, unrelated history: exactly one root commit, and it is the remote's.
  const roots = execFileSync('git', ['-C', storeRoot, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(roots, [remote.headCommit]);

  // No script copies — only the shim lives in tools/.
  assert.deepEqual(readdirSync(join(storeRoot, 'tools')), ['serpens-sdd']);
});

test('no ref and no local store: copies the template and inits', async () => {
  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-empty-remote-'));
  execFileSync('git', ['init', '--bare', '-b', 'develop', bareDir], { stdio: 'ignore' });

  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');

  const ctx = makeCtx({ storeRoot, remote: bareDir, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.case, 'template');

  // Template files are present.
  assert.ok(existsSync(join(storeRoot, 'README.md')));
  assert.ok(existsSync(join(storeRoot, 'conventions')));
  assert.ok(existsSync(join(storeRoot, 'openspec')));

  // All six templates the kit's commands cite by path land at their documented destinations.
  for (const f of ['adr.md', 'research.md', 'store-contract.md', 'testing-stack.md']) {
    assert.ok(existsSync(join(storeRoot, 'templates', f)), `templates/${f} missing`);
  }
  assert.ok(existsSync(join(storeRoot, 'port-facts.md')));
  assert.ok(existsSync(join(storeRoot, 'conventions', 'branching.md')));

  const head = execFileSync('git', ['-C', storeRoot, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  assert.equal(head, 'develop');

  // No script copies here either.
  const tools = readdirSync(join(storeRoot, 'tools')).filter((f) => f !== '.gitkeep');
  assert.deepEqual(tools, ['serpens-sdd']);
});

test('store already local: neither clones nor copies, and leaves the worktree untouched', async () => {
  const remote = makeBareRemote('local-case', { base: 'develop' });
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  execFileSync('git', ['clone', '--branch', 'develop', '--single-branch', remote.remotePath, storeRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: storeRoot });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: storeRoot });

  const readmePath = join(storeRoot, 'README.md');
  const mtimeBefore = statSync(readmePath).mtimeMs;
  const headBefore = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const ctx = makeCtx({ storeRoot, remote: remote.remotePath, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.case, 'local');

  // The pre-existing worktree file is untouched.
  assert.equal(statSync(readmePath).mtimeMs, mtimeBefore);
  // HEAD moves by exactly ONE commit, and only because the store-registration step commits the
  // `.openspec-store/store.yaml` upstream refuses to commit itself (operations.js:525). Nothing
  // else in the pre-existing history is rewritten.
  const headAfter = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const added = execFileSync('git', ['-C', storeRoot, 'rev-list', `${headBefore}..${headAfter}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.equal(added.length, 1, `expected exactly one new commit, got ${added.length}`);
  assert.deepEqual(
    execFileSync('git', ['-C', storeRoot, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n'),
    ['.openspec-store/store.yaml'],
  );

  // Neither cloned again nor copied over: no evidence of a second clone/init.
  assert.ok(!result.evidence.some((e) => /\$ git clone/.test(e)));
  assert.ok(!result.evidence.some((e) => /\$ git init/.test(e)));
});

test('no tools/ copies are made in the store: only the shim, never repository-state.sh', async () => {
  const remote = makeBareRemote('tools-case', { base: 'develop' });
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');

  const ctx = makeCtx({ storeRoot, remote: remote.remotePath, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.ok, true);
  const tools = readdirSync(join(storeRoot, 'tools'));
  assert.ok(tools.includes('serpens-sdd'));
  assert.ok(!tools.includes('repository-state.sh'));
  assert.ok(!tools.includes('sync-submodules.sh'));
  assert.ok(!tools.includes('serpens-lint.mjs'));
});

test('--dry-run writes and executes nothing', async () => {
  let calls = 0;
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  const ctx = {
    config: { store: { id: 'acme-store', root: storeRoot, remote: 'unused', base_branch: 'develop' }, openspec: { invocation: 'openspec', pinned_version: 'x' } },
    run: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    storeRoot,
    kitDir: KIT_DIR,
    dryRun: true,
  };
  const result = await stage3(ctx);
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
  assert.equal(existsSync(storeRoot), false);
});

test('an unreachable remote (ls-remote fails) never falls through to the template path', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  const bogusRemote = join(parent, 'no-such-remote-here');

  const ctx = makeCtx({ storeRoot, remote: bogusRemote, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.ok(!result.evidence.some((e) => /\$ git init/.test(e)));
  assert.ok(!result.evidence.some((e) => /cp -R/.test(e)));
  assert.equal(existsSync(storeRoot), false);
});

test('a malformed config.store fails as a result, not an exception', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  const ctx = { config: { project: 'acme' }, run, storeRoot, kitDir: KIT_DIR };
  const result = await stage3(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /config\.store/);
});

test('an existing storeRoot that is not a git repository fails with exitCode 3', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  const { mkdirSync: mkdirSyncFs, writeFileSync: writeFileSyncFs } = await import('node:fs');
  mkdirSyncFs(storeRoot, { recursive: true });
  writeFileSyncFs(join(storeRoot, 'not-a-repo.txt'), 'hi');

  const remote = makeBareRemote('not-git-case', { base: 'develop' });
  const ctx = makeCtx({ storeRoot, remote: remote.remotePath, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.error, /not a git repository/);
});

test('an existing storeRoot that is a git repository but not its own root fails with exitCode 3', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  execFileSync('git', ['init', '-b', 'develop', parent], { stdio: 'ignore' });
  const storeRoot = join(parent, 'nested-not-a-root');
  const { mkdirSync: mkdirSyncFs } = await import('node:fs');
  mkdirSyncFs(storeRoot, { recursive: true });

  const remote = makeBareRemote('nested-case', { base: 'develop' });
  const ctx = makeCtx({ storeRoot, remote: remote.remotePath, base: 'develop' });
  const result = await stage3(ctx);

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.error, /not its own git root/);
});
