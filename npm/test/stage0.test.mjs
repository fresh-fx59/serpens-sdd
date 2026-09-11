import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { stage0 } from '../src/stages/stage0-prereqs.mjs';

const PINNED = '1.13.0';

function baseConfig() {
  return { openspec: { invocation: 'openspec', pinned_version: PINNED } };
}

/**
 * Build an isolated PATH: real git and node (found via `which`), plus a stub script for
 * every name in `stubs` ({name: scriptBody}). Any tool named in `omit` is left off the PATH
 * entirely, reproducing "missing" deterministically regardless of the host machine.
 */
function isolatedPath({ stubs = {}, omit = [] } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage0-bin-'));
  for (const tool of ['git', 'node']) {
    if (omit.includes(tool)) continue;
    const real = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(bin, tool));
  }
  for (const [name, body] of Object.entries(stubs)) {
    if (omit.includes(name)) continue;
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`, 'utf8');
    chmodSync(p, 0o755);
  }
  return bin;
}

function makeRun(pathDir) {
  const env = { ...process.env, PATH: pathDir };
  return (cmd, args, opts = {}) => run(cmd, args, { ...opts, env });
}

test('a missing lefthook is exit 3 and names the tool', async () => {
  const bin = isolatedPath({
    stubs: { openspec: `echo '${PINNED}'`, ctags: "echo 'Universal Ctags'" },
    omit: ['lefthook'],
  });
  const ctx = { config: baseConfig(), run: makeRun(bin) };
  const result = await stage0(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.match(result.error, /lefthook/);
  assert.ok(result.evidence.some((e) => /lefthook: missing/.test(e)));
});

test('BSD ctags is rejected by brand and code search is reported skipped', async () => {
  const bin = isolatedPath({
    stubs: {
      lefthook: "echo 'lefthook version 1.0.0'",
      openspec: `echo '${PINNED}'`,
      ctags: "echo 'Exuberant Ctags 5.9~svn20110310'",
    },
  });
  const ctx = { config: baseConfig(), run: makeRun(bin) };
  const result = await stage0(ctx);
  assert.equal(result.ok, true);
  assert.ok(result.evidence.some((e) => e === 'code search: skipped (ctags is not Universal Ctags, rejected by brand)'));
});

test('a fully present toolchain, including Universal Ctags, passes clean', async () => {
  const bin = isolatedPath({
    stubs: {
      lefthook: "echo 'lefthook version 1.0.0'",
      openspec: `echo '${PINNED}'`,
      ctags: "echo 'Universal Ctags 5.9.0'",
    },
  });
  const ctx = { config: baseConfig(), run: makeRun(bin) };
  const result = await stage0(ctx);
  assert.equal(result.ok, true);
  assert.ok(result.evidence.some((e) => /^ctags: Universal Ctags/.test(e)));
});

test('--dry-run skips every prerequisite check and executes nothing', async () => {
  let calls = 0;
  const ctx = {
    config: baseConfig(),
    run: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
    dryRun: true,
  };
  const result = await stage0(ctx);
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
});
