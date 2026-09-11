import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripJsComments, findUserFacingScriptPaths, scanPackageForScriptPathHints,
} from './helpers/no-script-hints.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

// Fix round 4: the kit's own starter-contract-test.sh has always banned a `tools/*.sh`/`.mjs`
// path in the KIT's prose, but never looked at the PACKAGE's own runtime output — which is
// exactly why twelve of these survived a whole edition of review (gen-index.mjs's own drift
// message told the reader to run `node tools/gen-index.mjs`, a script the edition deleted).
// This is the package-side half of that same ban.

test('no production-code file prints or throws a tools/*.sh or tools/*.mjs path to a user or agent', () => {
  const offenders = scanPackageForScriptPathHints(PKG_ROOT);
  assert.deepEqual(offenders, [], offenders.map((o) => `${o.file}: ${o.matches.join(', ')}`).join('\n'));
});

test('the checker actually catches a planted bad string in a message, not just in theory', () => {
  const badSource = `
// Historical note for a reader of the source: this used to live at tools/gen-index.mjs before
// the edition that deleted it. That citation is fine to keep.
export function check() {
  console.error('  ↳ run: node tools/gen-index.mjs && git add openspec/index.json');
}
`;
  const matches = findUserFacingScriptPaths(badSource, '.mjs');
  assert.deepEqual(matches, ['tools/gen-index.mjs'], 'must catch the string-literal mention, and only that one');
});

test('the checker does NOT false-positive on a legitimate comment-only citation', () => {
  const cleanSource = `
// verify-docs.sh used to derive its root from tools/verify-docs.sh's own location on disk;
// reproduced: it fails looking for tools/gen-index.mjs beside the package's own tools/
// directory. This reimplements its composition instead, driven by an explicit repoRoot.
export function check() {
  console.error('regenerate: serpens-sdd index');
}
`;
  const matches = findUserFacingScriptPaths(cleanSource, '.mjs');
  assert.deepEqual(matches, [], 'a comment-only citation of a historical path must not be flagged');
});

test('stripJsComments preserves line count (so a real scanner could still report the right line)', () => {
  const src = 'a\n// tools/x.mjs\nb\n/* tools/y.mjs\nstill comment */\nc\n';
  const stripped = stripJsComments(src);
  assert.equal(stripped.split('\n').length, src.split('\n').length);
  assert.ok(!/tools\//.test(stripped), 'both comment mentions must be blanked');
});

test('stripJsComments leaves string literals completely untouched', () => {
  const src = "const x = 'tools/gen-index.mjs'; // tools/other.sh\n";
  const stripped = stripJsComments(src);
  assert.match(stripped, /'tools\/gen-index\.mjs'/, 'the string literal survives untouched');
  assert.ok(!stripped.includes('tools/other.sh'), 'the comment is blanked');
});

// Regression test for a real bug found while closing this exact gap: a regex literal's own
// escaped internal slash immediately followed by its closing delimiter (`\https:\/\//`) reads
// as an adjacent `//` pair to a naive character-by-character scanner — without regex-literal
// awareness, stripJsComments misread that as a `//` comment-start and blanked everything from
// partway through the regex to end of line, silently swallowing a genuine bad-string hint that
// followed it on the SAME line. Fixed by giving stripJsComments its own regex-literal state
// (entered only after a character that implies "start of an expression", exited at the first
// unescaped `/` outside a `[...]` class) so a regex literal's internal slashes are copied through
// verbatim instead of being re-interpreted as comment syntax.
test('a regex literal containing escaped slashes does NOT swallow a bad string later on the same line', () => {
  const src = "const re = /https:\\/\\//; console.error('run: node tools/gen-index.mjs');\n";
  const matches = findUserFacingScriptPaths(src, '.mjs');
  assert.deepEqual(matches, ['tools/gen-index.mjs'], 'the bad string after the regex literal must still be caught');
});


// 2026-09-09.1: the case the literal `tools/` prefix used to miss. Without this, the rename
// could move a script and every stale hint naming its new home would read as clean.
test('a script-path hint under a directory OTHER than tools/ is caught', () => {
  const src = "console.error('  ↳ run: node scripts/gen-index.mjs');\n";
  assert.deepEqual(findUserFacingScriptPaths(src, '.mjs'), ['scripts/gen-index.mjs']);
});

test('a deeply nested hint path is caught', () => {
  const src = "console.error('run: bash en/scripts/tools/repository-state.sh inspect');\n";
  assert.deepEqual(findUserFacingScriptPaths(src, '.sh'), ['en/scripts/tools/repository-state.sh']);
});

test('a bare basename with no directory is NOT a hint — it is the dispatcher naming its own file', () => {
  const src = "const t = join(TOOLS, 'repository-state.sh');\n";
  assert.deepEqual(findUserFacingScriptPaths(src, '.mjs'), []);
});

test('a relative module import is NOT a hint', () => {
  const src = "const m = await import('../cli/verify-docs.mjs');\n";
  assert.deepEqual(findUserFacingScriptPaths(src, '.mjs'), []);
});
