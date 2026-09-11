// spec-org-facts-slice-branching-2026-09-11.md — the executable half: ONE branching-convention
// contract (tools/lib/branch-contract.sh), read by BOTH `check-git-naming.sh` and
// `repository-state.sh`'s assert-change mode, so a shop whose branches are release/<TICKET> can
// configure it once instead of the two guards silently disagreeing (§7's second finding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/run.mjs';
import { resolveTool } from '../src/cli/tools.mjs';
import { sectionAnchors, splitSections, tableCells } from '../src/testingstack.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-branch-contract-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function writeConventions(repoRoot, body) {
  const dir = join(repoRoot, 'conventions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'branching.md'), body, 'utf8');
}

const RELEASE_UNDERSCORE_CONTRACT = [
  '<!-- serpens:section branching-contract -->',
  '| Field | Value |',
  '|---|---|',
  '| `ticket-pattern` | [a-z]+_[0-9]+ |',
  '| `branch-pattern` | release/<TICKET> |',
  '',
].join('\n');

async function gitNaming(argv, cwd) {
  const { cmd, args } = resolveTool('git-naming', argv);
  return run(cmd, args, { cwd });
}

async function state(argv, cwd) {
  const { cmd, args } = resolveTool('state', argv);
  return run(cmd, args, { cwd });
}

test('no conventions file: check-git-naming.sh --branch on a long-lived branch is byte-identical to today (exempt, exit 0)', async () => {
  const repo = makeRepo();
  const result = await gitNaming(['--branch', 'main'], repo);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "✓ branch 'main' is exempt from the feature/ rule");
});

test('no conventions file: a well-formed feature/<TICKET> branch still passes, byte-identical wording', async () => {
  const repo = makeRepo();
  const result = await gitNaming(['--branch', 'feature/ABCD-1234'], repo);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "✓ branch 'feature/ABCD-1234' matches feature/<TICKET>");
});

test('no conventions file: a malformed feature/ branch still fails with the exact historical message', async () => {
  const repo = makeRepo();
  const result = await gitNaming(['--branch', 'feature/nope'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /branch name 'feature\/nope' does not match the convention/);
  assert.match(result.stderr, /expected: feature\/ABCD-1234 {2}\(uppercase project key, dash, number\)/);
  assert.match(result.stderr, /rename it: git branch -m feature\/ABCD-1234/);
});

// The adoption blocker's honest defect, spec §7's amended acceptance: with no conventions file,
// release/<TICKET> is not "exempt" (a deliberate pass) — it is silently UNCHECKED. Exit 0 stays,
// so nothing that already relies on this exit code breaks, but the wording now says the truth.
test('no conventions file: --branch release/abc_123 exits 0 and is reported as UNCHECKED, not exempt', async () => {
  const repo = makeRepo();
  const result = await gitNaming(['--branch', 'release/abc_123'], repo);
  assert.equal(result.code, 0, 'today\'s real behaviour: this must still exit 0');
  assert.match(result.stdout, /UNCHECKED/, 'must name the defect honestly');
  assert.doesNotMatch(result.stdout, /is exempt/, 'must not claim this was a deliberate exemption');
});

test('a conventions file present but with NO machine-readable anchor (the shipped, unfilled prose template) behaves exactly like no file at all', async () => {
  const repo = makeRepo();
  writeConventions(repo, '# Branching and commit conventions\n\nJust prose, no anchor here.\n');
  const result = await gitNaming(['--branch', 'release/abc_123'], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /UNCHECKED/);
});

test('a conventions file declaring release/<TICKET>: a matching branch is CHECKED and passes', async () => {
  const repo = makeRepo();
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);
  const result = await gitNaming(['--branch', 'release/abc_123'], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /matches release\/<TICKET>/);
});

test('a conventions file declaring release/<TICKET>: a malformed branch under that pattern FAILS (the trap is closed)', async () => {
  const repo = makeRepo();
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);
  const result = await gitNaming(['--branch', 'release/ABC-123'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not match the configured convention/);
});

// §7's missing negative case: check-git-naming.sh:75 used to compare branch/commit ticket
// agreement ONLY under feature/. A configured shop must get the same protection.
test('branch/commit ticket agreement still fails on a mismatch under the CONFIGURED pattern', async () => {
  const repo = makeRepo();
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);
  execFileSync('git', ['checkout', '--quiet', '-b', 'release/abc_123'], { cwd: repo });
  const msgFile = join(repo, 'MSG');
  writeFileSync(msgFile, 'feat(xyz_999): ticket does not match the branch\n', 'utf8');
  const result = await gitNaming(['--commit-msg', msgFile], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /commit ticket 'xyz_999' does not match branch ticket 'abc_123'/);
});

test('branch/commit ticket agreement passes when they DO match under the configured pattern', async () => {
  const repo = makeRepo();
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);
  execFileSync('git', ['checkout', '--quiet', '-b', 'release/abc_123'], { cwd: repo });
  const msgFile = join(repo, 'MSG');
  writeFileSync(msgFile, 'feat(abc_123): message ticket matches\n', 'utf8');
  const result = await gitNaming(['--commit-msg', msgFile], repo);
  assert.equal(result.code, 0);
});

test('malformed conventions file: wrong table column count is a fatal error naming the file and line, never a silent fallback', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    '| Field | Value | Extra |',
    '|---|---|---|',
    '| `ticket-pattern` | X | y |',
    '| `branch-pattern` | feature/<TICKET> | z |',
    '',
  ].join('\n'));
  const result = await gitNaming(['--branch', 'feature/ABCD-1234'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /conventions[/\\]branching\.md:2:/);
  assert.match(result.stderr, /row has 3 column\(s\), expected 2/);
});

test('malformed conventions file: an invalid ticket-pattern regex is a fatal, named error', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    '| `ticket-pattern` | [A-Z( |',
    '| `branch-pattern` | feature/<TICKET> |',
    '',
  ].join('\n'));
  const result = await gitNaming(['--branch', 'feature/ABCD-1234'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /conventions[/\\]branching\.md:2:/);
  assert.match(result.stderr, /not a valid regular expression/);
});

test('malformed conventions file: a branch-pattern missing the <TICKET> placeholder is a fatal, named error', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    '| `ticket-pattern` | [A-Z][A-Z0-9]+-[0-9]+ |',
    '| `branch-pattern` | feature/ABC |',
    '',
  ].join('\n'));
  const result = await gitNaming(['--branch', 'feature/ABCD-1234'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must contain exactly one <TICKET> placeholder/);
});

// ---- the ONE-contract proof: repository-state.sh reads the exact same file --------------------

test('repository-state.sh assert-change ALSO reads the conventions file: expected branch follows the configured pattern, not the hardcoded feature/', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(repo, 'openspec', 'repo.txt'), 'svc\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'onboard'], { cwd: repo });
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);

  execFileSync('git', ['checkout', '--quiet', '-b', 'release/abc_123'], { cwd: repo });
  // no remote configured — this fixture only needs to prove which branch name is EXPECTED, via
  // the error message repository-state.sh emits when the branch does not have an upstream yet.
  const wrongBranch = await state(['assert-change', 'abc_123', '--base', 'main'], repo);
  // On the correctly-named branch (still no upstream), the failure names the upstream problem —
  // proof that the earlier "expected branch" gate already passed for release/abc_123.
  assert.match(wrongBranch.stderr, /has no upstream/, wrongBranch.stderr);

  execFileSync('git', ['checkout', '--quiet', '-b', 'feature/abc_123'], { cwd: repo });
  const onOldShape = await state(['assert-change', 'abc_123', '--base', 'main'], repo);
  assert.equal(onOldShape.code, 1);
  assert.match(onOldShape.stderr, /expected branch release\/abc_123, found feature\/abc_123/,
    'repository-state.sh must expect the CONFIGURED shape, not the hardcoded feature/ default');
});

test('repository-state.sh assert-change: an invalid ticket under the configured ticket-pattern is refused before any branch check', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(repo, 'openspec', 'repo.txt'), 'svc\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'onboard'], { cwd: repo });
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);

  const result = await state(['assert-change', 'ABCD-1234', '--base', 'main'], repo); // old-shape ticket, now invalid
  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid ticket 'ABCD-1234'/);
  assert.match(result.stderr, /configured pattern/);
});

test('ONE contract: changing branch-pattern in the conventions file changes BOTH guards together', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(repo, 'openspec', 'repo.txt'), 'svc\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'onboard'], { cwd: repo });

  // Pattern A: release/<TICKET>.
  writeConventions(repo, RELEASE_UNDERSCORE_CONTRACT);
  execFileSync('git', ['checkout', '--quiet', '-b', 'release/abc_123'], { cwd: repo });
  const namingA = await gitNaming(['--branch', 'release/abc_123'], repo);
  assert.equal(namingA.code, 0);
  const stateA = await state(['assert-change', 'abc_123', '--base', 'main'], repo);
  assert.match(stateA.stderr, /has no upstream/, 'the branch shape itself must already have matched');

  // Change ONLY the pattern to hotfix/<TICKET> — one edit, both guards must follow.
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    '| `ticket-pattern` | [a-z]+_[0-9]+ |',
    '| `branch-pattern` | hotfix/<TICKET> |',
    '',
  ].join('\n'));

  const namingStillRelease = await gitNaming(['--branch', 'release/abc_123'], repo);
  assert.equal(namingStillRelease.code, 1, 'check-git-naming.sh must now reject the OLD shape');

  execFileSync('git', ['checkout', '--quiet', '-b', 'hotfix/abc_123'], { cwd: repo });
  const namingNewShape = await gitNaming(['--branch', 'hotfix/abc_123'], repo);
  assert.equal(namingNewShape.code, 0, 'check-git-naming.sh must accept the NEW shape');

  const stateNewShape = await state(['assert-change', 'abc_123', '--base', 'main'], repo);
  assert.match(stateNewShape.stderr, /has no upstream/,
    'repository-state.sh must now expect hotfix/abc_123 too — same one-line edit, both guards');
  assert.doesNotMatch(stateNewShape.stderr, /expected branch/,
    'if this fired, repository-state.sh was still expecting the OLD shape');
});

// ---- --conventions explicit override, and the resolution order ------------------------------

test('--conventions <path> is an explicit override that wins over the default path', async () => {
  const repo = makeRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'serpens-sdd-branch-contract-explicit-'));
  writeFileSync(join(elsewhere, 'custom.md'), RELEASE_UNDERSCORE_CONTRACT, 'utf8');
  const result = await gitNaming(['--branch', 'release/abc_123', '--conventions', join(elsewhere, 'custom.md')], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /matches release\/<TICKET>/);
  rmSync(elsewhere, { recursive: true, force: true });
});

// ---- the machine-readable block is NOT fenced, and the SAME scanner testingstack.mjs already
// implements (anchor + strict table, fences invisible) sees it -------------------------------

test('the branching-contract block is not fenced, and the shared scanner (src/testingstack.mjs) sees it', () => {
  const doc = [
    '# Branching and commit conventions',
    '',
    'Example shown to a human (this fenced copy must be INVISIBLE to the scanner):',
    '```',
    '<!-- serpens:section branching-contract -->',
    '| `ticket-pattern` | THIS-MUST-NOT-BE-SEEN |',
    '```',
    '',
    RELEASE_UNDERSCORE_CONTRACT,
  ].join('\n');

  const anchors = sectionAnchors(doc);
  assert.deepEqual(anchors, ['branching-contract'], 'the fenced copy must not register as a second anchor');

  const sections = splitSections(doc);
  assert.ok(sections.has('branching-contract'));
  const block = sections.get('branching-contract');
  assert.doesNotMatch(block, /THIS-MUST-NOT-BE-SEEN/, 'the real section must not include the fenced example');

  const rows = block.split('\n').map((l) => tableCells(l.trim())).filter(Boolean);
  const dataRows = rows.filter((c) => c.length === 2 && !/^\`?[Ff]ield\`?$/.test(c[0]) && !/^:?-+:?$/.test(c[0]));
  assert.deepEqual(dataRows, [
    ['`ticket-pattern`', '[a-z]+_[0-9]+'],
    ['`branch-pattern`', 'release/<TICKET>'],
  ]);
});

// ---- D1: an ungrouped ticket-pattern alternation used to escape the anchors ------------------
// spec-org-facts-slice-branching-2026-09-11.md §7, D1. BC_TICKET_RE is user-supplied and was
// spliced into the branch regex, the capture regex, and the commit-message regex WITHOUT a
// group. A ticket-pattern containing a top-level `|` therefore split the WHOLE surrounding
// regex at that `|`, detaching the `^feature/`/`$` anchors (or the `<type>(`/`)`) from every
// alternative but the last. tools/lib/branch-contract.sh:bc_compile and
// tools/check-git-naming.sh's two checks now wrap every embedding in `(...)`.

const ALTERNATION_CONTRACT = [
  '<!-- serpens:section branching-contract -->',
  '| `ticket-pattern` | AA-[0-9]+\\|BB-[0-9]+ |',
  '| `branch-pattern` | feature/<TICKET> |',
  '',
].join('\n');

test('D1 repro 1: an ungrouped alternation ticket-pattern no longer lets an unanchored junk branch through', async () => {
  const repo = makeRepo();
  writeConventions(repo, ALTERNATION_CONTRACT);
  const result = await gitNaming(['--branch', 'junkBB-42'], repo);
  assert.equal(result.code, 1, 'must be rejected: "junkBB-42" only matches the second alternative when the anchors are detached');
  assert.match(result.stderr, /does not match the configured convention/);
  // sanity: a properly anchored branch under either alternative still passes
  const okA = await gitNaming(['--branch', 'feature/AA-1'], repo);
  assert.equal(okA.code, 0);
  const okB = await gitNaming(['--branch', 'feature/BB-2'], repo);
  assert.equal(okB.code, 0);
});

test('D1 repro 2: a trailing path segment after a valid ticket no longer sneaks past the alternation-split anchor', async () => {
  const repo = makeRepo();
  writeConventions(repo, ALTERNATION_CONTRACT);
  const result = await gitNaming(['--branch', 'feature/AA-1/trailing'], repo);
  assert.equal(result.code, 1, 'must be rejected: the trailing segment only slipped through because the alternation detached the trailing $');
  assert.match(result.stderr, /does not match the configured convention/);
});

test('D1 repro 3: an incomplete commit subject no longer matches via the second half of a split alternation', async () => {
  const repo = makeRepo();
  writeConventions(repo, ALTERNATION_CONTRACT);
  const msgFile = join(repo, 'MSG');
  writeFileSync(msgFile, 'feat(AA-123\n', 'utf8'); // no closing paren, no ": message" at all
  const result = await gitNaming(['--commit-msg', msgFile], repo);
  assert.equal(result.code, 1, 'must be rejected: this used to match "^(feat|...)\\(AA-[0-9]+" with no closing requirement');
  assert.match(result.stderr, /does not match the configured convention/);
});

test('D1: repository-state.sh assert-change ALSO groups an alternation ticket-pattern (not just check-git-naming.sh)', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(repo, 'openspec', 'repo.txt'), 'svc\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'onboard'], { cwd: repo });
  writeConventions(repo, ALTERNATION_CONTRACT);

  // Ungrouped, "^AA-[0-9]+|BB-[0-9]+$" splits into "(^AA-[0-9]+)" OR "(BB-[0-9]+$)" — a junk
  // prefix in front of a BB-<digits> suffix used to slip through the second alternative.
  const result = await state(['assert-change', 'junkBB-42', '--base', 'main'], repo);
  assert.equal(result.code, 2, 'a ticket that only matches via a detached alternative must be rejected');
  assert.match(result.stderr, /invalid ticket 'junkBB-42'/);

  // sanity: a genuinely valid ticket under either alternative is still accepted here.
  const ok = await state(['assert-change', 'AA-1', '--base', 'main'], repo);
  assert.doesNotMatch(ok.stderr, /invalid ticket/);
});

test('D1: a nested-alternation ticket-pattern is fully grouped, not just at the top level', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    '| `ticket-pattern` | (AA\\|BB)-[0-9]+\\|CC-[0-9]+ |',
    '| `branch-pattern` | feature/<TICKET> |',
    '',
  ].join('\n'));
  // Every genuine alternative still passes.
  for (const good of ['feature/AA-1', 'feature/BB-2', 'feature/CC-3']) {
    const ok = await gitNaming(['--branch', good], repo);
    assert.equal(ok.code, 0, `${good} should match the configured pattern`);
  }
  // An attempt to exploit the (now inner) alternation to skip the "feature/" prefix must fail.
  const bypass = await gitNaming(['--branch', 'junkCC-9'], repo);
  assert.equal(bypass.code, 1, 'the CC-9 alternative must still require the feature/ prefix and the trailing anchor');
});

test('D1: a ticket-pattern containing a literal (escaped) $ still anchors correctly and blocks the alternation bypass', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    // AA-<digits> tickets end with a literal "$" character; BB-<digits> tickets do not.
    '| `ticket-pattern` | AA-[0-9]+\\$\\|BB-[0-9]+ |',
    '| `branch-pattern` | feature/<TICKET> |',
    '',
  ].join('\n'));
  const literalDollar = await gitNaming(['--branch', 'feature/AA-1$'], repo);
  assert.equal(literalDollar.code, 0, 'the escaped literal $ inside the ticket must still be matched as a literal character');
  const bypass = await gitNaming(['--branch', 'junkBB-42'], repo);
  assert.equal(bypass.code, 1, 'the BB alternative must still require the feature/ prefix and the trailing anchor');
});

test('D1: a ticket-pattern containing a literal (escaped) ^ still anchors correctly and blocks the alternation bypass', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    // AA tickets start with a literal "^" character; BB tickets do not.
    '| `ticket-pattern` | \\^AA-[0-9]+\\|BB-[0-9]+ |',
    '| `branch-pattern` | feature/<TICKET> |',
    '',
  ].join('\n'));
  const literalCaret = await gitNaming(['--branch', 'feature/^AA-1'], repo);
  assert.equal(literalCaret.code, 0, 'the escaped literal ^ inside the ticket must still be matched as a literal character');
  const bypass = await gitNaming(['--branch', 'junkBB-42'], repo);
  assert.equal(bypass.code, 1, 'the BB alternative must still require the feature/ prefix and the trailing anchor');
});

// ---- D2: an explicitly-named conventions file must never silently fall back to defaults ------
// spec-org-facts-slice-branching-2026-09-11.md §7, D2. "File present but no anchor" means
// UNCONFIGURED only for the DEFAULT <repo-root>/conventions/branching.md path — because
// src/stages/stage3-store.mjs installs that exact unfilled prose template on every install. An
// explicitly-named file (--conventions or SERPENS_SDD_CONVENTIONS_BRANCHING) with no valid
// anchor — including one whose anchor name is misspelled, which never matches the anchor regex
// and so looks identical to "no anchor" — is a configuration mistake and must be a fatal, named
// error, never a silent fallback to defaults.

test('D2 case 1: --conventions file with NO anchor at all is a fatal, named error (not silent defaults)', async () => {
  const repo = makeRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'serpens-sdd-branch-contract-d2-'));
  const filePath = join(elsewhere, 'custom.md');
  writeFileSync(filePath, '# just prose, no anchor\n', 'utf8');
  const result = await gitNaming(['--branch', 'feature/ABCD-1234', '--conventions', filePath], repo);
  assert.equal(result.code, 1, 'an explicitly-named file with no contract must never silently pass as "unconfigured"');
  assert.match(result.stderr, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1:`));
  assert.match(result.stderr, /no <!-- serpens:section branching-contract --> anchor found/);
  rmSync(elsewhere, { recursive: true, force: true });
});

test('D2 case 2: --conventions file with a MISSPELLED anchor (branching_contract) is the same fatal error, not silent defaults', async () => {
  const repo = makeRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'serpens-sdd-branch-contract-d2-'));
  const filePath = join(elsewhere, 'custom.md');
  writeFileSync(filePath, [
    '<!-- serpens:section branching_contract -->', // underscore, not hyphen — never matches the anchor
    '| `ticket-pattern` | [a-z]+_[0-9]+ |',
    '| `branch-pattern` | release/<TICKET> |',
    '',
  ].join('\n'), 'utf8');

  const onFeature = await gitNaming(['--branch', 'feature/ABCD-1234', '--conventions', filePath], repo);
  assert.equal(onFeature.code, 1, 'must not silently fall back to the feature/<TICKET> default');
  assert.match(onFeature.stderr, /no <!-- serpens:section branching-contract --> anchor found/);

  const onRelease = await gitNaming(['--branch', 'release/NOT_A_TICKET', '--conventions', filePath], repo);
  assert.equal(onRelease.code, 1, 'must not silently report UNCHECKED either — the user configured something and it must be honored or rejected');
  rmSync(elsewhere, { recursive: true, force: true });
});

test('D2 case 2b: SERPENS_SDD_CONVENTIONS_BRANCHING also counts as explicit provenance', async () => {
  const repo = makeRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'serpens-sdd-branch-contract-d2-'));
  const filePath = join(elsewhere, 'custom.md');
  writeFileSync(filePath, '# just prose, no anchor\n', 'utf8');
  const { cmd, args } = resolveTool('git-naming', ['--branch', 'feature/ABCD-1234']);
  const result = await run(cmd, args, { cwd: repo, env: { ...process.env, SERPENS_SDD_CONVENTIONS_BRANCHING: filePath } });
  assert.equal(result.code, 1, 'the env-var route is just as explicit as --conventions and must not fall back silently');
  assert.match(result.stderr, /no <!-- serpens:section branching-contract --> anchor found/);
  rmSync(elsewhere, { recursive: true, force: true });
});

test('D2 case 3: the DEFAULT conventions/branching.md path with NO anchor at all is still silently UNCONFIGURED (unchanged)', async () => {
  const repo = makeRepo();
  writeConventions(repo, '# just prose, no anchor — the shipped, unfilled template\n');
  const result = await gitNaming(['--branch', 'release/abc_123'], repo);
  assert.equal(result.code, 0, 'the default path must stay byte-identical: no anchor means unconfigured, not an error');
  assert.match(result.stdout, /UNCHECKED/);
});

test('D2 case 4: the DEFAULT conventions/branching.md path with an anchor present but broken inside is still fatal (unchanged)', async () => {
  const repo = makeRepo();
  writeConventions(repo, [
    '<!-- serpens:section branching-contract -->',
    '| `ticket-pattern` | X |',
    '', // branch-pattern missing
  ].join('\n'));
  const result = await gitNaming(['--branch', 'feature/ABCD-1234'], repo);
  assert.equal(result.code, 1, 'a present anchor with a broken body must already be fatal, with or without provenance');
  assert.match(result.stderr, /required field `branch-pattern` is missing/);
});
