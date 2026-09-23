// Acceptance for spec-skipspecs-and-custom-schemas-2026-09-11.md §6, item 4a ONLY.
//
// `skip_specs: true` is a first-class field of a change's `.openspec.yaml`
// (`dist/core/change-metadata/schema.js:34`). Upstream then reports the `specs` artifact as
// `skipped` (never `pending` — that state does not exist; the real ones are `done`, `skipped`,
// `ready`, `blocked`) and REFUSES a delta spec under it
// (`dist/core/validation/constants.js:34`). Our four commands used to treat "no delta spec" as
// "something is missing" and stopped — a deadlock on a change upstream considers complete.
//
// This suite proves, against a REAL `@fission-ai/openspec` binary (never a stub — the whole
// claim is about upstream's behaviour, not our beliefs about it):
//   1. the exact JSON shape `status --change --json` reports for a skip_specs change, and that
//      `skipped` already satisfies the dependency graph for `design`/`tasks` downstream;
//   2. `archive` succeeds on such a change with no delta spec at all;
//   3. our lint does NOT fail a change directory with no `specs/` when `skip_specs: true` is set,
//      but DOES fail one that has neither `specs/` nor the marker (negative control);
//   4. neither kit's shipped commands/skills name the nonexistent `pending` state, nor hardcode
//      the schema's artifact-id list as a fixed fact — both gates carry a negative control that
//      proves the matcher actually fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realOpenspec } from './helpers/real-openspec.mjs';
import { kitPath, walk } from '../src/integrity.mjs';

const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tools');

function runLint(dir) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(TOOLS, 'serpens-lint.mjs'), dir], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------------------------------------
// 1-2. The real mechanism this feature depends on.
// ---------------------------------------------------------------------------------------------

test('a skip_specs change: status --json reports specs as skipped, and skipped already satisfies downstream artifacts', () => {
  const oss = realOpenspec();
  execFileSync('git', ['init', '-q', '-b', 'develop', oss.dir]);
  execFileSync('git', ['-C', oss.dir, 'config', 'user.email', 'fixture@example.com']);
  execFileSync('git', ['-C', oss.dir, 'config', 'user.name', 'Fixture']);
  const inited = oss.run(['init', '--tools', 'claude'], { cwd: oss.dir });
  assert.equal(inited.code, 0, inited.stderr);

  const created = oss.run(['new', 'change', 'skip-me'], { cwd: oss.dir });
  assert.equal(created.code, 0, created.stderr);

  const changeDir = join(oss.dir, 'openspec', 'changes', 'skip-me');
  writeFileSync(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-09-11\nskip_specs: true\n', 'utf8');

  // Before proposal.md exists: `specs` is already `skipped`, `design`/`tasks` are `blocked` on
  // `proposal` alone — `specs` never appears as a missing dependency anywhere.
  const before = oss.json(['status', '--change', 'skip-me', '--json'], { cwd: oss.dir });
  const byId = Object.fromEntries(before.artifacts.map((a) => [a.id, a]));
  assert.equal(byId.specs.status, 'skipped');
  assert.equal(byId.design.status, 'blocked');
  assert.deepEqual(byId.design.missingDeps, ['proposal']);
  assert.equal(byId.tasks.status, 'blocked');
  assert.ok(!byId.tasks.missingDeps.includes('specs'), 'a skipped artifact must never be reported as a missing dependency');

  writeFileSync(join(changeDir, 'proposal.md'), '## Why\nTest.\n## What Changes\nTest change.\n', 'utf8');

  const after = oss.json(['status', '--change', 'skip-me', '--json'], { cwd: oss.dir });
  const byId2 = Object.fromEntries(after.artifacts.map((a) => [a.id, a]));
  assert.equal(byId2.proposal.status, 'done');
  assert.equal(byId2.specs.status, 'skipped');
  assert.equal(byId2.design.status, 'ready', 'design must become ready once proposal is done, without a delta spec ever existing');
  assert.equal(byId2.tasks.status, 'blocked');
  assert.deepEqual(byId2.tasks.missingDeps, ['design']);

  // No upstream artifact state is ever "pending" — confirms the fact this whole spec is built on.
  for (const a of after.artifacts) assert.notEqual(a.status, 'pending');
});

test('openspec archive succeeds on a skip_specs change with no delta spec, and reports specsUpdated: false', () => {
  const oss = realOpenspec();
  execFileSync('git', ['init', '-q', '-b', 'develop', oss.dir]);
  execFileSync('git', ['-C', oss.dir, 'config', 'user.email', 'fixture@example.com']);
  execFileSync('git', ['-C', oss.dir, 'config', 'user.name', 'Fixture']);
  assert.equal(oss.run(['init', '--tools', 'claude'], { cwd: oss.dir }).code, 0);
  assert.equal(oss.run(['new', 'change', 'skip-me'], { cwd: oss.dir }).code, 0);

  const changeDir = join(oss.dir, 'openspec', 'changes', 'skip-me');
  writeFileSync(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-09-11\nskip_specs: true\n', 'utf8');
  writeFileSync(join(changeDir, 'proposal.md'), '## Why\nTest.\n## What Changes\nTest change.\n', 'utf8');
  writeFileSync(join(changeDir, 'design.md'), '# Design\nNone needed.\n', 'utf8');
  writeFileSync(join(changeDir, 'tasks.md'), '# Tasks\n- [x] Task 1\n', 'utf8');

  const valid = oss.json(['validate', 'skip-me', '--type', 'change', '--strict', '--json'], { cwd: oss.dir });
  assert.equal(valid.items[0].valid, true, JSON.stringify(valid));

  const archived = oss.run(['archive', 'skip-me', '--yes', '--json'], { cwd: oss.dir });
  assert.equal(archived.code, 0, archived.stderr + archived.stdout);
  const payload = JSON.parse(archived.stdout);
  assert.equal(payload.archive.specsUpdated, false);
  assert.equal(payload.archive.change, 'skip-me');
});

// ---------------------------------------------------------------------------------------------
// 3. serpens-lint: a legitimately-empty specs/ passes; a silently-empty one does not.
// ---------------------------------------------------------------------------------------------

function makeChangeRepo({ skipSpecs }) {
  const oss = realOpenspec();
  execFileSync('git', ['init', '-q', oss.dir]);
  mkdirSync(join(oss.dir, 'openspec', 'changes', 'no-spec-here'), { recursive: true });
  mkdirSync(join(oss.dir, 'openspec', 'specs'), { recursive: true });
  const yaml = skipSpecs
    ? 'schema: spec-driven\ncreated: 2026-09-11\nskip_specs: true\n'
    : 'schema: spec-driven\ncreated: 2026-09-11\n';
  writeFileSync(join(oss.dir, 'openspec', 'changes', 'no-spec-here', '.openspec.yaml'), yaml, 'utf8');
  writeFileSync(join(oss.dir, 'openspec', 'changes', 'no-spec-here', 'proposal.md'), '## Why\nx\n## What Changes\ny\n', 'utf8');
  // Owned (gap 1, step 3 scopes this delta-or-skip_specs check to marked changes): this fixture
  // represents a change WE authored, whichever way skip_specs is set.
  writeFileSync(join(oss.dir, 'openspec', 'changes', 'no-spec-here', '.serpens.yaml'),
    '# serpens-sdd:change-marker\nowner: serpens-sdd\n', 'utf8');
  return oss.dir;
}

test('serpens-lint does not fail a change directory with no specs/ when skip_specs: true is set', () => {
  const dir = makeChangeRepo({ skipSpecs: true });
  const r = runLint(dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!/no-spec-here/.test(r.out), r.out);
});

test('serpens-lint stays green on a change freshly scaffolded by the REAL openspec binary', () => {
  // `openspec new change <id>` succeeds and leaves exactly `.openspec.yaml` behind — no
  // proposal.md, no specs/. Upstream reports `proposal` as `ready` and `specs` as `blocked` on
  // it: a delta spec is not owed yet. Our lint must not fail a change upstream itself would
  // not fail; one freshly scaffolded draft cannot be allowed to block the whole repository.
  const oss = realOpenspec();
  execFileSync('git', ['init', '-q', '-b', 'develop', oss.dir]);
  execFileSync('git', ['-C', oss.dir, 'config', 'user.email', 'fixture@example.com']);
  execFileSync('git', ['-C', oss.dir, 'config', 'user.name', 'Fixture']);
  assert.equal(oss.run(['init', '--tools', 'claude'], { cwd: oss.dir }).code, 0);

  const created = oss.run(['new', 'change', 'draft-child'], { cwd: oss.dir });
  assert.equal(created.code, 0, created.stderr);

  // What upstream itself says about this directory, taken from the binary, not from belief.
  const st = oss.json(['status', '--change', 'draft-child', '--json'], { cwd: oss.dir });
  const byId = Object.fromEntries(st.artifacts.map((a) => [a.id, a]));
  assert.equal(byId.proposal.status, 'ready');
  assert.equal(byId.specs.status, 'blocked', 'a delta spec is not owed before the proposal exists');
  assert.deepEqual(byId.specs.missingDeps, ['proposal']);
  assert.ok(
    !existsSync(join(oss.dir, 'openspec', 'changes', 'draft-child', 'proposal.md')),
    'a freshly scaffolded change carries only .openspec.yaml',
  );

  const r = runLint(oss.dir);
  assert.equal(r.code, 0, `lint must not fail a freshly scaffolded change:\n${r.out}`);
  // This change carries no .serpens.yaml (a real `openspec new change` never writes one) — gap 1,
  // step 3 scopes change-level checks to marked changes, so it is skipped and named ONLY in the
  // aggregate "unmarked change(s) ignored" WARN line, never as an ERROR against draft-child.
  assert.ok(!/✗.*draft-child/.test(r.out), r.out);
  assert.match(r.out, /unmarked change\(s\) ignored/, r.out);
});

test('negative control: a change with no skip_specs and no specs/ IS a lint error', () => {
  const dir = makeChangeRepo({ skipSpecs: false });
  const r = runLint(dir);
  assert.equal(r.code, 1, 'lint must fail a change that silently has no delta spec');
  assert.match(r.out, /no-spec-here/);
  assert.match(r.out, /skip_specs/);
});

// ---------------------------------------------------------------------------------------------
// 4. Grep gates over the SHIPPED kits — each with a negative control proving the matcher fires.
// ---------------------------------------------------------------------------------------------

function shippedCommandAndSkillText(lang) {
  const root = kitPath(lang);
  return walk(root)
    .filter((f) => /^(commands|skills)\//.test(f) && f.endsWith('.md'))
    .map((f) => ({ path: f, text: readFileSync(join(root, f), 'utf8') }));
}

test('grep gate: no shipped command or skill names `pending` as an artifact state', () => {
  const hasPending = (text) => /\bpending\b/i.test(text);
  // Negative control FIRST: the matcher must actually fire on the invented state.
  assert.equal(hasPending('an artifact whose status is `pending`'), true);
  assert.equal(hasPending('the two states that matter are `done` and `skipped`'), false);

  for (const lang of ['en', 'ru']) {
    const offenders = shippedCommandAndSkillText(lang).filter((f) => hasPending(f.text));
    assert.deepEqual(offenders.map((f) => f.path), [], `${lang}: 'pending' does not exist upstream (done/skipped/ready/blocked)`);
  }
});

test('grep gate: no shipped command hardcodes the schema\'s full artifact-id list', () => {
  // The gate is about the CLAIM "the ids are proposal, specs, design, tasks", not about one way
  // of typing it. Backticks are decoration and a line break is whitespace, so normalise both
  // away before matching: an enumeration of three or more distinct artifact ids, joined only by
  // list punctuation or a conjunction, is the hardcoded list however it happens to be laid out.
  const IDS = ['proposal', 'specs', 'design', 'tasks'];
  const ID = `(?:${IDS.join('|')})`;
  // Separators that make a LIST. Prose between two ids ("`specs` is done or skipped — `design`")
  // is not a separator, so two ids that merely appear near each other never chain.
  const SEP = String.raw`(?:\s*,\s*(?:and|or|и|или)\s+|\s*[,;/]\s*|\s+(?:and|or|и|или)\s+)`;
  const CHAIN = new RegExp(`\\b${ID}\\b(?:${SEP}\\b${ID}\\b){2,}`, 'gi');
  const ONE_ID = new RegExp(`\\b${ID}\\b`, 'gi');

  function hardcodedIdLists(text) {
    const flat = text.replace(/`/g, '').replace(/\s+/g, ' ');
    const hits = [];
    for (const m of flat.matchAll(CHAIN)) {
      const distinct = new Set((m[0].toLowerCase().match(ONE_ID) ?? []));
      if (distinct.size >= 3) hits.push(m[0]);
    }
    return hits;
  }

  // Negative controls FIRST. Each evasion the old line-and-backtick matcher let through must
  // now fire, and legitimate two-id ownership prose must still not.
  assert.deepEqual(
    hardcodedIdLists('for `spec-driven` they are `proposal`, `specs`, `design`, `tasks`.'),
    ['proposal, specs, design, tasks'],
    'the original one-line backticked list must still be caught',
  );
  assert.deepEqual(
    hardcodedIdLists('The artifact IDs are proposal, specs, design, tasks.'),
    ['proposal, specs, design, tasks'],
    'the same claim without backticks must be caught',
  );
  assert.deepEqual(
    hardcodedIdLists('for `spec-driven` they are `proposal`, `specs`,\n`design`, `tasks`.'),
    ['proposal, specs, design, tasks'],
    'a backticked list wrapped after its second id must be caught',
  );
  assert.deepEqual(
    hardcodedIdLists('the ids are proposal, specs and design.'),
    ['proposal, specs and design'],
    'three ids joined with a conjunction must be caught',
  );
  // Legitimate ownership prose: a command naming only the two artifacts it owns.
  assert.deepEqual(hardcodedIdLists('this command owns exactly `design` and `tasks`.'), []);
  assert.deepEqual(hardcodedIdLists('This command owns `proposal` and `specs`, the two `spns-plan` does not touch.'), []);
  assert.deepEqual(hardcodedIdLists('Эта команда владеет `proposal` и `specs`.'), []);
  // Prose, not a list: two ids separated by real sentence content must not chain across it.
  assert.deepEqual(
    hardcodedIdLists('Stop when `proposal.md` exists and `specs` is `done` or `skipped` — `design` and `tasks` belong to `spns-plan`.'),
    [],
  );

  for (const lang of ['en', 'ru']) {
    const offenders = shippedCommandAndSkillText(lang)
      .flatMap((f) => hardcodedIdLists(f.text).map((hit) => `${f.path}: ${hit}`));
    assert.deepEqual(offenders, [], `${lang}: the artifact-id list is upstream's answer, not our constant`);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. The analyst-approval precondition of spns-plan (D1).
//
// Upstream's artifact `status` establishes READINESS — whether dependencies are met. It is not,
// and can never be, a record that a human approved the proposal: nothing in OpenSpec asks a
// person. The two conditions are independent and the flow needs BOTH, so the command must state
// both. Replacing the approval gate with the status check silently deletes the approval gate.
// ---------------------------------------------------------------------------------------------

const APPROVAL = {
  en: /\bapproved\b/i,
  ru: /утвержд/i,
};

function planPrecondition(lang) {
  const text = readFileSync(join(kitPath(lang), 'commands', 'spns-plan.md'), 'utf8');
  // Strip the YAML frontmatter first — its `description` says "an approved change", which would
  // make this gate pass on the word alone even with the precondition deleted. Then take
  // everything before step 0: that is the precondition block.
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  return body.split(/\n0\. /)[0];
}

test('spns-plan states the analyst-approval precondition, in BOTH kits, alongside the artifact-status check', () => {
  // Negative control FIRST: the matcher must fire on the wording that has the approval gate and
  // stay silent on a precondition that only reports artifact readiness.
  assert.equal(APPROVAL.en.test('the proposal must be APPROVED by the analyst'), true);
  assert.equal(APPROVAL.en.test('`design` must be reported `ready` (or already `done`)'), false);
  assert.equal(APPROVAL.ru.test('proposal должен быть УТВЕРЖДЁН аналитиком'), true);
  assert.equal(APPROVAL.ru.test('`design` должен быть `ready` (или уже `done`)'), false);

  for (const lang of ['en', 'ru']) {
    const pre = planPrecondition(lang);
    assert.match(pre, /status --change/, `${lang}: the artifact-status condition must stay`);
    assert.match(pre, APPROVAL[lang], `${lang}: the analyst-approval precondition must be stated in its own right`);
  }
});

// ---------------------------------------------------------------------------------------------
// 6. The cross-repo flow must not demand a delta from a skip_specs child (D3).
//
// A shared-contract story can include a child repository whose change legitimately sets
// `skip_specs: true` (a behaviour-preserving consumer refactor). Step 6a resumes that branch and
// step 6b skips creation because the folder exists — so every `instructions specs` call site has
// to read the artifact's reported state first and treat `skipped` as satisfied. Upstream returns
// instructions happily; writing the file then violates its own validator.
// ---------------------------------------------------------------------------------------------

test('every `instructions specs` call site in a shipped command is guarded by a skipped check', () => {
  const GUARD = /skipped/i;
  const WINDOW = 12; // lines of context above the call site

  function unguardedCallSites(text) {
    const lines = text.split('\n');
    const out = [];
    lines.forEach((line, i) => {
      if (!/instructions\s+specs\b/.test(line)) return;
      const above = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
      if (!GUARD.test(above)) out.push(`${i + 1}: ${line.trim()}`);
    });
    return out;
  }

  // Negative control FIRST: an unguarded call site is reported, a guarded one is not.
  assert.deepEqual(
    unguardedCallSites('run this:\n  <openspec> instructions specs --change <id> --json\n'),
    ['2: <openspec> instructions specs --change <id> --json'],
  );
  assert.deepEqual(
    unguardedCallSites('a `skipped` artifact needs no file; any other state runs:\n  <openspec> instructions specs --change <id> --json\n'),
    [],
  );

  for (const lang of ['en', 'ru']) {
    const root = kitPath(lang);
    const offenders = walk(root)
      .filter((f) => /^commands\//.test(f) && f.endsWith('.md'))
      .flatMap((f) => unguardedCallSites(readFileSync(join(root, f), 'utf8')).map((h) => `${f}:${h}`));
    assert.deepEqual(offenders, [], `${lang}: an \`instructions specs\` call that ignores a \`skipped\` specs artifact`);
  }
});
