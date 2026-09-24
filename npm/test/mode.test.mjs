// `serpens-sdd mode` — the ONLY signal the kit prose trusts for "no human can answer in this
// session". The model must never decide that for itself (coordinator review of 04fe9eb): a weak
// model misjudging it would skip the analyst interview and the WAIT-for-approval gate.
// `unattended` iff SERPENS_UNATTENDED=1 exactly; everything else is `attended`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMode } from '../src/cli/mode.mjs';

const BIN = fileURLToPath(new URL('../bin/serpens-sdd.mjs', import.meta.url));
function runMode(env) {
  const e = { ...process.env };
  delete e.SERPENS_UNATTENDED;
  return spawnSync(process.execPath, [BIN, 'mode'], { env: { ...e, ...env }, encoding: 'utf8' });
}

test('resolveMode: only the exact value 1 means unattended', () => {
  assert.equal(resolveMode({ SERPENS_UNATTENDED: '1' }), 'unattended');
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.equal(resolveMode(v === undefined ? {} : { SERPENS_UNATTENDED: v }), 'attended', String(v));
  }
});

test('CLI prints attended by default, exit 0', () => {
  const r = runMode({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'attended');
});

test('CLI prints unattended only with SERPENS_UNATTENDED=1', () => {
  assert.equal(runMode({ SERPENS_UNATTENDED: '1' }).stdout.trim(), 'unattended');
  assert.equal(runMode({ SERPENS_UNATTENDED: 'true' }).stdout.trim(), 'attended');
});
