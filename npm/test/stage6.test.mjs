import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { kitPath } from '../src/integrity.mjs';
import { loadPort } from '../src/ports.mjs';
import { installCommands, substituteTokens } from '../src/stages/stage6-install.mjs';
import { unfilledCount } from '../src/portfacts.mjs';
import {
  validateTestingStack, sectionAnchors, splitSections, REQUIRED_SECTIONS,
} from '../src/testingstack.mjs';
import { fillTestingStack, fillTestingStackText } from './helpers/testing-stack.mjs';
import { SHIM_INVOCATION } from '../src/shim.mjs';
import { resolveTool } from '../src/cli/tools.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';

const KIT_DIR = kitPath('en');
const OPENSPEC_INVOCATION = 'npx @fission-ai/openspec@1.10.3';

/**
 * A store fixture shaped like the one stage 3 leaves behind: a real git repository (stage 6 now
 * writes `git config serpens.agentDir` into it on a user-scope install), optionally with submodule
 * rows in `.gitmodules` and the matching directories on disk — the project-scope install
 * targets, per spec §5.4 ("in the store and in every onboarded submodule").
 */
function baseCtx({ submodules = [], ...overrides } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage6-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage6-home-'));
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage6-store-'));
  execFileSync('git', ['init', '-q'], { cwd: storeRoot });
  if (submodules.length) {
    writeFileSync(join(storeRoot, '.gitmodules'), submodules.map((name) => [
      `[submodule "submodules/${name}"]`,
      `\tpath = submodules/${name}`,
      `\turl = ssh://git@forge/proj/${name}.git`,
      '\tbranch = main',
    ].join('\n')).join('\n') + '\n', 'utf8');
    for (const name of submodules) mkdirSync(join(storeRoot, 'submodules', name), { recursive: true });
  }
  return {
    config: {
      openspec: { invocation: OPENSPEC_INVOCATION, pinned_version: '1.10.3' },
      store: { id: 'acme-store' },
      facts: { repository_source: 'manual' },
    },
    run,
    kitDir: KIT_DIR,
    repoRoot,
    home,
    storeRoot,
    submodules,
    ...overrides,
  };
}

test('substituteTokens replaces both tokens and leaves other text untouched', () => {
  // `serpensSdd` is the RESOLVED invocation, which for every real install is the shim stages 3 and 5
  // wrote — never a bare `serpens-sdd`, which is not on PATH in a devDependency or `npx` shop.
  const text = 'run <openspec> new change x, then <serpens-sdd> verify-docs.';
  const out = substituteTokens(text, { openspec: 'npx @fission-ai/openspec@1.10.3', serpensSdd: SHIM_INVOCATION });
  assert.equal(out, `run npx @fission-ai/openspec@1.10.3 new change x, then ${SHIM_INVOCATION} verify-docs.`);
});

test('commands land in the port layout with the right names for a flat-prefixed port', async () => {
  const port = loadPort({ id: 'gigacode' });
  const ctx = baseCtx({ port });
  const result = await installCommands(ctx);
  assert.equal(result.ok, true, result.error);

  // gigacode: scope_preference [user, project] and $HOME/.gigacode is writable in this fixture,
  // so user scope wins.
  const commandDir = join(ctx.home, '.gigacode', 'commands');
  const expected = [
    'spns-archive.md', 'spns-autotest.md', 'spns-implement.md', 'spns-plan.md',
    'spns-review.md', 'spns-spec.md', 'spns-test-plan.md',
  ];
  const actual = readdirSync(commandDir).sort();
  assert.deepEqual(actual, expected.sort());
  assert.equal(actual.length, 7);
});

test('a project-scope port installs into the store AND every onboarded submodule, never the cwd', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port, submodules: ['svc-a', 'svc-b'] });
  const result = await installCommands(ctx);
  assert.equal(result.ok, true, result.error);

  // claude: scope_preference [project] only -> spec §5.4's "<repo>/<agent_dir> in the store and
  // in every onboarded submodule".
  const expected = ['archive.md', 'autotest.md', 'implement.md', 'plan.md', 'review.md', 'spec.md', 'test-plan.md'].sort();
  for (const root of [ctx.storeRoot, join(ctx.storeRoot, 'submodules', 'svc-a'), join(ctx.storeRoot, 'submodules', 'svc-b')]) {
    const subdir = join(root, '.claude', 'commands', 'spns');
    assert.ok(existsSync(join(subdir, 'spec.md')), `expected .claude/commands/spns/spec.md in ${root}`);
    assert.deepEqual(readdirSync(subdir).sort(), expected);
    assert.deepEqual(readdirSync(join(root, '.claude', 'skills')).sort(), [
      'spns-code-review', 'spns-debugging', 'spns-drill-down',
      'spns-repository-state', 'spns-tdd', 'spns-verification',
    ], `expected all six skills installed in ${root}`);
  }

  // and NOT into the directory the CLI happened to be invoked from
  assert.equal(existsSync(join(ctx.repoRoot, '.claude')), false,
    'the CLI working directory must never be an install target');
});

test('both tokens are substituted and neither survives', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port });
  const result = await installCommands(ctx);
  assert.equal(result.ok, true, result.error);

  const commandDir = join(ctx.storeRoot, '.claude', 'commands');
  const proof = await run('grep', ['-rnE', '<openspec>|<serpens-sdd>', commandDir]);
  assert.equal(proof.code, 1, `expected grep to find zero matches (exit 1), got exit ${proof.code}:\n${proof.stdout}`);

  const specText = readFileSync(join(commandDir, 'spns', 'spec.md'), 'utf8');
  assert.ok(specText.includes(OPENSPEC_INVOCATION), 'the resolved openspec invocation should appear in the installed command');
  assert.ok(!specText.includes('<openspec>'), 'no <openspec> token should survive');
});

test('with no serpens_sdd.invocation configured, <serpens-sdd> resolves to the shim — never a bare serpens-sdd', async () => {
  // The regression this guards: stage 6 used to default to the string `serpens-sdd`, so every
  // installed command called a binary that is on PATH only in a global install, while stage 5
  // wrote the hooks through the shim. One install, two disagreeing call routes.
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port });
  assert.equal(ctx.config.serpens_sdd, undefined, 'this fixture must NOT configure an invocation');
  const result = await installCommands(ctx);
  assert.equal(result.ok, true, result.error);

  const specText = readFileSync(join(ctx.storeRoot, '.claude', 'commands', 'spns', 'spec.md'), 'utf8');
  assert.ok(specText.includes(`${SHIM_INVOCATION} state prepare-base`),
    `the installed command should call the shim, got:\n${specText.split('\n').filter((l) => l.includes('prepare-base')).join('\n')}`);
  assert.ok(!/(^|[^/])\bserpens-sdd (verify-docs|state|index|lint|git-naming|catalog)\b/m.test(
    specText.replace(new RegExp(SHIM_INVOCATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '@SHIM@')),
  'no bare `serpens-sdd <subcommand>` call may survive in an installed command');
});

test('an explicitly configured serpens_sdd.invocation overrides the shim default', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port });
  ctx.config.serpens_sdd = { invocation: 'my-wrapper serpens-sdd' };
  const result = await installCommands(ctx);
  assert.equal(result.ok, true, result.error);
  const specText = readFileSync(join(ctx.storeRoot, '.claude', 'commands', 'spns', 'spec.md'), 'utf8');
  assert.ok(specText.includes('my-wrapper serpens-sdd state prepare-base'), 'the configured invocation should win');
  assert.ok(!specText.includes(SHIM_INVOCATION), 'the shim default must not also appear');
});

test('a port with commands_supported:false stops instead of guessing a location', async () => {
  const port = loadPort({ id: 'codex' });
  const ctx = baseCtx({ port });
  const result = await installCommands(ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /codex/);
  assert.match(result.error, /commands_supported/);
});

test('a port with skills_supported:false stops rather than inlining skill bodies', async () => {
  const port = { ...loadPort({ id: 'claude' }), skills_supported: false };
  const ctx = baseCtx({ port });
  const result = await installCommands(ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /claude/);
  assert.match(result.error, /skills_supported/);
});

test('dryRun writes nothing', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port, dryRun: true });
  const result = await installCommands(ctx);
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(ctx.repoRoot, '.claude')), false);
  assert.equal(existsSync(join(ctx.storeRoot, '.claude')), false);
});

test('serpens/testing-stack.md lands in each onboarded submodule (never the store, never the cwd), unanswered, and a re-run keeps every answer', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port, submodules: ['svc-a'] });
  const first = await installCommands(ctx);
  assert.equal(first.ok, true, first.error);

  const dest = join(ctx.storeRoot, 'submodules', 'svc-a', 'serpens', 'testing-stack.md');
  assert.equal(existsSync(join(ctx.repoRoot, 'serpens', 'testing-stack.md')), false,
    'the CLI working directory must never receive testing-stack.md');
  assert.equal(existsSync(join(ctx.storeRoot, 'serpens', 'testing-stack.md')), false,
    'the store is not a spoke — verify-docs treats testing-stack.md as spoke-only');
  assert.ok(existsSync(dest));
  const firstText = readFileSync(dest, 'utf8');
  assert.match(firstText, /^STATUS: PARTIAL — \d+ unanswered facts$/m);
  assert.match(firstText, /^UNFILLED — /m);
  // The file a fresh install writes must FAIL the gate — the whole point of moving from marker
  // counting to schema validation was that the untouched template used to pass.
  assert.equal(validateTestingStack(firstText).ok, false);
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(sectionAnchors(firstText).includes(section.key), `fresh install must ship section ${section.key}`);
  }

  // The team fills it in; a second install must not clobber one word of that work.
  const filled = fillTestingStack(dest);
  const second = await installCommands(ctx);
  assert.equal(second.ok, true, second.error);
  assert.equal(readFileSync(dest, 'utf8'), filled, 'a schema-current filled file is left byte-identical');
});

test('a filled file from an OLDER edition gains the sections it lacks, unanswered, with no answer overwritten', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port, submodules: ['svc-a'] });
  assert.equal((await installCommands(ctx)).ok, true);
  const dest = join(ctx.storeRoot, 'submodules', 'svc-a', 'serpens', 'testing-stack.md');

  // Stand in for edition 2026-09-09.1's file: the four original sections, fully answered, and
  // no `manual-access` section at all — because that edition did not have one. `stage6-install`
  // never overwrites an existing file, so without an upgrade path this repository could never
  // reach the current schema and would fail the gate forever.
  const template = readFileSync(join(KIT_DIR, 'templates', 'testing-stack.md'), 'utf8');
  const sections = splitSections(template);
  const older = ['# Testing stack — svc-a (recorded 2026-09-09)', '',
    ...['fast-tier', 'slow-tier', 'wiring-bugs', 'debugging-order'].map((k) => sections.get(k))].join('\n');
  const olderFilled = fillTestingStackText(older);
  writeFileSync(dest, olderFilled, 'utf8');

  const upgraded = await installCommands(ctx);
  assert.equal(upgraded.ok, true, upgraded.error);
  const text = readFileSync(dest, 'utf8');

  // Every answer the team wrote survives, verbatim.
  for (const line of olderFilled.split('\n').filter((l) => l.trim())) {
    assert.ok(text.includes(line), `the upgrade dropped a line the team wrote: ${line}`);
  }
  // And the missing section arrived, unanswered, so the gate now names it instead of passing.
  assert.ok(sectionAnchors(text).includes('manual-access'));
  const problems = validateTestingStack(text).problems.join('\n');
  assert.match(problems, /manual-access|slot `request-client`/);
  assert.equal(validateTestingStack(text).ok, false,
    'an appended section must be UNANSWERED — an upgrade that silently passes the gate answers nothing');

  // Filling in only the appended section closes the gate; the run is idempotent from there.
  fillTestingStack(dest);
  const again = await installCommands(ctx);
  assert.equal(again.ok, true, again.error);
  assert.equal(validateTestingStack(readFileSync(dest, 'utf8')).ok, true);
});

test('a second call on an already-installed port writes cleanly and stays green', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port });
  const first = await installCommands(ctx);
  assert.equal(first.ok, true, first.error);
  const second = await installCommands(ctx);
  assert.equal(second.ok, true, second.error);
  const commandDir = join(ctx.storeRoot, '.claude', 'commands');
  const proof = await run('grep', ['-rnE', '<openspec>|<serpens-sdd>', commandDir]);
  assert.equal(proof.code, 1);
});

test('a leftover unresolved token in the installed command directory fails the proof, naming it', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port });
  // Plant a bogus file directly where the proof scans, simulating an unsubstituted token that
  // slipped through (e.g. a hand-edited file, or a future command shipping <serpens-sdd> before
  // this port resolves it).
  const commandDir = join(ctx.storeRoot, '.claude', 'commands');
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(join(commandDir, 'leftover.md'), 'still has <serpens-sdd> unresolved\n', 'utf8');

  const result = await installCommands(ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /leftover\.md/);
  assert.match(result.error, /<serpens-sdd>/);
});

test('a leftover unresolved token in the installed skill directory fails the proof, naming it', async () => {
  const port = loadPort({ id: 'claude' });
  const ctx = baseCtx({ port });
  // Same simulation, but in the skill tree — the proof must cover both installed directories,
  // not only the command directory.
  const skillsRoot = join(ctx.storeRoot, '.claude', 'skills');
  mkdirSync(join(skillsRoot, 'spns-bogus'), { recursive: true });
  writeFileSync(join(skillsRoot, 'spns-bogus', 'SKILL.md'), 'still has <openspec> unresolved\n', 'utf8');

  const result = await installCommands(ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /spns-bogus/);
  assert.match(result.error, /<openspec>/);
});

test('end-to-end: the real install produces a port-facts.md that gates verify-docs, and clearing it un-gates', async () => {
  const port = loadPort({ id: 'gigacode' });
  const ctx = baseCtx({ port });

  const result = await installCommands(ctx);
  assert.equal(result.ok, true, result.error);

  const portFactsPath = join(ctx.storeRoot, 'serpens', 'port-facts.md');
  const rendered = readFileSync(portFactsPath, 'utf8');
  assert.match(rendered, /^STATUS: PARTIAL — 4 UNFILLED sections/m);
  assert.match(rendered, new RegExp(OPENSPEC_INVOCATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rendered, /\| P1 \|/);
  assert.equal(unfilledCount(rendered), 4);

  // Prime the store as a valid OpenSpec/index root so the other three verify-docs gates start
  // green, isolating what the UNFILLED gate itself decides.
  mkdirSync(join(ctx.storeRoot, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(ctx.storeRoot, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(ctx.storeRoot, 'serpens', 'repo.txt'), 'store\n', 'utf8');
  const { cmd: indexCmd, args: indexArgs } = resolveTool('index');
  const indexed = await run(indexCmd, indexArgs, { cwd: ctx.storeRoot });
  assert.equal(indexed.code, 0, indexed.stderr);

  // Stage the index files this test just generated — verify-docs' own index check (fix round 3)
  // now also requires them tracked, not merely present on disk. This test isolates the
  // port-facts.md UNFILLED gate specifically, so staging (never committing) here keeps that
  // isolation: the index git-tracking check itself is covered separately by
  // test/verify-docs.test.mjs.
  execFileSync('git', ['add', '-A'], { cwd: ctx.storeRoot });

  const gated = await runVerifyDocs({ repoRoot: ctx.storeRoot });
  assert.equal(gated.ok, false);
  const gatedCombined = gated.evidence.join('\n') + gated.output;
  assert.match(gatedCombined, /port-facts\.md/);
  assert.match(gatedCombined, /4 UNFILLED/);

  // The operator fills in every previously-UNFILLED section by hand; the P-rows this run
  // proved are untouched.
  const filled = rendered
    .replace(/^STATUS: PARTIAL — 4 UNFILLED sections$/m, 'STATUS: DONE')
    .replace(/^UNFILLED — the tracker name.*$/m, 'AcmeTrack, via the internal MCP tracker-bridge tool.')
    .replace(/^UNFILLED — the forge name.*$/m, 'internal GitLab instance, project acme/billing.')
    .replace(/^UNFILLED — the MCP tool names.*$/m, 'repo-bindings, tracker-bridge, wiki-search, code-search.')
    .replace(/^UNFILLED — the fast and slow testing tiers.*$/m, 'fast: `npm test`; slow: `npm run test:e2e`.');
  assert.equal(unfilledCount(filled), 0, 'the hand-filled fixture must itself carry zero UNFILLED markers');
  writeFileSync(portFactsPath, filled, 'utf8');

  const ungated = await runVerifyDocs({ repoRoot: ctx.storeRoot });
  assert.equal(ungated.ok, true, ungated.output);
});
