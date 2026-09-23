// `openspec/config.yaml` is OpenSpec's file, filled in by the user. We add exactly one key to
// it (`references:`), and the previous implementation destroyed user data doing so. Every case
// below is a shape a real brownfield repository can have; the first one is the reproduced bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declareStoreReference, declaredReferenceIds, topLevelKeys, inspectConfig, resolveConfigPath,
  renameStoreReference, declareContextCatalog, declareArtifactRules, renderContextCatalog,
  verifyOnlyAdded,
} from '../src/openspecconfig.mjs';

const ID = 'acme-store';
const REMOTE = 'git@forge:acme/store.git';
const declare = (text) => declareStoreReference(text, ID, REMOTE);

/** Assert the text is parseable YAML, using python3's parser rather than trusting ourselves. */
function assertValidYaml(text, message) {
  const dir = mkdtempSync(join(tmpdir(), 'osc-'));
  const p = join(dir, 'c.yaml');
  writeFileSync(p, text, 'utf8');
  try {
    const out = execFileSync('python3', ['-c',
      'import sys,yaml,json; print(json.dumps(sorted((yaml.safe_load(open(sys.argv[1])) or {}).keys())))', p],
      { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (err) {
    assert.fail(`${message}\n--- the document ---\n${text}\n--- parser said ---\n${err.stderr || err.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE BUG. Reproduced on a real repository before this module existed.

test('THE BUG: the word "references:" in the user\'s context prose no longer corrupts the file', () => {
  // Verbatim shape from the reproduction: a populated OpenSpec context pack whose prose happens
  // to contain the word. The old code's includes() matched it, findIndex() returned -1, and
  // splice(-1 + 1) wrote the entry at the TOP of the file, making it invalid YAML and silently
  // costing the user their `schema`, their whole `context:` and their `rules:`.
  const before = [
    'schema: spec-driven',
    'context: |',
    '  Payments service. Java 21, Gradle.',
    '  Cross-team references: see the platform handbook on the team wiki.',
    '  Testing: unit under src/test, integration needs a container.',
    'rules:',
    '  proposal:',
    '    - Keep proposals under 500 words',
    '',
  ].join('\n');

  // The scanner must not see the prose line as the key.
  assert.deepEqual(topLevelKeys(before), ['schema', 'context', 'rules'],
    '"references:" inside a block scalar is user prose, not a top-level key');

  const r = declare(before);
  assert.equal(r.action, 'appended', r.reason);
  const keys = assertValidYaml(r.text, 'the edited config must still be valid YAML');
  assert.deepEqual(keys, ['context', 'references', 'rules', 'schema']);
  assert.ok(r.text.startsWith('schema: spec-driven'), 'the file must still begin where it began');
  assert.ok(r.text.includes('  Cross-team references: see the platform handbook on the team wiki.'),
    "the user's prose must survive byte for byte");
  assert.deepEqual(declaredReferenceIds(r.text), [ID]);
});

// ---------------------------------------------------------------------------
// The ordinary cases.

test('a stock `openspec init` config — mostly commented-out examples — is handled', () => {
  // Verbatim from `openspec init --tools claude` on 1.12.0: the commented examples include the
  // literal text "#   rules:" and "#     proposal:", which must not read as keys.
  const before = [
    'schema: spec-driven',
    '',
    '# Project context (optional)',
    '# Example:',
    '#   context: |',
    '#     Tech stack: TypeScript, React, Node.js',
    '',
    '# Per-artifact rules (optional)',
    '# Example:',
    '#   rules:',
    '#     proposal:',
    '#       - Keep proposals under 500 words',
    '',
  ].join('\n');
  assert.deepEqual(topLevelKeys(before), ['schema'], 'commented examples are not keys');
  const r = declare(before);
  assert.equal(r.action, 'appended', r.reason);
  assert.deepEqual(assertValidYaml(r.text, 'stock config stays valid'), ['references', 'schema']);
});

test('an existing block-style `references:` gets the entry inserted under it, in order', () => {
  const before = 'schema: spec-driven\nreferences:\n  - id: first\n    remote: git@f:o/first.git\ncontext: |\n  prose\n';
  const r = declare(before);
  assert.equal(r.action, 'inserted', r.reason);
  assert.deepEqual(declaredReferenceIds(r.text), ['first', ID]);
  assert.deepEqual(assertValidYaml(r.text, 'insertion stays valid'), ['context', 'references', 'schema']);
  assert.ok(r.text.includes('context: |\n  prose'), 'the key AFTER references is untouched');
});

test('the plain-string reference form is read, so we never append a duplicate', () => {
  const before = 'schema: spec-driven\nreferences:\n  - mystore\n';
  assert.deepEqual(declaredReferenceIds(before), ['mystore']);
  const already = declareStoreReference(before, 'mystore', REMOTE);
  assert.equal(already.action, 'unchanged', 'an id already declared as a plain string is declared');
  assert.equal(already.text, before, 'and nothing is written');
});

test('declaring the same store twice is a no-op, decided on parsed ids not a substring', () => {
  const first = declare('schema: spec-driven\n');
  const second = declare(first.text);
  assert.equal(second.action, 'unchanged');
  assert.equal(second.text, first.text);
  // The substring trap: the id appears in prose, but is not declared.
  const decoy = `schema: spec-driven\ncontext: |\n  we mirror ${ID} nightly\n`;
  assert.deepEqual(declaredReferenceIds(decoy), [], 'prose mentioning the id is not a declaration');
  assert.equal(declare(decoy).action, 'appended');
});

test('a file that ENDS inside a block scalar is not swallowed', () => {
  const before = 'schema: spec-driven\ncontext: |\n  line one\n  line two';
  const r = declare(before);
  assert.equal(r.action, 'appended', r.reason);
  const keys = assertValidYaml(r.text, 'appending after an unterminated block scalar stays valid');
  assert.deepEqual(keys, ['context', 'references', 'schema']);
  assert.ok(r.text.includes('  line two'), 'the last prose line survives');
});

test('an empty file, and a file with only a document marker', () => {
  for (const before of ['', '\n', '---\n']) {
    const r = declare(before);
    assert.equal(r.action, 'appended', `${JSON.stringify(before)}: ${r.reason}`);
    assert.deepEqual(declaredReferenceIds(r.text), [ID]);
    assertValidYaml(r.text, `${JSON.stringify(before)} must produce valid YAML`);
  }
});

test('CRLF is preserved, not silently rewritten', () => {
  const before = 'schema: spec-driven\r\ncontext: |\r\n  prose\r\n';
  const r = declare(before);
  assert.equal(r.action, 'appended', r.reason);
  assert.ok(r.text.includes('\r\n'), 'the file kept its line endings');
  assert.equal(r.text.includes('\n\n'), false, 'no bare LF was introduced mid-file');
  assert.deepEqual(declaredReferenceIds(r.text), [ID]);
});

// ---------------------------------------------------------------------------
// Refusals. A refusal is a good outcome: it costs a minute, a mangled config costs a context pack.

test('tabs in indentation are REFUSED with the two lines to add by hand', () => {
  const r = declare('schema: spec-driven\ncontext:\n\tprose\n');
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /tabs/);
  assert.match(r.manual, /references:/);
  assert.equal(r.text, undefined, 'a refusal writes nothing');
});

test('a multi-document file is REFUSED', () => {
  const r = declare('---\nschema: spec-driven\n---\nschema: other\n');
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /document markers/);
});

test('a flow-style `references: []` is REFUSED rather than spliced into', () => {
  const r = declare('schema: spec-driven\nreferences: [existing-one]\n');
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /flow style/);
});

test('a top-level flow mapping is REFUSED', () => {
  const r = declare('{ schema: spec-driven }\n');
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /flow mapping/);
});

test('a store id needing YAML quoting is REFUSED rather than written unquoted', () => {
  const r = declareStoreReference('schema: spec-driven\n', 'has spaces: and a colon', REMOTE);
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /plain scalar/);
});

// ---------------------------------------------------------------------------
// The self-check is the real guarantee.

test('the self-check proves the edit ONLY added lines, on every accepted case', () => {
  const cases = [
    'schema: spec-driven\n',
    'schema: spec-driven\ncontext: |\n  references: not a key\n',
    'schema: spec-driven\nreferences:\n  - id: a\n    remote: r\n',
    'schema: spec-driven\n# trailing comment\n',
    'schema: spec-driven\noperations:\n  apply:\n    guidance:\n      - be brief\n',
  ];
  for (const before of cases) {
    const r = declare(before);
    assert.ok(['appended', 'inserted', 'unchanged'].includes(r.action), `${before}: ${r.reason}`);
    if (r.action === 'unchanged') continue;
    // Remove exactly what we claim to have added; the original must come back.
    const added = r.action === 'appended'
      ? ['references:', `  - id: ${ID}`, `    remote: ${REMOTE}`]
      : [`  - id: ${ID}`, `    remote: ${REMOTE}`];
    const rest = r.text.replace(/\r\n?/g, '\n').split('\n');
    for (const line of added) rest.splice(rest.indexOf(line), 1);
    assert.equal(rest.join('\n').replace(/\n+$/, ''), before.replace(/\n+$/, ''),
      `the edit changed something it should not have:\n${before}`);
  }
});

test('inspectConfig never reports a key that lives inside a block scalar', () => {
  const before = [
    'schema: spec-driven',
    'context: >-',
    '  schema: not-a-key',
    '  rules: not-a-key',
    '  store: not-a-key',
    'store: real-one',
  ].join('\n');
  const r = inspectConfig(before);
  assert.equal(r.ok, true);
  assert.deepEqual(r.topLevelKeys.map((k) => k.key), ['schema', 'context', 'store']);
});

// ---------------------------------------------------------------------------
// The two further corruptions `codex exec` found in this same write, both reproduced against
// OpenSpec 1.12's own parser before being fixed.

test('a remote containing " #" is QUOTED, not silently truncated into a comment', () => {
  const r = declareStoreReference('schema: spec-driven\ncontext: |\n  pack\n', ID, 'git@f:o/r.git #frag');
  assert.equal(r.action, 'appended', r.reason);
  assert.match(r.text, /remote: 'git@f:o\/r\.git #frag'/,
    'unquoted, YAML reads this as `git@f:o/r.git` and the fragment vanishes');
  assertValidYaml(r.text, 'a quoted remote keeps the document valid');
});

test('a remote containing ": " is QUOTED, not left to break the whole document', () => {
  // Unquoted this produced "Nested mappings are not allowed in compact mappings", and OpenSpec
  // responded by WARNING AND IGNORING THE ENTIRE CONFIG — so a bad remote cost the user their
  // context pack and their rules.
  const r = declareStoreReference('schema: spec-driven\nrules:\n  proposal:\n    - be brief\n', ID, 'ssh://h: 22/r.git');
  assert.equal(r.action, 'appended', r.reason);
  assert.match(r.text, /remote: 'ssh:\/\/h: 22\/r\.git'/);
  assert.deepEqual(assertValidYaml(r.text, 'a colon-space remote must not break the document'),
    ['references', 'rules', 'schema']);
});

test('an ordinary remote stays unquoted — quoting is applied only where it is needed', () => {
  for (const remote of ['git@forge:acme/store.git', 'https://forge/acme/store.git', '/srv/git/store.git']) {
    const r = declareStoreReference('schema: spec-driven\n', ID, remote);
    assert.ok(r.text.includes(`    remote: ${remote}`), `${remote} should stay plain`);
  }
});

// The contract is the ROUND TRIP, not a quoting style — a quote only matters at the START of a
// plain scalar, so `it's` mid-value needs none. Assert what OpenSpec reads back, not how we
// wrote it, or the test dictates an implementation instead of a behaviour.
test('every awkward remote round-trips through a real YAML parser unchanged', () => {
  const remotes = [
    'git@forge:acme/store.git',
    'https://forge/acme/store.git',
    '/srv/git/store.git',
    "git@f:o/it's.git",
    'git@f:o/r.git #frag',
    'ssh://h: 22/r.git',
    'git@f:o/r-with-#-hash.git',
    '  leading-and-trailing  ',
    'yes',
    '12345',
    '*anchor-looking',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'osc-rt-'));
  for (const remote of remotes) {
    const r = declareStoreReference('schema: spec-driven\ncontext: |\n  my pack\n', ID, remote);
    assert.equal(r.action, 'appended', `${JSON.stringify(remote)}: ${r.reason}`);
    const p = join(dir, 'c.yaml');
    writeFileSync(p, r.text, 'utf8');
    const out = execFileSync('python3', ['-c',
      'import sys,yaml,json; d=yaml.safe_load(open(sys.argv[1])); print(json.dumps({"remote": d["references"][0]["remote"], "context": d.get("context")}))', p],
      { encoding: 'utf8' });
    const got = JSON.parse(out);
    assert.equal(got.remote, remote,
      `${JSON.stringify(remote)} came back as ${JSON.stringify(got.remote)} — the value was changed on the way in`);
    assert.equal(got.context, 'my pack\n', "and the user's context pack survived");
  }
});

test('resolveConfigPath edits the file OpenSpec would READ — .yaml wins, else .yml', () => {
  const both = (p) => p.endsWith('config.yaml') || p.endsWith('config.yml');
  assert.match(resolveConfigPath('/r', both).path, /config\.yaml$/, '.yaml takes precedence');

  // The bug: a repository whose real config is config.yml used to get a NEW config.yaml holding
  // only `references:`, which shadowed everything they had written.
  const onlyYml = (p) => p.endsWith('config.yml');
  const r = resolveConfigPath('/r', onlyYml);
  assert.match(r.path, /config\.yml$/, 'an existing .yml must be the file we edit');
  assert.equal(r.existed, true);

  const neither = () => false;
  const fresh = resolveConfigPath('/r', neither);
  assert.match(fresh.path, /config\.yaml$/, 'a fresh repo gets .yaml');
  assert.equal(fresh.existed, false);
});

// ---------------------------------------------------------------------------------------------
// renameStoreReference — the other half of store-id adoption
// ---------------------------------------------------------------------------------------------

test('renameStoreReference rewrites both entry shapes and touches nothing else', () => {
  // The `note: |` block is the trap: its prose contains a line that is byte-identical to a
  // plain-string reference entry. Only the block-scalar tracking in inspectConfig keeps the
  // rename off it — drop that guard and this fixture's prose gets rewritten too.
  const text = [
    'schema: default',
    'context: |',
    '  Cross-team references: see the platform handbook.',
    'references:',
    '  - id: old-store',
    '    remote: git@forge:acme/store.git',
    '    note: |',
    '      - old-store',
    '      still prose, still not an entry',
    '  - plain-old',
    '  # a comment inside the block',
    'rules:',
    '  design: keep',
    '',
  ].join('\n');

  const mapping = renameStoreReference(text, 'old-store', 'new-store');
  assert.equal(mapping.action, 'renamed');
  assert.equal(mapping.count, 1);
  assert.deepEqual(declaredReferenceIds(mapping.text), ['new-store', 'plain-old']);
  // The block scalar is user prose: the line inside it that LOOKS like an entry stays verbatim.
  assert.match(mapping.text, /\n {6}- old-store\n {6}still prose, still not an entry\n/);
  assert.match(mapping.text, /Cross-team references: see the platform handbook\./);
  assertValidYaml(mapping.text, 'the renamed config is not valid YAML');

  const plain = renameStoreReference(text, 'plain-old', 'plain-new');
  assert.equal(plain.action, 'renamed');
  assert.deepEqual(declaredReferenceIds(plain.text), ['old-store', 'plain-new']);
});

test('renameStoreReference is a no-op when the old id is not declared, and refuses what it cannot edit', () => {
  const block = 'schema: default\nreferences:\n  - id: other\n';
  assert.equal(renameStoreReference(block, 'old-store', 'new-store').action, 'unchanged');
  assert.equal(renameStoreReference('schema: default\n', 'old-store', 'new-store').action, 'unchanged');

  const flow = 'schema: default\nreferences: [old-store]\n';
  const refusedFlow = renameStoreReference(flow, 'old-store', 'new-store');
  assert.equal(refusedFlow.action, 'refused');
  assert.match(refusedFlow.reason, /flow style/);
  assert.ok(refusedFlow.manual);

  const tabs = 'schema: default\nreferences:\n\t- id: old-store\n';
  assert.equal(renameStoreReference(tabs, 'old-store', 'new-store').action, 'refused');

  const badId = 'schema: default\nreferences:\n  - id: old-store\n';
  assert.equal(renameStoreReference(badId, 'old-store', 'not a plain scalar').action, 'refused');
});

// ---------------------------------------------------------------------------------------------
// F1 — the rename is anchored to the references block's OWN indentation
// ---------------------------------------------------------------------------------------------

test('renameStoreReference leaves a nested sequence inside an entry alone — it is not a reference', () => {
  // The negative-control fixture: `notes:` belongs to the first entry, and its items are NOT
  // reference entries. Nothing here is a block scalar, so the only thing that can keep the
  // rename off `- old-store` is anchoring to the block's own indentation.
  const text = [
    'schema: default',
    'references:',
    '  - id: alpha',
    '    remote: git@forge:acme/store.git',
    '    notes:',
    '      - old-store',
    '      - keep-me',
    '  - id: old-store',
    '    remote: git@forge:acme/other.git',
    'rules:',
    '  design: keep',
    '',
  ].join('\n');

  // The scanner agrees the nested items are not references in the first place.
  assert.deepEqual(declaredReferenceIds(text), ['alpha', 'old-store']);

  const r = renameStoreReference(text, 'old-store', 'new-store');
  assert.equal(r.action, 'renamed', r.reason);
  assert.equal(r.count, 1, 'exactly one line is a reference entry naming the old id');
  assert.match(r.text, /\n {4}notes:\n {6}- old-store\n {6}- keep-me\n/, 'a nested note was rewritten');
  assert.deepEqual(declaredReferenceIds(r.text), ['alpha', 'new-store']);
  assertValidYaml(r.text, 'the renamed config is not valid YAML');
});

test('only the TOP-LEVEL references block is rewritten, never a nested one', () => {
  const text = [
    'store:',
    '  references:',
    '    - id: not-top-level',
    'references:',
    '  - id: old-store',
    '',
  ].join('\n');
  const r = renameStoreReference(text, 'old-store', 'new-store');
  assert.equal(r.action, 'renamed', r.reason);
  assert.equal(r.count, 1);
  assert.match(r.text, /^store:\n {2}references:\n {4}- id: not-top-level\n/, 'a nested block was rewritten');
});

// ---------------------------------------------------------------------------------------------
// F2 — the rewritten id is written through the same quoting rule every other value gets
// ---------------------------------------------------------------------------------------------

/** What a real YAML parser reads back for `references[0]`, id-only or mapping. */
function parsedFirstReferenceId(text) {
  const dir = mkdtempSync(join(tmpdir(), 'osc-id-'));
  const p = join(dir, 'c.yaml');
  writeFileSync(p, text, 'utf8');
  const out = execFileSync('python3', ['-c',
    'import sys,yaml,json; d=yaml.safe_load(open(sys.argv[1])); e=d["references"][0];'
    + ' print(json.dumps(e["id"] if isinstance(e, dict) else e))', p],
    { encoding: 'utf8' });
  return JSON.parse(out);
}

test('a YAML-special id is QUOTED on rewrite, so the reference is not silently turned into a boolean', () => {
  for (const special of ['no', 'yes', 'on', 'off', 'null', 'y', 'N', 'true']) {
    const mapping = renameStoreReference('schema: default\nreferences:\n  - id: old-store\n', 'old-store', special);
    assert.equal(mapping.action, 'renamed', `${special}: ${mapping.reason}`);
    assert.equal(parsedFirstReferenceId(mapping.text), special,
      `- id: ${special} did not read back as the string "${special}"`);
    assert.deepEqual(declaredReferenceIds(mapping.text), [special]);

    const plain = renameStoreReference('schema: default\nreferences:\n  - old-store\n', 'old-store', special);
    assert.equal(plain.action, 'renamed', `${special}: ${plain.reason}`);
    assert.equal(parsedFirstReferenceId(plain.text), special,
      `- ${special} did not read back as the string "${special}"`);
  }
});

test('a YAML-special id is QUOTED when the entry is first declared, too', () => {
  const r = declareStoreReference('schema: default\n', 'off', REMOTE);
  assert.equal(r.action, 'appended', r.reason);
  assert.equal(parsedFirstReferenceId(r.text), 'off');
  assert.deepEqual(declaredReferenceIds(r.text), ['off']);
  // And an ordinary id is still written bare — quoting only where it is needed.
  assert.match(declare('schema: default\n').text, /\n {2}- id: acme-store\n/);
});

test('an ALREADY-QUOTED entry is renamed, not refused — the self-check compares tokens, not substrings', () => {
  const text = "schema: default\nreferences:\n  - id: 'old-store'\n    remote: git@forge:acme/store.git\n";
  const r = renameStoreReference(text, 'old-store', 'new-store');
  assert.equal(r.action, 'renamed', r.reason);
  assert.deepEqual(declaredReferenceIds(r.text), ['new-store']);
  assert.match(r.text, /\n {4}remote: git@forge:acme\/store\.git\n/, 'the rest of the entry moved');
});

test('a line that dedents out of the references block ends it — the entries below are not guessed at', () => {
  // Deliberately malformed: the second item sits at a SHALLOWER indentation than the block's own,
  // so it is not part of this sequence by any reading. Refuse rather than guess is the module's
  // rule, and rewriting a line we cannot place is exactly the class of bug this module ends.
  const text = 'schema: default\nreferences:\n    - id: alpha\n  - id: old-store\n';
  const r = renameStoreReference(text, 'old-store', 'new-store');
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, text);
  assert.deepEqual(declaredReferenceIds(text), ['alpha']);
});

// ---------------------------------------------------------------------------
// The context catalog and the per-artifact rules — the two other slots OpenSpec injects.
// Design rule under test: `context:` is a CATALOG the agent chooses from, `rules:` is the
// per-stage ORDER. Neither is ever written over a user's own.

const CATALOG = [
  { path: 'serpens/testing-stack.md', answers: 'how tests run here, and what a tester can send or query' },
  { path: 'serpens/branching.md', answers: 'branch and ticket naming' },
];
const RULES = {
  design: ['Read serpens/testing-stack.md before choosing a boundary to test.'],
  tasks: ['Read serpens/testing-stack.md before listing any task that runs a test.'],
};

test('the catalog never tells the agent to read every file', () => {
  const body = renderContextCatalog(CATALOG).join('\n');
  // The whole reason the catalog exists rather than a "read these files" line: a shop that adds
  // a tenth fact file must not make every artifact instruction pay for ten reads.
  assert.match(body, /Open only what the current step needs\./);
  assert.doesNotMatch(body, /read (all|these|every)/i);
  for (const e of CATALOG) assert.ok(body.includes(e.path) && body.includes(e.answers));
});

test('context: is appended as a block scalar and parses as the prose OpenSpec expects', () => {
  const before = 'schema: spec-driven\nreferences:\n  - id: acme-store\n';
  const r = declareContextCatalog(before, CATALOG);
  assert.equal(r.action, 'appended');
  const keys = assertValidYaml(r.text, 'the config with a catalog must parse');
  assert.deepEqual(keys, ['context', 'references', 'schema']);
  const out = execFileSync('python3', ['-c',
    'import sys,yaml; print(yaml.safe_load(sys.stdin)["context"])'],
    { input: r.text, encoding: 'utf8' });
  // A block scalar, so the value is one string — not a mapping OpenSpec would reject.
  assert.ok(out.includes('serpens/testing-stack.md'));
  assert.ok(out.includes('serpens/branching.md'));
});

test("a user's own context: is never rewritten", () => {
  const mine = 'schema: spec-driven\ncontext: |\n  Our platform handbook is the authority.\n  Cross-team references: see the handbook.\n';
  const r = declareContextCatalog(mine, CATALOG);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, mine);
  assert.match(r.reason, /belongs to the user/);
  assert.match(r.manual, /serpens\/testing-stack\.md/);
});

test('rules: is keyed by artifact, so each stage gets only the facts it needs', () => {
  const before = 'schema: spec-driven\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'appended');
  assertValidYaml(r.text, 'the config with rules must parse');
  const out = execFileSync('python3', ['-c',
    'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)["rules"]))'],
    { input: r.text, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  // Upstream's shape: Record<artifactId, string[]>.
  assert.deepEqual(Object.keys(parsed).sort(), ['design', 'tasks']);
  assert.deepEqual(parsed.tasks, RULES.tasks);
  // `proposal` is deliberately absent: it is intent, and needs none of our facts.
  assert.equal(parsed.proposal, undefined);
});

test("a user's rule for an id we also asked for is never rewritten", () => {
  const mine = 'schema: spec-driven\nrules:\n  design:\n    - Our own rule.\n  tasks:\n    - Our own rule.\n';
  const r = declareArtifactRules(mine, RULES);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, mine);
  assert.deepEqual(r.perId, { design: 'unchanged', tasks: 'unchanged' });
});

test('both keys refuse rather than guess on a config this tool cannot read', () => {
  const tabs = 'schema: spec-driven\n\tcontext: x\n';
  assert.equal(declareContextCatalog(tabs, CATALOG).action, 'refused');
  assert.equal(declareArtifactRules(tabs, RULES).action, 'refused');
});

// ---------------------------------------------------------------------------
// Gap 5 — a brownfield `rules:` gets our missing artifact ids inserted, id by id, rather than
// refusing the whole key the way it used to. The user's own ids are never touched.

test('gap 5: existing rules: with one id declared gets the others inserted', () => {
  const before = 'schema: spec-driven\nrules:\n  proposal:\n    - Keep it short.\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'inserted');
  assert.deepEqual(r.perId, { design: 'inserted', tasks: 'inserted' });
  const keys = assertValidYaml(r.text, 'the config with inserted rules must parse');
  assert.deepEqual(keys, ['rules', 'schema']);
  const out = execFileSync('python3', ['-c',
    'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)["rules"]))'],
    { input: r.text, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), ['design', 'proposal', 'tasks']);
  // The user's own `proposal` entry is untouched, byte for byte.
  assert.ok(r.text.includes('  proposal:\n    - Keep it short.\n'));
  assert.deepEqual(parsed.tasks, RULES.tasks);
  assert.deepEqual(parsed.design, RULES.design);
});

test('gap 5: every id already declared under rules: → unchanged, byte-identical', () => {
  const before = 'schema: spec-driven\nrules:\n  design:\n    - Mine.\n  tasks:\n    - Mine too.\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'unchanged');
  assert.equal(r.text, before);
  assert.deepEqual(r.perId, { design: 'unchanged', tasks: 'unchanged' });
});

test('gap 5: rules: followed by another top-level key → insertion lands before that key', () => {
  const before = 'schema: spec-driven\nrules:\n  proposal:\n    - Keep it short.\noperations:\n  apply:\n    guidance:\n      - Ship behind a flag.\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'inserted');
  const opAt = r.text.indexOf('operations:');
  const designAt = r.text.indexOf('  design:');
  const tasksAt = r.text.indexOf('  tasks:');
  assert.ok(designAt !== -1 && designAt < opAt, 'design: must be inserted before operations:');
  assert.ok(tasksAt !== -1 && tasksAt < opAt, 'tasks: must be inserted before operations:');
  assertValidYaml(r.text, 'the config with a mid-file insertion must still parse');
});

test('gap 5: a flow-style rules: refuses, text untouched', () => {
  const before = 'schema: spec-driven\nrules: {proposal: [x]}\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'refused');
  assert.equal(r.text, undefined);
  assert.match(r.reason, /flow style/);
});

test('gap 5: a scalar rules: refuses, text untouched', () => {
  const before = 'schema: spec-driven\nrules: something\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /scalar/);
});

test('gap 5: a rules: block scalar refuses, text untouched', () => {
  const before = 'schema: spec-driven\nrules: |\n  proposal: keep it short\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /block scalar/);
});

test('gap 5: an existing rules: block indented four spaces refuses rather than mismatch', () => {
  const before = 'schema: spec-driven\nrules:\n    proposal:\n        - Keep it short.\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /two spaces/);
});

test('gap 5: CRLF file → inserted lines use CRLF', () => {
  const before = 'schema: spec-driven\r\nrules:\r\n  proposal:\r\n    - Keep it short.\r\n';
  const r = declareArtifactRules(before, RULES);
  assert.equal(r.action, 'inserted');
  assert.ok(r.text.includes('  design:\r\n    - '));
  assert.ok(!/[^\r]\n/.test(r.text), 'every line ending must be CRLF');
});

test('gap 5: verifyOnlyAdded rejects an edit that altered one user byte (negative control)', () => {
  const before = 'schema: spec-driven\nrules:\n  proposal:\n    - Keep it short.\n';
  const corrupted = 'schema: spec-drivenX\nrules:\n  proposal:\n    - Keep it short.\n  design:\n    - Mine.\n';
  const check = verifyOnlyAdded(before, corrupted, ['  design:', '    - Mine.'], '\n', 4);
  assert.equal(check.ok, false);
  assert.match(check.reason, /surrounding content changed/);
});

test('a rule value that YAML would coerce is quoted, not lost', () => {
  const r = declareArtifactRules('schema: spec-driven\n', { tasks: ['yes'] });
  const out = execFileSync('python3', ['-c',
    'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)["rules"]["tasks"]))'],
    { input: r.text, encoding: 'utf8' });
  // YAML 1.1 reads a bare `yes` as the boolean true; the rule must come back as the string.
  assert.deepEqual(JSON.parse(out), ['yes']);
});

test('the catalog and the rules compose without disturbing what is already there', () => {
  const before = 'schema: spec-driven\noperations:\n  apply:\n    guidance:\n      - Ship behind a flag.\n';
  const a = declareContextCatalog(before, CATALOG);
  const b = declareArtifactRules(a.text, RULES);
  assert.equal(b.action, 'appended');
  const keys = assertValidYaml(b.text, 'catalog + rules on top of an existing config must parse');
  assert.deepEqual(keys, ['context', 'operations', 'rules', 'schema']);
  assert.ok(b.text.startsWith(before.trimEnd()));
});
