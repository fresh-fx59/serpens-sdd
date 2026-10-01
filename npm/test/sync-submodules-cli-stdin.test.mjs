import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wantsStdinRows } from '../src/cli/tools.mjs';

// Bug: `serpens-sdd sync-submodules --repos-from - --store-root <dir>` never read piped rows
// (src/cli/tools.mjs:113 forwarded no `input` to `run()`, and src/run.mjs closes the CHILD's
// stdin immediately when none is given — deliberately, so a stdin-reading child can never hang
// the run). The public CLI path (`runTool`) needed to read the PARENT's own stdin itself and
// forward it, while still failing fast — never hanging — when nothing was piped.

const BIN = new URL('../bin/serpens-sdd.mjs', import.meta.url).pathname;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeBareOrigin() {
  const bareDir = mkdtempSync(join(tmpdir(), 'spns-sync-cli-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'spns-sync-cli-origin-work-'));
  git(workDir, ['init', '-q', '-b', 'main', workDir]);
  git(workDir, ['config', 'user.email', 'e2e@example.com']);
  git(workDir, ['config', 'user.name', 'E2E']);
  writeFileSync(join(workDir, 'README.md'), '# svc-a\n');
  git(workDir, ['add', 'README.md']);
  git(workDir, ['commit', '-q', '-m', 'init']);
  git(workDir, ['push', '-q', bareDir, 'main']);
  return bareDir;
}

function makeStore() {
  const storeDir = mkdtempSync(join(tmpdir(), 'spns-sync-cli-store-'));
  git(storeDir, ['init', '-q', '-b', 'main', storeDir]);
  git(storeDir, ['config', 'user.email', 'e2e@example.com']);
  git(storeDir, ['config', 'user.name', 'E2E']);
  git(storeDir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return storeDir;
}

function runCli(args, { input } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      input: input ?? '',
      timeout: 10_000,
      env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
    });
    return { code: 0, stdout };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      signal: err.signal,
    };
  }
}

test('wantsStdinRows: only true for --repos-from -', () => {
  assert.equal(wantsStdinRows(['--repos-from', '-', '--store-root', '/x']), true);
  assert.equal(wantsStdinRows(['--inventory', 'inv.json']), false);
  assert.equal(wantsStdinRows(['--repos-from', 'somefile']), false);
  assert.equal(wantsStdinRows([]), false);
});

test('(a) --inventory <file> still works from the public CLI', () => {
  const origin = makeBareOrigin();
  const store = makeStore();
  const invPath = join(store, '..', 'inventory.json');
  writeFileSync(invPath, JSON.stringify({
    schema_version: 1,
    project: 'demo',
    repositories: [{ name: 'svc-a', url: `file://${origin}`, base_branch: 'main' }],
  }));
  const result = runCli(['sync-submodules', '--inventory', invPath, '--store-root', store]);
  assert.equal(result.code, 0, result.stdout + (result.stderr || ''));
  assert.match(result.stdout, /reconciled 1 project-bound submodule/);
  const status = git(store, ['submodule', 'status']);
  assert.match(status, /submodules\/svc-a/);
});

test('(c) piped --repos-from - now reaches the script (was silently 0 rows before the fix)', () => {
  const origin = makeBareOrigin();
  const store = makeStore();
  const tsv = `svc-a\tfile://${origin}\tmain\n`;
  const result = runCli(['sync-submodules', '--repos-from', '-', '--store-root', store], { input: tsv });
  assert.equal(result.code, 0, result.stdout + (result.stderr || ''));
  assert.match(result.stdout, /reconciled 1 project-bound submodule/);
  const status = git(store, ['submodule', 'status']);
  assert.match(status, /submodules\/svc-a/);
});

test('(d) --repos-from - with nothing piped fails fast instead of hanging', () => {
  const store = makeStore();
  const result = runCli(['sync-submodules', '--repos-from', '-', '--store-root', store], { input: '' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--repos-from - needs rows on stdin; pipe them or use --inventory <file>/);
  assert.notEqual(result.signal, 'SIGTERM', 'must not have timed out / hung');
});
