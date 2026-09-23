import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run } from '../src/run.mjs';
import { resolveTool } from '../src/cli/tools.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';
import verifyDocsMain, { checkIndexInGit, stagedScopeDecision } from '../src/cli/verify-docs.mjs';
import { execFileSync } from 'node:child_process';
import { HARD_RULE_MARKER } from '../src/layout.mjs';

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-verify-docs-'));
  mkdirSync(join(repoRoot, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(repoRoot, 'openspec', 'changes'), { recursive: true });
  mkdirSync(join(repoRoot, 'serpens'), { recursive: true });
  writeFileSync(join(repoRoot, 'serpens', 'repo.txt'), 'svc\n');
  return repoRoot;
}

async function primeIndex(repoRoot) {
  const { cmd, args } = resolveTool('index');
  const result = await run(cmd, args, { cwd: repoRoot });
  assert.equal(result.code, 0, result.stderr);
}

test('runVerifyDocs runs all three gates (index --check, lint, split-brain) and passes on a clean repo', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output);
  const commandLines = result.evidence.filter((e) => e.startsWith('$ '));
  assert.equal(commandLines.length, 3);
  assert.ok(commandLines.some((e) => /--check/.test(e)), 'index --check should run');
  assert.ok(commandLines.some((e) => /serpens-lint\.mjs/.test(e)), 'lint should run');
  assert.ok(commandLines.some((e) => /check-contract-split-brain\.mjs/.test(e)), 'split-brain should run');
  assert.equal(result.evidence.at(-1), '✓ verify-docs passed');
});

test('a single failing gate (index drift) produces exit 1, and all three gates still ran (no short-circuit)', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);

  // Introduce drift AFTER the index was generated, without regenerating it — index --check
  // must now fail, while lint and split-brain are untouched and still run to completion.
  mkdirSync(join(repoRoot, 'openspec', 'specs', 'new-cap'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'specs', 'new-cap', 'spec.md'), '# New Cap\nSomething.\n');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false);
  const commandLines = result.evidence.filter((e) => e.startsWith('$ '));
  assert.equal(commandLines.length, 3, 'all three gates must run even though one will fail');
  assert.equal(result.evidence.at(-1), '✗ verify-docs failed — fix the errors above (each carries a remediation hint), then retry');
});

test('the CLI entry point exits 0 on pass and 1 on failure, resolving its root from cwd (not a copied script location)', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);

  const cwd = process.cwd();
  const origLog = console.log;
  let printed = '';
  process.chdir(repoRoot);
  try {
    const origWrite = process.stdout.write.bind(process.stdout);
    // Forwarded, not swallowed: `node --test` reports finished tests on this same stream, so a
    // capture that returns without writing through can silently drop a test result.
    process.stdout.write = (chunk, ...rest) => { printed += chunk; return origWrite(chunk, ...rest); };
    try {
      const code = await verifyDocsMain([]);
      assert.equal(code, 0);
    } finally {
      process.stdout.write = origWrite;
    }
  } finally {
    process.chdir(cwd);
    console.log = origLog;
  }
  assert.match(printed, /verify-docs passed/);
});


// --- fix round 3: verify-docs' index check must reflect the REPOSITORY, not just the working
// tree. gen-index.mjs --check only ever compared regenerated content to whatever is on disk;
// none of it asked git anything, so an agent (or CI, or a hook running out of order) could
// generate serpens/index.{json,md} (+ repo.txt), never `git add` them, and still see verify-docs
// pass — reproduced against a real fixture where Sonnet committed and pushed with both index
// files untracked. These tests assert the fix: untracked -> fail, tracked-but-stale -> fail,
// clean and committed -> pass.

function makeGitRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-verify-docs-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(repoRoot, 'openspec', 'changes'), { recursive: true });
  return repoRoot;
}

function gitAddCommit(repoRoot, message) {
  execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message], { cwd: repoRoot });
}

test('verify-docs FAILS when the index files are untracked, even though the content on disk is correct', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  // Deliberately NOT staged/committed — this is the exact bug: content-correct, repo-absent.

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false, 'must fail: the index exists on disk but not in the repository');
  assert.ok(result.evidence.some((e) => /serpens\/index\.json: untracked/.test(e)), result.evidence.join('\n'));
  assert.ok(result.evidence.some((e) => /serpens\/index\.md: untracked/.test(e)), result.evidence.join('\n'));
});

test('verify-docs FAILS when the index is tracked but stale relative to what is staged/committed', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  // Add a new spec and regenerate — valid content, but never re-staged.
  mkdirSync(join(repoRoot, 'openspec', 'specs', 'new-cap'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'specs', 'new-cap', 'spec.md'), '# New Cap\nSome spec content.\n');
  await primeIndex(repoRoot); // regenerates index.json/index.md on disk to match the new spec

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false, 'must fail: disk index no longer matches what is staged/committed');
  assert.ok(result.evidence.some((e) => /serpens\/index\.json: the working tree differs from what is staged\/committed/.test(e)), result.evidence.join('\n'));
});

test('verify-docs PASSES on a clean repository where the index is committed and up to date', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output || result.evidence.join('\n'));
  assert.equal(result.evidence.at(-1), '✓ verify-docs passed');
});

test('checkIndexInGit is a no-op outside a git repository (verify-docs elsewhere already tolerates a non-git root)', async () => {
  const repoRoot = makeRepo(); // the existing non-git fixture helper, unchanged
  await primeIndex(repoRoot);
  const problems = await checkIndexInGit({ repoRoot, run });
  assert.deepEqual(problems, []);
});

// Fix round 5: repo.txt is written ONLY once, on first run, and `gen-index --check` never
// compares it at all (unlike index.json/index.md, which it does regenerate-and-diff) — so a
// repository that loses its committed repo.txt (deleted, botched merge, never staged in the
// first place) previously sailed through both `index --check` AND checkIndexInGit's own
// `continue` on a missing file, reporting green forever, until a clone into a differently-named
// directory silently picked up the wrong repo name (basename(ROOT) fallback in gen-index.mjs).
test('verify-docs FAILS when repo.txt is missing, even though index --check alone stays green (it never looks at repo.txt)', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  // Prove the premise first: gen-index's own --check does not notice repo.txt's absence at all.
  const { cmd: indexCmd, args: indexArgs } = resolveTool('index', ['--check']);
  unlinkSync(join(repoRoot, 'serpens', 'repo.txt'));
  const checkResult = await run(indexCmd, indexArgs, { cwd: repoRoot });
  assert.equal(checkResult.code, 0, 'premise: index --check alone must stay green with repo.txt missing');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false, 'verify-docs must fail: repo.txt is gone from the repository');
  assert.ok(result.evidence.some((e) => /serpens\/repo\.txt: missing/.test(e)), result.evidence.join('\n'));
});

test('verify-docs still PASSES when repo.txt exists, is tracked, and matches — the new check does not regress the clean case', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output || result.evidence.join('\n'));
});

// --- --staged-scope: gap 1, serpens-openspec-coexistence-gaps-2026-09-22.md, step 3.
// A team running vanilla OpenSpec beside this kit must never have their own commit blocked by
// our full verify-docs gate firing on work we did not create. stagedScopeDecision answers
// "does the staged commit touch anything of ours?" BEFORE the full run.

function stageFile(repoRoot, relPath, content) {
  mkdirSync(join(repoRoot, dirname(relPath)), { recursive: true });
  writeFileSync(join(repoRoot, relPath), content);
  execFileSync('git', ['add', relPath], { cwd: repoRoot });
}

test('stagedScopeDecision: owned=false — a vanilla OpenSpec change staged with no .serpens.yaml is not ours', async () => {
  const repoRoot = makeGitRepo();
  stageFile(repoRoot, 'openspec/changes/vanilla-1/proposal.md', '## Why\nx\n\n## What Changes\n- y\n');
  const decision = await stagedScopeDecision({ repoRoot, run });
  assert.equal(decision.owned, false, decision.reason);
});

test('stagedScopeDecision: owned=true — a marked change (.serpens.yaml, owner: serpens-sdd) staged IS ours', async () => {
  const repoRoot = makeGitRepo();
  stageFile(repoRoot, 'openspec/changes/c1/proposal.md', '## Why\nx\n\n## What Changes\n- y\n');
  stageFile(repoRoot, 'openspec/changes/c1/.serpens.yaml', '# serpens-sdd:change-marker\nowner: serpens-sdd\n');
  const decision = await stagedScopeDecision({ repoRoot, run });
  assert.equal(decision.owned, true);
  assert.match(decision.reason, /Serpens-owned/);
});

test('stagedScopeDecision: owned=true — anything under serpens/ staged is ours', async () => {
  const repoRoot = makeGitRepo();
  stageFile(repoRoot, 'serpens/index.json', '{}');
  const decision = await stagedScopeDecision({ repoRoot, run });
  assert.equal(decision.owned, true);
});

test('stagedScopeDecision: owned=true — a root instruction file whose staged diff touches the HARD RULE block', async () => {
  const repoRoot = makeGitRepo();
  writeFileSync(join(repoRoot, 'CLAUDE.md'), '# Team\n');
  execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'claude v1'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'CLAUDE.md'), `# Team\n\n${HARD_RULE_MARKER}\nsome text\n`);
  execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repoRoot });
  const decision = await stagedScopeDecision({ repoRoot, run });
  assert.equal(decision.owned, true, decision.reason);
});

test('stagedScopeDecision: owned=false — a root instruction file edited WITHOUT touching the HARD RULE block', async () => {
  const repoRoot = makeGitRepo();
  writeFileSync(join(repoRoot, 'CLAUDE.md'), `# Team\n\n${HARD_RULE_MARKER}\nsome text\n`);
  execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'claude v1'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'CLAUDE.md'), `# Team\n\n${HARD_RULE_MARKER}\nsome text\n\n## Unrelated team section\nmore team prose\n`);
  execFileSync('git', ['add', 'CLAUDE.md'], { cwd: repoRoot });
  const decision = await stagedScopeDecision({ repoRoot, run });
  assert.equal(decision.owned, false, decision.reason);
});

test('stagedScopeDecision: owned=false — nothing staged at all', async () => {
  const repoRoot = makeGitRepo();
  const decision = await stagedScopeDecision({ repoRoot, run });
  assert.equal(decision.owned, false);
});

test('verify-docs --staged-scope: a vanilla-only staged change exits 0 and prints the skipped line, without running the full gate', async () => {
  const repoRoot = makeGitRepo();
  stageFile(repoRoot, 'openspec/changes/vanilla-1/proposal.md', 'not even valid — the full gate would fail this');

  const cwd = process.cwd();
  process.chdir(repoRoot);
  let printed = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { printed += chunk; return origWrite(chunk, ...rest); };
  let code;
  try {
    code = await verifyDocsMain(['--staged-scope']);
  } finally {
    process.stdout.write = origWrite;
    process.chdir(cwd);
  }
  assert.equal(code, 0, printed);
  assert.match(printed, /no Serpens-owned path staged — skipped/);
});

test('verify-docs --staged-scope: a marked change staged runs the FULL gate (and fails on real content problems)', async () => {
  const repoRoot = makeGitRepo();
  stageFile(repoRoot, 'openspec/changes/c1/.serpens.yaml', '# serpens-sdd:change-marker\nowner: serpens-sdd\n');
  // Index drift alone is no longer a reliable failure signal here — verify-docs now auto-fixes
  // it (see the auto-fix tests below). Force an independent, unfixable failure instead: mark
  // this repo as the system store (mandatory port-facts.md) without writing that file.
  mkdirSync(join(repoRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(repoRoot, '.openspec-store', 'store.yaml'), 'schema_version: 1\n');
  execFileSync('git', ['add', '.openspec-store/store.yaml'], { cwd: repoRoot });

  const cwd = process.cwd();
  process.chdir(repoRoot);
  let code;
  try {
    code = await verifyDocsMain(['--staged-scope']);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(code, 1);
});

test('verify-docs with NO flag always runs the full gate, even on an all-vanilla staged set', async () => {
  const repoRoot = makeGitRepo();
  stageFile(repoRoot, 'openspec/changes/vanilla-1/proposal.md', 'not even valid');
  // Index drift alone is no longer a reliable failure signal (auto-fix handles it) — force an
  // independent, unfixable failure: system-store signal present, port-facts.md absent.
  mkdirSync(join(repoRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(repoRoot, '.openspec-store', 'store.yaml'), 'schema_version: 1\n');
  execFileSync('git', ['add', '.openspec-store/store.yaml'], { cwd: repoRoot });

  const cwd = process.cwd();
  process.chdir(repoRoot);
  let code;
  try {
    code = await verifyDocsMain([]);
  } finally {
    process.chdir(cwd);
  }
  // port-facts.md is missing entirely and this repo is the system store — the full (unscoped)
  // gate must fail regardless of what is staged, and regardless of the index auto-fix.
  assert.equal(code, 1);
});

// --- Auto-fix (operator decision, 2026-09-23): a vanilla `openspec archive <change> --yes`
// merges a delta into openspec/specs/ but never regenerates serpens/index.{json,md}. That
// archive commit isn't Serpens work, so it passes unchecked. The NEXT commit that touches
// Serpens-owned paths must not be blocked by drift someone else's commit introduced — verify-docs
// should regenerate the index and stage it itself, then proceed, rather than refuse.

test('verify-docs auto-fixes stale index drift caused by a vanilla archive commit, and stages the regenerated files', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  // Simulate a vanilla `openspec archive --yes`: a new spec lands in openspec/specs/ and gets
  // committed WITHOUT anyone regenerating serpens/index.{json,md} — the exact defect reproduced
  // 2026-09-23 against real OpenSpec 1.13.1 + lefthook.
  mkdirSync(join(repoRoot, 'openspec', 'specs', 'new-cap'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'specs', 'new-cap', 'spec.md'), '# New Cap\nSome spec content.\n');
  gitAddCommit(repoRoot, 'vanilla archive: new-cap (index not regenerated)');

  // Premise: index --check alone is red (the un-fixed drift this defect leaves behind).
  const { cmd: indexCmd, args: indexArgs } = resolveTool('index', ['--check']);
  const premise = await run(indexCmd, indexArgs, { cwd: repoRoot });
  assert.equal(premise.code, 1, 'premise: drift must exist before verify-docs runs');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output || result.evidence.join('\n'));
  assert.ok(
    result.evidence.includes('index was stale (specs changed outside Serpens) — regenerated and staged'),
    result.evidence.join('\n'),
  );

  // The regenerated index files must now be STAGED (not merely correct on disk) — otherwise the
  // commit that follows would reproduce the very bug this fix closes.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(staged, /serpens\/index\.json/);
  assert.match(staged, /serpens\/index\.md/);

  // And index --check now genuinely passes — not just reported green.
  const recheck = await run(indexCmd, indexArgs, { cwd: repoRoot });
  assert.equal(recheck.code, 0, recheck.stderr);
});

test('verify-docs auto-fix regenerates even a hand-edited index (it is a generated file either way)', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  // Hand-edit the committed index directly (no spec change at all) — still just drift from the
  // regenerated truth, and still safe to overwrite: nothing here is hand-authored content.
  writeFileSync(join(repoRoot, 'serpens', 'index.md'), '# tampered\n');
  gitAddCommit(repoRoot, 'hand-edited index.md');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output || result.evidence.join('\n'));
  assert.ok(
    result.evidence.includes('index was stale (specs changed outside Serpens) — regenerated and staged'),
    result.evidence.join('\n'),
  );
});

test('verify-docs does NOT auto-fix outside a git repository — original drift failure stands, no extra gate call', async () => {
  const repoRoot = makeRepo(); // no `git init` at all
  await primeIndex(repoRoot);

  mkdirSync(join(repoRoot, 'openspec', 'specs', 'new-cap'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'specs', 'new-cap', 'spec.md'), '# New Cap\nSomething.\n');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false);
  const commandLines = result.evidence.filter((e) => e.startsWith('$ '));
  assert.equal(commandLines.length, 3, 'no git repo — auto-fix must not attempt a regen call');
  assert.ok(
    !result.evidence.includes('index was stale (specs changed outside Serpens) — regenerated and staged'),
  );
});

test('verify-docs does NOT auto-fix when the index was never committed — a missing index is a real failure', async () => {
  const repoRoot = makeGitRepo();
  // No primeIndex: the repo never generated or committed serpens/index.json (install or archive
  // unfinished). Auto-creating it here would hide that — tools-parity-test caught this regression.
  mkdirSync(join(repoRoot, 'openspec', 'specs', 'new-cap'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'specs', 'new-cap', 'spec.md'), '# New Cap\nSomething.\n');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false);
  assert.ok(
    !result.evidence.includes('index was stale (specs changed outside Serpens) — regenerated and staged'),
  );
  assert.ok(!existsSync(join(repoRoot, 'serpens', 'index.json')), 'must not create an index from nothing');
});
