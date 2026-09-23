import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import checkSchemaMain from '../src/cli/check-schema.mjs';

function capture(fn) {
  const savedOut = process.stdout.write.bind(process.stdout);
  const savedErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = (c) => { stdout += c; return true; };
  process.stderr.write = (c) => { stderr += c; return true; };
  return fn().finally(() => {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }).then((code) => ({ code, stdout, stderr }));
}

test('exits 0 with no openspec/ directory at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-check-schema-'));
  const { code, stdout } = await capture(() => checkSchemaMain(['--repo-root', dir]));
  assert.equal(code, 0);
  assert.match(stdout, /supported/);
  rmSync(dir, { recursive: true, force: true });
});

test('exits 0 for the built-in spec-driven schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-check-schema-'));
  mkdirSync(join(dir, 'openspec'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  const { code } = await capture(() => checkSchemaMain(['--repo-root', dir]));
  assert.equal(code, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('exits 3 and prints the bilingual STOP message for a custom schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-check-schema-'));
  mkdirSync(join(dir, 'openspec'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: acme-flow\n');
  const { code, stderr } = await capture(() => checkSchemaMain(['--repo-root', dir]));
  assert.equal(code, 3);
  assert.match(stderr, /acme-flow/);
  assert.match(stderr, /not yet supported/);
  assert.match(stderr, /схем/i);
  rmSync(dir, { recursive: true, force: true });
});
