import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPort, listPorts, validatePort } from '../src/ports.mjs';

test('loads the qwen entry with the probed layout', () => {
  const p = loadPort({ id: 'qwen' });
  assert.equal(p.agent_dir, '.qwen');
  assert.equal(p.command_layout, 'flat-prefixed');
  assert.equal(p.command_format, 'md');
  assert.equal(p.skill_layout, 'dir-per-skill');
  assert.ok(p.verified);
});

test('an unknown id is exit 2 and lists what exists', () => {
  assert.throws(() => loadPort({ id: 'nope' }), (e) => e.exitCode === 2 && /qwen/.test(e.message));
});

test('a port file missing a required field is rejected by name', () => {
  const r = validatePort({ id: 'x', agent_dir: '.x' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /instruction_file/);
});

test('every shipped port validates', () => {
  for (const p of listPorts()) assert.deepEqual(validatePort(p).errors, []);
});

test('a malformed port file fails cleanly with exitCode 2 naming the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ports-test-'));
  const badPath = join(dir, 'broken.json');
  writeFileSync(badPath, '{ not valid json', 'utf8');
  try {
    assert.throws(
      () => loadPort({ id: 'broken', file: badPath }),
      (e) => e.exitCode === 2 && e.message.includes(badPath),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an id that disagrees with its filename is rejected', () => {
  // Write a temporary port file into a scratch dir (never the shipped ports/ directory) under
  // a fresh id, and point loadPort at it via registryDir so it resolves by filename convention
  // (the mismatch check only applies to the {id} form, not the explicit {file} form).
  const dir = mkdtempSync(join(tmpdir(), 'ports-test-'));
  const tempId = 'zz-mismatch-test';
  const path = join(dir, `${tempId}.json`);
  writeFileSync(path, JSON.stringify({ ...loadPort({ id: 'qwen' }), id: 'cursor' }), 'utf8');
  try {
    assert.throws(
      () => loadPort({ id: tempId, registryDir: dir }),
      (e) => e.exitCode === 2 && /cursor/.test(e.message) && new RegExp(tempId).test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
