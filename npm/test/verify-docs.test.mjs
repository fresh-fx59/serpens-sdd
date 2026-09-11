import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { resolveTool } from '../src/cli/tools.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';
import verifyDocsMain, { checkIndexInGit } from '../src/cli/verify-docs.mjs';
import { execFileSync } from 'node:child_process';

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-verify-docs-'));
  mkdirSync(join(repoRoot, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(repoRoot, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'repo.txt'), 'svc\n');
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
// generate openspec/index.{json,md} (+ repo.txt), never `git add` them, and still see verify-docs
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
  assert.ok(result.evidence.some((e) => /openspec\/index\.json: untracked/.test(e)), result.evidence.join('\n'));
  assert.ok(result.evidence.some((e) => /openspec\/index\.md: untracked/.test(e)), result.evidence.join('\n'));
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
  assert.ok(result.evidence.some((e) => /openspec\/index\.json: the working tree differs from what is staged\/committed/.test(e)), result.evidence.join('\n'));
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
  unlinkSync(join(repoRoot, 'openspec', 'repo.txt'));
  const checkResult = await run(indexCmd, indexArgs, { cwd: repoRoot });
  assert.equal(checkResult.code, 0, 'premise: index --check alone must stay green with repo.txt missing');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false, 'verify-docs must fail: repo.txt is gone from the repository');
  assert.ok(result.evidence.some((e) => /openspec\/repo\.txt: missing/.test(e)), result.evidence.join('\n'));
});

test('verify-docs still PASSES when repo.txt exists, is tracked, and matches — the new check does not regress the clean case', async () => {
  const repoRoot = makeGitRepo();
  await primeIndex(repoRoot);
  gitAddCommit(repoRoot, 'index v1');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output || result.evidence.join('\n'));
});
