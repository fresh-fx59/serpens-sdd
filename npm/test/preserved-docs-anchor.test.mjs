// F1 regression: RG_EXCLUDE_PRESERVED in tests/starter-contract-test.sh used to anchor
// `!**/docs/FLOW.md` — a `**/docs/` prefix matches a docs/ directory at ANY depth, not just
// the kit-root docs/ that spec-npm-oidc-publishing-2026-09-11.md §10 actually preserves. A
// nested `skills/<x>/docs/FLOW.md` carrying clone-era vocabulary (tools/ script paths, a
// machine-specific /Users/... path, an opsx call) was silently exempted from every T2/T5/T6
// contract check, and the suite still reported PASS=86 FAIL=0.
//
// This test plants exactly that nested leak in a throwaway copy of the real en/ kit, runs the
// real starter-contract-test.sh against it, and asserts the suite now FAILS — proving the
// anchoring fix (cd into $KIT, `--glob '!/docs/<name>'`) actually narrows the exemption to the
// kit root, the same rule classifyTargetOnly (prune-public-tree.mjs) and T1 already use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKitSource } from '../scripts/kit-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = join(__dirname, '..', '..');
const SUITE = join(VAULT_ROOT, 'tests', 'starter-contract-test.sh');

function runSuite(kitDir) {
  const res = spawnSync('bash', [SUITE, kitDir], { encoding: 'utf8' });
  const m = /PASS=(\d+) FAIL=(\d+)/.exec(res.stdout);
  assert.ok(m, `could not parse PASS/FAIL out of suite output:\n${res.stdout}\n${res.stderr}`);
  return { pass: Number(m[1]), fail: Number(m[2]), stdout: res.stdout };
}

test('a nested skills/.../docs/FLOW.md leak (clone-era vocabulary) fails the contract suite', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'starter-contract-leak-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const kitCopy = join(tmp, 'kit');
  cpSync(resolveKitSource('en', VAULT_ROOT), kitCopy, { recursive: true });

  // Sanity: the unmodified copy passes clean, so any failure below is caused by the plant.
  const clean = runSuite(kitCopy);
  assert.equal(clean.fail, 0, `expected a clean kit copy to pass, got:\n${clean.stdout}`);

  const nestedDocs = join(kitCopy, 'skills', 'newskill', 'docs');
  mkdirSync(nestedDocs, { recursive: true });
  writeFileSync(
    join(nestedDocs, 'FLOW.md'),
    'This references tools/sync-repos.sh and clones/ and an opsx call, '
    + 'plus /Users/alex/vault and scripts/foo.sh.\n',
  );
  assert.ok(existsSync(join(nestedDocs, 'FLOW.md')));

  const leaked = runSuite(kitCopy);
  assert.ok(leaked.fail > 0,
    `expected the planted nested docs/FLOW.md leak to fail the suite, but got PASS=${leaked.pass} FAIL=${leaked.fail} `
    + `(the **/docs/ glob is exempting a non-kit-root docs/ directory again):\n${leaked.stdout}`);
});
