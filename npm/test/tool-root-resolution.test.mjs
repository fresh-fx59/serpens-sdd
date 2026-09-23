import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '..', 'tools');

// The bug this file guards against (weak-model gate, fix round 2): `serpens-sdd index` run from
// inside a NESTED subdirectory (e.g. openspec/) used to resolve its root from the raw process
// cwd, silently creating a phantom `openspec/serpens/repo.txt` and exiting 0 — a command that
// corrupts a repository's layout while reporting success. gen-index.mjs, serpens-lint.mjs and
// check-contract-split-brain.mjs all shared the identical `resolve(argv[2] ?? '.')` default;
// all three now fall back to `git rev-parse --show-toplevel` (like check-openspec-root.sh and
// repository-state.sh already did) instead of the bare cwd. Tested here by invoking the raw
// scripts directly (bypassing the CLI's own runTool cwd-fix entirely) — the worst case, and the
// one a model reaching for a bare script path would hit.

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'serpens-sdd-root-resolution-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
  mkdirSync(join(repo, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(repo, 'openspec', 'changes'), { recursive: true });
  return repo;
}

test('gen-index.mjs run from a nested openspec/ subdirectory writes the index at the repo root, not a nested phantom store', () => {
  const repo = makeRepo();
  const nested = join(repo, 'openspec');
  execFileSync(process.execPath, [join(TOOLS_DIR, 'gen-index.mjs')], { cwd: nested });

  assert.ok(existsSync(join(repo, 'serpens', 'index.json')), 'index.json must land at the real repo root');
  assert.ok(existsSync(join(repo, 'serpens', 'index.md')), 'index.md must land at the real repo root');
  assert.ok(!existsSync(join(repo, 'openspec', 'openspec')), 'must NOT create a nested openspec/openspec/ phantom store');
});

test('gen-index.mjs --check from a nested subdirectory checks the real root\'s index, not a phantom one', () => {
  const repo = makeRepo();
  execFileSync(process.execPath, [join(TOOLS_DIR, 'gen-index.mjs')], { cwd: repo });
  const nested = join(repo, 'openspec');
  // Nothing changed since the write above -> --check from the nested dir must still see the
  // real root's index as current (exit 0), never regenerate/diff against a phantom empty one.
  execFileSync(process.execPath, [join(TOOLS_DIR, 'gen-index.mjs'), '--check'], { cwd: nested });
  assert.ok(!existsSync(join(repo, 'openspec', 'openspec')), 'must NOT create a nested openspec/openspec/ phantom store');
});

test('serpens-lint.mjs run from a nested subdirectory lints the real repo root, not a phantom one', () => {
  const repo = makeRepo();
  const nested = join(repo, 'openspec');
  const result = execFileSync(process.execPath, [join(TOOLS_DIR, 'serpens-lint.mjs')], { cwd: nested, encoding: 'utf8' });
  assert.match(result, /passed/);
});

test('check-contract-split-brain.mjs run from a nested subdirectory checks the real repo root, not a phantom one', () => {
  const repo = makeRepo();
  const nested = join(repo, 'openspec');
  const result = execFileSync(process.execPath, [join(TOOLS_DIR, 'check-contract-split-brain.mjs')], { cwd: nested, encoding: 'utf8' });
  assert.match(result, /nothing to check|no references declared/);
});

test('an explicit positional root still wins over cwd for all three (no behavior change for existing callers)', () => {
  const repo = makeRepo();
  const elsewhere = mkdtempSync(join(tmpdir(), 'serpens-sdd-root-resolution-elsewhere-'));
  execFileSync(process.execPath, [join(TOOLS_DIR, 'gen-index.mjs'), repo], { cwd: elsewhere });
  assert.ok(existsSync(join(repo, 'serpens', 'index.json')), 'explicit positional root must still be honored');
});

// A globally-installed CLI is normally run OUTSIDE any git repository, and `findGitRoot` is
// built for that: it catches git's failure and falls back to the directory it was given. What it
// did not do was silence git's own `fatal: not a git repository` on stderr — so
// `serpens-sdd version` in /tmp printed the edition, exited 0, and ALSO printed a fatal error.
// Found by installing the real tarball into a temp prefix and running it from /tmp, which is the
// only way this shows up: inside the repo, git succeeds and there is nothing to see.
test('findGitRoot outside a git repository is silent on stderr, not just correct', () => {
  const outside = mkdtempSync(join(tmpdir(), 'serpens-no-git-'));
  const cli = fileURLToPath(new URL('../bin/serpens-sdd.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'version'], { cwd: outside, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d{4}-\d{2}-\d{2}\.\d+$/, 'the edition still goes to stdout');
  assert.equal(r.stderr.trim(), '',
    `nothing may reach stderr on a successful run; got: ${r.stderr.trim()}`);
  rmSync(outside, { recursive: true, force: true });
});

// Step 6 (gap 3): a repo-local install (serpens/topology = `repo-local`) has no store, so the two
// store-only tools must refuse with a clear message instead of guessing a store path.
function makeRepoLocalRepo() {
  const repo = makeRepo();
  mkdirSync(join(repo, 'serpens'), { recursive: true });
  writeFileSync(join(repo, 'serpens', 'topology'), 'repo-local\n');
  return repo;
}

test('catalog (aggregate-index.mjs) in a repo-local repository exits non-zero and says why', () => {
  const repo = makeRepoLocalRepo();
  const r = spawnSync(process.execPath, [join(TOOLS_DIR, 'aggregate-index.mjs')], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /repo-local/);
  assert.match(r.stderr, /no system store/);
  assert.equal(existsSync(join(repo, 'serpens', 'catalog.json')), false);
});

test('sync-submodules.sh in a repo-local repository exits non-zero and says why', () => {
  const repo = makeRepoLocalRepo();
  const r = spawnSync('bash', [join(TOOLS_DIR, 'sync-submodules.sh'), '--repos-from', '-', '--store-root', repo],
    { cwd: repo, encoding: 'utf8', input: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /repo-local/);
  assert.equal(existsSync(join(repo, '.gitmodules')), false);
});

test('git-naming reads serpens/branching.md from the repository itself (repo-local facts, no env var)', () => {
  const repo = makeRepoLocalRepo();
  writeFileSync(join(repo, 'serpens', 'branching.md'), [
    '# Branching', '', '<!-- serpens:section branching-contract -->',
    '| Field | Value |', '|---|---|',
    '| `ticket-pattern`   | [A-Z][A-Z0-9]+-[0-9]+ |',
    '| `branch-pattern`   | story/<TICKET> |',
    '| `commit-types`     | feat,fix |',
    '| `exempt-branches`  | ^(main)$ |', '',
  ].join('\n'));
  execFileSync('git', ['add', 'serpens/'], { cwd: repo }); // owned path staged → Serpens work
  const env = { ...process.env };
  delete env.SERPENS_SDD_CONVENTIONS_BRANCHING;
  execFileSync('git', ['checkout', '-q', '-b', 'story/ABCD-1'], { cwd: repo });
  const good = spawnSync('bash', [join(TOOLS_DIR, 'check-git-naming.sh'), '--branch'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(good.status, 0, good.stderr);
  execFileSync('git', ['checkout', '-q', '-b', 'feature/ABCD-1'], { cwd: repo });
  const bad = spawnSync('bash', [join(TOOLS_DIR, 'check-git-naming.sh'), '--branch'], { cwd: repo, encoding: 'utf8', env });
  assert.notEqual(bad.status, 0, 'the built-in feature/<TICKET> default must NOT apply once the repo has its own contract');
});
