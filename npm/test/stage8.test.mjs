import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { stage8 } from '../src/stages/stage8-guards.mjs';

/**
 * Run `fn` with `os.tmpdir()` pointed at a private, empty directory, so what stage 8 leaves
 * behind can be counted exactly — the process-wide temp directory is shared with every other
 * test file running in parallel.
 */
async function withPrivateTmpdir(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage8-sandbox-'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = sandbox;
  process.env.TMP = sandbox;
  process.env.TEMP = sandbox;
  try {
    assert.equal(tmpdir(), sandbox, 'the sandbox must really be os.tmpdir() for this test to mean anything');
    return await fn(sandbox);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('stage 8 proves every guard and leaves no temp fixture directory behind', async () => {
  await withPrivateTmpdir(async (sandbox) => {
    const result = await stage8({ run, config: { lang: 'en' } });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.evidence.filter((e) => e.startsWith('✓ guard fired')).length, 6,
      'all six guards must fire on their bad input');
    assert.deepEqual(readdirSync(sandbox), [],
      `stage 8 left temp fixtures behind: ${readdirSync(sandbox).join(', ')}`);
  });
});

test('the dry-run plan lists every guard, from the GUARDS list itself, and runs none', async () => {
  await withPrivateTmpdir(async (sandbox) => {
    const result = await stage8({ run, dryRun: true, config: { lang: 'en' } });
    assert.equal(result.ok, true);
    assert.equal(result.evidence.filter((e) => e.startsWith('  guard: ')).length, 6);
    assert.deepEqual(readdirSync(sandbox), []);
  });
});
