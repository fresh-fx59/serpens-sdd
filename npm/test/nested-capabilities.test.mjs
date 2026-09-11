// A capability is a directory containing spec.md, and its id is its path relative to
// openspec/specs/ — `user-auth`, or `identity/user-auth`. Both tools used a single-level
// readdirSync and were blind to nesting, which is the layout OPENSPEC'S OWN proposal template
// recommends: "Use kebab-case for path segments you introduce (e.g., `user-auth` or
// `identity/user-auth`) ... Each creates specs/<capability-path>/spec.md".
//
// Reproduced before the fix, on a repo with only openspec/specs/identity/user-auth/spec.md:
//   serpens-lint  ->  ✗ openspec/specs/identity/: capability dir has no spec.md
//   gen-index     ->  "capabilities": []
// So a repository following OpenSpec's advice was red on arrival, and its specs were invisible
// to our own index.
//
// The walker is duplicated verbatim in both vendored tools because each must run standalone.
// The last test here is what makes that safe: it asserts the two agree on the same tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');

function spec(name) {
  return `## Purpose\nThe ${name} capability, for this fixture, in enough words to look real.\n\n`
    + `## Requirements\n### Requirement: ${name} works\n#### Scenario: it is exercised\n`
    + '- **WHEN** it is called\n- **THEN** it responds\n';
}

/** A throwaway git repo whose openspec/specs/ holds a spec.md at each given path. */
function repo(paths, extraDirs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'nested-'));
  mkdirSync(join(dir, 'openspec', 'changes'), { recursive: true });
  for (const p of paths) {
    mkdirSync(join(dir, 'openspec', 'specs', p), { recursive: true });
    writeFileSync(join(dir, 'openspec', 'specs', p, 'spec.md'), spec(p), 'utf8');
  }
  for (const d of extraDirs) mkdirSync(join(dir, 'openspec', 'specs', d), { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

const genIndex = (dir) => execFileSync(process.execPath, [join(TOOLS, 'gen-index.mjs'), dir], { encoding: 'utf8' });
function lint(dir) {
  try { return { code: 0, out: execFileSync(process.execPath, [join(TOOLS, 'serpens-lint.mjs'), dir], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}
const indexIds = (dir) => JSON.parse(readFileSync(join(dir, 'openspec', 'index.json'), 'utf8')).capabilities.map((c) => c.id);

test('a NESTED capability path is indexed and passes lint', () => {
  const dir = repo(['identity/user-auth']);
  genIndex(dir);
  assert.deepEqual(indexIds(dir), ['identity/user-auth']);
  const r = lint(dir);
  assert.equal(r.code, 0, r.out);
});

test('flat and nested capabilities coexist, sorted, all indexed', () => {
  const dir = repo(['billing', 'identity/user-auth', 'identity/sso/saml']);
  genIndex(dir);
  assert.deepEqual(indexIds(dir), ['billing', 'identity/sso/saml', 'identity/user-auth']);
  assert.equal(lint(dir).code, 0);
});

test('a capability nested UNDER a capability is found, not hidden by its parent', () => {
  const dir = repo(['identity', 'identity/user-auth']);
  genIndex(dir);
  assert.deepEqual(indexIds(dir), ['identity', 'identity/user-auth'],
    'descent must continue through a directory that is itself a capability');
  assert.equal(lint(dir).code, 0);
});

test('a container directory with no spec.md anywhere beneath it is STILL an error', () => {
  const dir = repo(['billing'], ['leftover', 'leftover/deeper']);
  genIndex(dir);
  const r = lint(dir);
  assert.equal(r.code, 1, 'an empty directory is still a problem — the fix must not weaken that');
  assert.match(r.out, /openspec\/specs\/leftover\//);
  assert.match(r.out, /no spec\.md and no capability beneath it/);
});

test('a container directory that DOES hold a capability beneath it is legal', () => {
  const dir = repo(['identity/user-auth']);
  genIndex(dir);
  const r = lint(dir);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /identity\/:/, 'a pure container must not be reported');
});

test('a nested id survives the kebab-case check; a bad segment still fails it', () => {
  const dir = repo(['identity/user-auth']);
  genIndex(dir);
  assert.equal(lint(dir).code, 0, 'slash-separated kebab segments are valid');

  // Hand-edit the index to an id with a non-kebab segment: the gate must still bite.
  const p = join(dir, 'openspec', 'index.json');
  const idx = JSON.parse(readFileSync(p, 'utf8'));
  idx.capabilities[0].id = 'identity/User_Auth';
  writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');
  const r = lint(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /not kebab-case path segments/);
});

test('DRIFT GATE: the two vendored copies of findCapabilities are identical', () => {
  // They cannot import each other — every vendored tool must run standalone — so the only thing
  // keeping them honest is this comparison.
  const extract = (file) => {
    const src = readFileSync(join(TOOLS, file), 'utf8');
    const i = src.indexOf('function findCapabilities(');
    assert.notEqual(i, -1, `${file} has no findCapabilities`);
    // Take to the end of the function: the next line that is exactly '}' at column 0.
    const rest = src.slice(i);
    const end = rest.indexOf('\n}\n');
    assert.notEqual(end, -1, `${file}: could not find the end of findCapabilities`);
    return rest.slice(0, end + 2);
  };
  assert.equal(extract('gen-index.mjs'), extract('serpens-lint.mjs'),
    'the duplicated walker has drifted — make the two copies identical again');
});

test('both tools agree on the same tree, which is what the duplication risks', () => {
  const dir = repo(['billing', 'identity/user-auth', 'identity/sso/saml'], ['empty-one']);
  genIndex(dir);
  const fromIndex = indexIds(dir).sort();
  // The lint's own view: it reports every dir it does NOT consider a capability.
  const r = lint(dir);
  assert.match(r.out, /empty-one/, 'the lint sees the empty dir');
  for (const id of fromIndex) {
    assert.doesNotMatch(r.out, new RegExp(`openspec/specs/${id}/: `),
      `the lint must not call ${id} a problem when the index calls it a capability`);
  }
  assert.ok(existsSync(join(dir, 'openspec', 'index.md')));
});
