import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPort } from '../src/ports.mjs';
import { resolveScope, assertLintScope } from '../src/scope.mjs';
import { run } from '../src/run.mjs';

const gigacode = () => loadPort({ id: 'gigacode' });
const isRoot = process.getuid?.() === 0;

test('gigacode is the qwen layout in its own home', () => {
  const g = gigacode(), q = loadPort({ id: 'qwen' });
  assert.equal(g.agent_dir, '.gigacode');
  assert.equal(g.instruction_file, 'GIGACODE.md');
  for (const k of ['command_dir', 'command_layout', 'command_format', 'skill_dir', 'skill_layout']) {
    assert.equal(g[k], q[k], `layout field ${k} must match qwen`);
  }
});

test('user scope wins when the home is writable', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const r = resolveScope(gigacode(), { home, repoRoot: '/repo' });
  assert.equal(r.scope, 'user');
  assert.equal(r.agentRoot, join(home, '.gigacode'));
});

test('a real write probe, not a stat, decides — read-only home falls back to project, untouched', { skip: isRoot }, () => {
  const home = mkdtempSync(join(tmpdir(), 'home-ro-'));
  mkdirSync(join(home, '.gigacode'));
  chmodSync(join(home, '.gigacode'), 0o500);
  const r = resolveScope(gigacode(), { home, repoRoot: '/repo' });
  assert.equal(r.scope, 'project');
  assert.match(r.reason, /not writable/);
  // a pre-existing directory is never removed, whether or not it was chosen
  assert.equal(existsSync(join(home, '.gigacode')), true);
  chmodSync(join(home, '.gigacode'), 0o700); // restore so temp cleanup can remove it
});

test('--port-scope user fails instead of falling back', { skip: isRoot }, () => {
  const home = mkdtempSync(join(tmpdir(), 'home-ro2-'));
  mkdirSync(join(home, '.gigacode'));
  chmodSync(join(home, '.gigacode'), 0o500);
  assert.throws(() => resolveScope(gigacode(), { home, repoRoot: '/repo', force: 'user' }),
    (e) => e.exitCode === 3);
  chmodSync(join(home, '.gigacode'), 0o700);
});

test('a port preferring project-only scope resolves to the repo, never touching $HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-projonly-'));
  const port = { ...gigacode(), scope_preference: ['project'] };
  const r = resolveScope(port, { home, repoRoot: '/repo' });
  assert.equal(r.scope, 'project');
  assert.equal(r.agentRoot, join('/repo', '.gigacode'));
  assert.equal(existsSync(join(home, '.gigacode')), false);
});

test('a home path that does not exist yet still resolves user scope by creating it', () => {
  const parent = mkdtempSync(join(tmpdir(), 'home-parent-'));
  const home = join(parent, 'nested', 'does-not-exist-yet');
  const r = resolveScope(gigacode(), { home, repoRoot: '/repo' });
  assert.equal(r.scope, 'user');
  assert.equal(r.agentRoot, join(home, '.gigacode'));
  assert.equal(existsSync(r.agentRoot), true);
});

test('resolveScope removes a directory it created when the write probe fails and project scope wins', { skip: isRoot }, () => {
  const home = mkdtempSync(join(tmpdir(), 'home-umask-'));
  const port = { ...gigacode(), scope_preference: ['user', 'project'] };
  // force mkdirSync to create $HOME/.gigacode with mode 000: mkdir itself succeeds (home's
  // own permissions govern that), but the freshly-created directory is then unwritable (and
  // untraversable) even to its own owner, so the probe write genuinely fails.
  const before = process.umask(0o777);
  let r;
  try {
    r = resolveScope(port, { home, repoRoot: '/repo' });
  } finally {
    process.umask(before);
  }
  assert.equal(r.scope, 'project');
  // must not have been left behind under the operator's home
  assert.equal(existsSync(join(home, '.gigacode')), false);
});

test('assertLintScope proves its own gate on a genuinely clean install, then cleans up', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lint-repo-clean-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });

  const agentRoot = join(repoRoot, '.gigacode');
  mkdirSync(agentRoot, { recursive: true });
  // No skill/command files at all — this is exactly the case where a silently-dropped scope
  // and a genuinely clean scope would otherwise look identical to a purely textual check.
  execFileSync('git', ['config', 'serpens.agentDir', '.gigacode'], { cwd: repoRoot });

  const r = await assertLintScope({ repoRoot, agentRoot, run });
  assert.equal(r.ok, true, r.error);
  // the planted probe must never survive the call
  assert.equal(existsSync(join(agentRoot, 'skills', 'spns-sdd-scope-probe')), false);
});

test('assertLintScope proves the git-config route the daily flow depends on: a USER-scope agent home outside the repo, with SERPENS_AGENT_DIR unset', async () => {
  // This is the route that matters (spec §5.5): nothing sets SERPENS_AGENT_DIR in a lefthook hook
  // or a CI job, so only `git config serpens.agentDir` can point serpens-lint at a user-scope home.
  // The agent home is OUTSIDE the repository, so serpens-lint's dot-directory fallback cannot
  // find it either — if the lint fires on the planted probe, it read the git config and nothing
  // else. SERPENS_AGENT_DIR is set to a decoy here and must be ignored.
  const repoRoot = mkdtempSync(join(tmpdir(), 'lint-repo-userscope-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  const home = mkdtempSync(join(tmpdir(), 'lint-home-userscope-'));
  const agentRoot = join(home, '.gigacode');
  mkdirSync(agentRoot, { recursive: true });
  const rel = relative(repoRoot, agentRoot);
  execFileSync('git', ['config', 'serpens.agentDir', rel], { cwd: repoRoot });

  const saved = process.env.SERPENS_AGENT_DIR;
  process.env.SERPENS_AGENT_DIR = '.decoy-agent-dir-that-must-be-ignored';
  let r;
  try {
    r = await assertLintScope({ repoRoot, agentRoot, run });
  } finally {
    if (saved === undefined) delete process.env.SERPENS_AGENT_DIR;
    else process.env.SERPENS_AGENT_DIR = saved;
  }
  assert.equal(r.ok, true, r.error);
  assert.equal(r.agentDir, rel);
  assert.equal(existsSync(join(agentRoot, 'skills', 'spns-sdd-scope-probe')), false);
});

test('assertLintScope fails when git config serpens.agentDir was never set — the route the daily flow needs is missing', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lint-repo-noconfig-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  const home = mkdtempSync(join(tmpdir(), 'lint-home-noconfig-'));
  const agentRoot = join(home, '.gigacode');
  mkdirSync(agentRoot, { recursive: true });

  const r = await assertLintScope({ repoRoot, agentRoot, run });
  assert.equal(r.ok, false);
  assert.match(r.error, /serpens\.agentDir is not set/);
});

test('assertLintScope fails when git config serpens.agentDir points somewhere else than the resolved scope', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lint-repo-wrongconfig-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  const agentRoot = join(repoRoot, '.gigacode');
  mkdirSync(agentRoot, { recursive: true });
  execFileSync('git', ['config', 'serpens.agentDir', '.some-other-dir'], { cwd: repoRoot });

  const r = await assertLintScope({ repoRoot, agentRoot, run });
  assert.equal(r.ok, false);
  assert.match(r.error, /would read a different directory/);
});

test('assertLintScope refuses to clobber a pre-existing spns-sdd-scope-probe directory', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lint-repo-collide-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });

  const agentRoot = join(repoRoot, '.gigacode');
  execFileSync('git', ['config', 'serpens.agentDir', '.gigacode'], { cwd: repoRoot });
  const preexisting = join(agentRoot, 'skills', 'spns-sdd-scope-probe');
  mkdirSync(preexisting, { recursive: true });

  const r = await assertLintScope({ repoRoot, agentRoot, run });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  // must not have been removed by the refusal path
  assert.equal(existsSync(preexisting), true);
});
