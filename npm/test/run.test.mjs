import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, createLog, truncateCapture } from '../src/run.mjs';

test('captures stdout and a zero exit', async () => {
  const r = await run('sh', ['-c', 'echo hi']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'hi');
});

test('returns a non-zero exit instead of throwing', async () => {
  const r = await run('sh', ['-c', 'echo boom >&2; exit 7']);
  assert.equal(r.code, 7);
  assert.match(r.stderr, /boom/);
});

test('logs every command and its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-log-'));
  const log = createLog(join(dir, 'run.log'));
  await run('sh', ['-c', 'exit 3'], { log });
  log.close();
  const text = readFileSync(join(dir, 'run.log'), 'utf8');
  assert.match(text, /\$ sh -c exit 3/);
  assert.match(text, /→ exit 3/);
});

test('dry-run records the command and runs nothing', async () => {
  const r = await run('sh', ['-c', 'exit 9'], { dryRun: true });
  assert.equal(r.code, 0);
  assert.equal(r.dryRun, true);
});

test('record() formats a result object as → exit N', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-log-'));
  const log = createLog(join(dir, 'run.log'));
  log.record({ code: 42, stdout: '', stderr: '' });
  log.close();
  const text = readFileSync(join(dir, 'run.log'), 'utf8');
  assert.match(text, /→ exit 42/);
});

test('record() formats a dry-run result as → (dry-run, not executed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-log-'));
  const log = createLog(join(dir, 'run.log'));
  log.record({ code: 0, stdout: '', stderr: '', dryRun: true });
  log.close();
  const text = readFileSync(join(dir, 'run.log'), 'utf8');
  assert.match(text, /→ \(dry-run, not executed\)/);
});

test('spawn failure returns code 1, not a string error code', async () => {
  const r = await run('serpens-sdd-no-such-binary-xyz', []);
  assert.equal(r.code, 1);
  assert.equal(typeof r.code, 'number');
});

test('opts.input is piped to the child\'s stdin', async () => {
  const r = await run('cat', [], { input: 'hello from stdin\n' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hello from stdin\n');
});

test('with no opts.input, stdin is closed immediately (a `cat` with no input exits 0 with empty stdout)', async () => {
  const r = await run('cat', []);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('log path in non-existent directory does not throw', async () => {
  const nonexistentDir = join(tmpdir(), 'nonexistent-' + Date.now());
  const logPath = join(nonexistentDir, 'run.log');
  const r = await run('sh', ['-c', 'exit 5'], { log: createLog(logPath) });
  assert.equal(r.code, 5);
});

test('the log records the captured output, not only the exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-log-'));
  const logPath = join(dir, 'run.log');
  const log = createLog(logPath);
  await run('sh', ['-c', 'echo first-line; echo second-line; echo to-stderr >&2; exit 4'], { log });
  log.close();
  const text = readFileSync(logPath, 'utf8');

  // the existing pair anything greps for must stay exactly as it was
  assert.match(text, /\$ sh -c echo first-line; echo second-line; echo to-stderr >&2; exit 4/);
  assert.match(text, /→ exit 4/);
  // ...and spec §13's captured output is now there too, both streams
  assert.match(text, /stdout: first-line/);
  assert.match(text, /second-line/);
  assert.match(text, /stderr: to-stderr/);
});

test('a very long capture is truncated and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-log-'));
  const logPath = join(dir, 'run.log');
  const log = createLog(logPath);
  await run('sh', ['-c', 'for i in $(seq 1 2000); do echo padding-line-$i; done'], { log });
  log.close();
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /→ exit 0/);
  assert.match(text, /\[truncated: \d+ chars captured, first 4000 logged\]/);
  assert.ok(text.length < 20000, `the log must not swallow the whole capture, got ${text.length} chars`);
});

test('truncateCapture leaves a short capture byte-identical', () => {
  assert.equal(truncateCapture('short output\n'), 'short output\n');
});

test('a dry-run record logs no output block at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-log-'));
  const logPath = join(dir, 'run.log');
  const log = createLog(logPath);
  log.record({ code: 0, stdout: 'never-executed', stderr: 'never-executed', dryRun: true });
  log.close();
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /→ \(dry-run, not executed\)/);
  assert.doesNotMatch(text, /never-executed/);
});
