import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initMain from '../src/cli/init.mjs';
import uninstallMain, { resolveUninstallTargets, planRoot } from '../src/cli/uninstall.mjs';
import {
  removeStoreReference, removeContextCatalog, removeArtifactRules,
  declareStoreReference, declareContextCatalog, declareArtifactRules, verifyOnlyRemoved,
} from '../src/openspecconfig.mjs';
import { contextCatalog, artifactRules } from '../src/factfiles.mjs';
import { fakeOpenspec } from './helpers/fixture.mjs';
import { fillTestingStack } from './helpers/testing-stack.mjs';

const BASE = 'main';
const SPEC_DRIVEN_ARTIFACTS = ['proposal', 'specs', 'design', 'tasks'];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', BASE, dir]);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  git(dir, ['config', 'user.name', 'E2E']);
  return dir;
}

function noopLefthook(dir) {
  const binDir = mkdtempSync(join(dir, 'lefthook-noop-'));
  const p = join(binDir, 'lefthook');
  writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(p, 0o755);
  return binDir;
}

/**
 * A repo-local install, ready for uninstall testing: a team that already runs vanilla OpenSpec
 * by hand (its own change, its own `lefthook.yml`, its own `CLAUDE.md`), then a real
 * `serpens-sdd init --topology repo-local` on top of it.
 */
function makeInstalledFixture({ teamLefthook = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-uninstall-'));
  const repoRoot = join(root, 'trial');
  initGitRepo(repoRoot);
  for (const d of ['openspec/specs', 'openspec/changes/archive']) mkdirSync(join(repoRoot, d), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  writeFileSync(join(repoRoot, 'openspec', 'specs', '.gitkeep'), '');
  writeFileSync(join(repoRoot, 'openspec', 'changes', 'archive', '.gitkeep'), '');
  if (teamLefthook) {
    writeFileSync(join(repoRoot, 'lefthook.yml'), '# the team\'s own hooks\npre-commit:\n  commands:\n    team-lint:\n      run: "true"\n');
  }
  writeFileSync(join(repoRoot, 'CLAUDE.md'), '# Team rules\n\nOur own text.\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'vanilla openspec repo']);

  const oss = fakeOpenspec(root, { version: '1.13.0' });
  const lefthookBin = noopLefthook(root);
  const configPath = join(root, 'serpens-sdd.json');
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    topology: 'repo-local',
    project: 'trial',
    lang: 'en',
    port: 'claude',
    openspec: { invocation: 'openspec' },
    repo: { root: '.', name: 'trial', base_branch: BASE },
    facts: { repository_source: 'manual' },
  }, null, 2), 'utf8');

  return { root, repoRoot, configPath, oss, lefthookBin };
}

async function runInit(fixture) {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  process.chdir(fixture.repoRoot);
  process.env.PATH = `${fixture.oss.binDir}:${fixture.lefthookBin}:${process.env.PATH}`;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    return await initMain(['--config', fixture.configPath, '--non-interactive']);
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
  }
}

async function runUninstall(fixture, argv = []) {
  const savedCwd = process.cwd();
  const savedWrite = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (chunk, ...rest) => { printed += chunk; return savedWrite(chunk, ...rest); };
  process.chdir(fixture.repoRoot);
  try {
    const code = await uninstallMain(argv);
    return { code, printed };
  } finally {
    process.stdout.write = savedWrite;
    process.chdir(savedCwd);
  }
}

function fillFacts(repoRoot) {
  fillTestingStack(join(repoRoot, 'serpens', 'testing-stack.md'));
  const pf = join(repoRoot, 'serpens', 'port-facts.md');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace(/^UNFILLED — .*$/gm, 'answered by the operator'));
}

function snapshotTree(root) {
  const out = execFileSync('git', ['status', '--porcelain', '-uall', '--ignored'], { cwd: root, encoding: 'utf8' });
  return out;
}

test('uninstall: resolveUninstallTargets finds a repo-local root via serpens/topology', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-targets-'));
  mkdirSync(join(root, 'serpens'), { recursive: true });
  writeFileSync(join(root, 'serpens', 'topology'), 'repo-local\n');
  const result = resolveUninstallTargets(root);
  assert.equal(result.topology, 'repo-local');
  assert.deepEqual(result.onboardedRoots, [root]);
});

test('uninstall: resolveUninstallTargets finds nothing onboarded when serpens/ is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-targets-empty-'));
  const result = resolveUninstallTargets(root);
  assert.equal(result.onboardedRoots.length, 1); // best-effort: the root itself, empty plan
});

test('uninstall dry-run changes no byte, then --apply reverses every reversible row; team files survive byte-identical', async () => {
  const fixture = makeInstalledFixture();
  const { repoRoot } = fixture;
  const teamFiles = ['lefthook.yml', 'openspec/specs/.gitkeep'];
  const before = Object.fromEntries(teamFiles.map((f) => [f, readFileSync(join(repoRoot, f))]));
  const claudeBefore = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');

  const initCode = await runInit(fixture);
  assert.equal(initCode, 0);
  fillFacts(repoRoot);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '--no-verify', '-m', 'onboard serpens-sdd repo-local']);

  // A team edit AFTER install: the port instruction file gets its own content prepended, and
  // a stray team edit lands in one installed command file — both must survive uninstall.
  writeFileSync(join(repoRoot, 'CLAUDE.md'), `# Team rules\n\nOur own text.\n\n${readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8')}`);
  const editedCommand = join(repoRoot, '.claude', 'commands', 'spns', 'plan.md');
  writeFileSync(editedCommand, `${readFileSync(editedCommand, 'utf8')}\n<!-- team note -->\n`);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '--no-verify', '-m', 'team edits after install']);

  const beforeDry = snapshotTree(repoRoot);
  const dry = await runUninstall(fixture);
  assert.equal(dry.code, 0, dry.printed);
  assert.match(dry.printed, /DRY RUN/);
  assert.equal(snapshotTree(repoRoot), beforeDry, 'dry-run must not touch the tree');
  assert.match(dry.printed, /row 1\]/);
  assert.match(dry.printed, /row 9\]/);
  assert.match(dry.printed, /row 12\]/);

  // Header: plain-language framing, grouped summary derived from the actual plan, what's kept.
  assert.match(dry.printed, /Serpens uninstall removes only what Serpens installed\. OpenSpec, your openspec\/\s*\nchanges and specs stay untouched\./);
  assert.match(dry.printed, /Will be removed in this repo:/);
  assert.match(dry.printed, /serpens\/ folder: 1/);
  assert.match(dry.printed, /installed commands\/skills: \d+/);
  assert.match(dry.printed, /Kept on purpose:/);
  assert.match(dry.printed, /serpens\/testing-stack\.md, serpens\/port-facts\.md/);
  assert.match(dry.printed, /team-edited files, left in place \(\d+\):/);
  assert.match(dry.printed, /Dry run — nothing changed\. Re-run with --apply to remove\./);

  const applied = await runUninstall(fixture, ['--apply']);
  assert.equal(applied.code, 0, applied.printed);
  assert.match(applied.printed, /APPLYING/);
  assert.match(applied.printed, /Serpens uninstall removes only what Serpens installed\./);
  assert.match(applied.printed, /Done: \d+ removed, \d+ skipped \(team-edited\/left in place\), \d+ kept on purpose\./);
  assert.match(applied.printed, /Manual steps still to run \(see rows 13\/14 above\):/);
  assert.match(applied.printed, /Next: run `git status`, review, and commit\./);
  assert.match(applied.printed, /OpenSpec still works as usual — try `openspec list`\./);

  // Reversed.
  assert.equal(existsSync(join(repoRoot, 'lefthook.yml.example')), false);
  assert.equal(existsSync(join(repoRoot, 'serpens', 'bin')), false);
  assert.equal(existsSync(join(repoRoot, 'serpens', 'topology')), false);
  assert.equal(existsSync(join(repoRoot, 'serpens', 'repo.txt')), false);
  assert.equal(existsSync(join(repoRoot, 'serpens', '.install-record.json')), false);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'openspec', 'config.yaml'), 'utf8'), /rules:/);
  let baseBranchStillSet = true;
  try {
    git(repoRoot, ['config', '--get', 'serpens.baseBranch']);
  } catch {
    baseBranchStillSet = false;
  }
  assert.equal(baseBranchStillSet, false, 'serpens.baseBranch must be unset after uninstall --apply');

  // Team content preserved byte-identical.
  for (const f of teamFiles) assert.deepEqual(readFileSync(join(repoRoot, f)), before[f], `${f} changed`);
  assert.match(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8'), /^# Team rules\n\nOur own text\.\n\n# Team rules\n\nOur own text\.\n\n?$/);
  void claudeBefore;

  // The edited command file was left in place, reported, not deleted.
  assert.ok(existsSync(editedCommand), 'a team-edited installed command must survive uninstall');
  assert.match(readFileSync(editedCommand, 'utf8'), /team note/);
  const pristineCommand = join(repoRoot, '.claude', 'commands', 'spns', 'spec.md');
  assert.equal(existsSync(pristineCommand), false, 'a pristine installed command must be removed');

  // Facts kept as team knowledge (row 9), never removed without --include-history.
  assert.ok(existsSync(join(repoRoot, 'serpens', 'testing-stack.md')));
  assert.ok(existsSync(join(repoRoot, 'serpens', 'port-facts.md')));
});

test('uninstall dry-run on a repo with nothing Serpens-installed: header prints an empty summary, no false "team-edited"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-uninstall-empty-'));
  initGitRepo(root);
  const savedCwd = process.cwd();
  const savedWrite = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (chunk, ...rest) => { printed += chunk; return savedWrite(chunk, ...rest); };
  process.chdir(root);
  let code;
  try {
    code = await uninstallMain([]);
  } finally {
    process.stdout.write = savedWrite;
    process.chdir(savedCwd);
  }
  assert.equal(code, 0);
  assert.match(printed, /Will be removed in this repo:\n\s*\(nothing found to remove\)/);
  assert.match(printed, /team-edited files: none found/);
});

test('planRoot: git config keys are only listed when actually present', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-plan-noconfig-'));
  initGitRepo(root);
  const actions = planRoot(root);
  assert.equal(actions.some((a) => a.id.startsWith('git-config:')), false);
});

// ---------------------------------------------------------------------------------------------
// openspecconfig.mjs: the removal inverses, and their negative controls.
// ---------------------------------------------------------------------------------------------

test('removeStoreReference removes exactly our entry, leaves the user\'s alone', () => {
  const base = 'schema: spec-driven\nreferences:\n  - id: their-store\n    remote: git@f:o/theirs.git\n';
  const declared = declareStoreReference(base, 'our-store', 'git@f:o/ours.git');
  assert.equal(declared.action, 'inserted');
  const removed = removeStoreReference(declared.text, 'our-store', 'git@f:o/ours.git');
  assert.equal(removed.action, 'removed');
  assert.equal(removed.text, base);
});

test('removeStoreReference is a no-op when the entry does not match ours exactly', () => {
  const base = 'schema: spec-driven\nreferences:\n  - id: our-store\n    remote: git@f:o/different.git\n';
  const result = removeStoreReference(base, 'our-store', 'git@f:o/ours.git');
  assert.equal(result.action, 'unchanged');
  assert.equal(result.text, base);
});

test('removeContextCatalog removes the appended block even when rules: follows it', () => {
  const base = 'schema: spec-driven\n';
  const withCatalog = declareContextCatalog(base, contextCatalog());
  assert.equal(withCatalog.action, 'appended');
  const withRules = declareArtifactRules(withCatalog.text, artifactRules(SPEC_DRIVEN_ARTIFACTS));
  assert.equal(withRules.action, 'appended');
  const removed = removeContextCatalog(withRules.text, contextCatalog());
  assert.equal(removed.action, 'removed');
  assert.doesNotMatch(removed.text, /context: \|/);
  assert.match(removed.text, /rules:/, 'the rules: block that came after context: must survive');
});

test('removeArtifactRules removes only the ids we inserted, leaving the user\'s id untouched', () => {
  const base = 'schema: spec-driven\nrules:\n  proposal:\n    - keep it short\n';
  const inserted = declareArtifactRules(base, artifactRules(SPEC_DRIVEN_ARTIFACTS));
  assert.equal(inserted.action, 'inserted');
  const removed = removeArtifactRules(inserted.text, artifactRules(SPEC_DRIVEN_ARTIFACTS));
  assert.equal(removed.action, 'removed');
  assert.equal(removed.text, base);
  assert.deepEqual(removed.removedIds.sort(), ['design', 'tasks']);
});

test('removeArtifactRules removes the whole rules: key when every id in it was ours', () => {
  const base = 'schema: spec-driven\n';
  const appended = declareArtifactRules(base, artifactRules(SPEC_DRIVEN_ARTIFACTS));
  assert.equal(appended.action, 'appended');
  const removed = removeArtifactRules(appended.text, artifactRules(SPEC_DRIVEN_ARTIFACTS));
  assert.equal(removed.action, 'removed');
  assert.equal(removed.text, base);
});

test('verifyOnlyRemoved negative control: a removal that also changed a surrounding byte is rejected', () => {
  const before = 'a\nb\nc\n';
  const after = 'a\nX\n'; // claims to have removed "b" and "c", but also mutated "a" -> would need "a" unchanged
  const check = verifyOnlyRemoved(before, after, ['b', 'c'], '\n');
  assert.equal(check.ok, false);
});

// ---------------------------------------------------------------------------------------------
// investigation-store-uninstall-test-2026-09-23.md — gap A (store root never reversed by
// `main()`) and gap B (a submodule's own row-10 commands/skills are invisible because store
// mode never renders `serpens/port-facts.md` per-submodule). These drive the real CLI `main()`
// entry point against a store-topology install built by a real `init` run, closing exactly the
// blind spot the investigation names: prior tests only ever called `planRoot()` directly, never
// `main()` against a store root, and never checked a submodule's port-facts fallback.
// ---------------------------------------------------------------------------------------------

/** A plain bare remote with one commit and no openspec/ scaffolding — a real project repo. */
function makeStoreProjectRemote(name) {
  const bareDir = mkdtempSync(join(tmpdir(), `serpens-sdd-uninstall-store-proj-${name}-`));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), `serpens-sdd-uninstall-store-proj-work-${name}-`));
  initGitRepo(workDir);
  writeFileSync(join(workDir, 'README.md'), `# ${name}\n`);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);
  return bareDir;
}

/** A bare "system store" remote, pre-populated the way an established store already is. */
function makeUninstallStoreRemote() {
  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-uninstall-store-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-uninstall-store-work-'));
  initGitRepo(workDir);
  writeFileSync(join(workDir, 'README.md'), '# store\n');
  mkdirSync(join(workDir, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(workDir, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(workDir, 'openspec', 'specs', '.gitkeep'), '');
  writeFileSync(join(workDir, 'openspec', 'changes', '.gitkeep'), '');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);
  return bareDir;
}

/** Build a real store-topology install (store + one onboarded submodule `repo-a`), entirely
 * offline via local bare `file://`-less remotes (plain absolute paths — no submodule protocol
 * gate needed since these are ordinary local paths, not `file://` URLs), driving the real
 * `initMain()` end to end (stage 0..9), exactly as e2e.test.mjs's `makeFixture` does. */
async function makeStoreFixture() {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-uninstall-store-'));
  const storeRemote = makeUninstallStoreRemote();
  const storeRoot = join(root, 'store');
  const repoRoot = join(root, 'repo');
  initGitRepo(repoRoot);

  const oss = fakeOpenspec(root, { version: '1.13.0' });
  const lefthookBin = noopLefthook(root);
  const projectRemote = makeStoreProjectRemote('repo-a');

  const configPath = join(repoRoot, 'serpens-sdd.json');
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    project: 'acme',
    lang: 'en',
    port: 'claude',
    openspec: { invocation: 'openspec' },
    store: { remote: storeRemote, base_branch: BASE, root: storeRoot },
    repositories: [{ name: 'repo-a', url: projectRemote, base_branch: BASE }],
    facts: { repository_source: 'manual' },
  }, null, 2), 'utf8');

  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  process.chdir(repoRoot);
  process.env.PATH = `${oss.binDir}:${lefthookBin}:${process.env.PATH}`;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  let code;
  try {
    code = await initMain(['--config', configPath, '--non-interactive']);
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
  }
  assert.equal(code, 0, 'fixture setup: init must complete green');

  return { root, storeRoot, submodulePath: join(storeRoot, 'submodules', 'repo-a'), oss, lefthookBin };
}

async function runStoreUninstall(fixture, argv) {
  const savedEnv = { ...process.env };
  process.env.PATH = `${fixture.oss.binDir}:${fixture.lefthookBin}:${process.env.PATH}`;
  try {
    return await uninstallMain(argv);
  } finally {
    process.env = savedEnv;
  }
}

test('gap A: uninstall --repo <storeRoot> plans and applies the store root itself, not just submodules', async () => {
  const fixture = await makeStoreFixture();

  // Pre-conditions the investigation found: the store root has its own serpens/ tree, .claude
  // commands/skills, and an openspec/config.yaml catalog — none of it visible to the OLD `main()`.
  assert.ok(existsSync(join(fixture.storeRoot, 'serpens', 'port-facts.md')));
  assert.ok(existsSync(join(fixture.storeRoot, '.claude', 'commands', 'spns', 'spec.md')));

  const code = await runStoreUninstall(fixture, ['--repo', fixture.storeRoot, '--apply']);
  assert.equal(code, 0);

  // The fixed CLI must have reported and applied the store root's own tree.
  assert.equal(existsSync(join(fixture.storeRoot, 'serpens', 'bin')), false,
    'gap A: the store root serpens/ tree must be removed by --repo <storeRoot> --apply');
  assert.equal(existsSync(join(fixture.storeRoot, '.claude', 'commands', 'spns', 'spec.md')), false,
    'gap A: the store root\'s own installed commands must be removed');
});

test('gap A: dry-run against the store root alone (no submodule targets) is no longer "nothing to do"', async () => {
  const fixture = await makeStoreFixture();
  const printed = [];
  const savedWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return savedWrite(chunk, ...rest); };
  let code;
  try {
    code = await runStoreUninstall(fixture, ['--repo', fixture.storeRoot]);
  } finally {
    process.stdout.write = savedWrite;
  }
  assert.equal(code, 0);
  const out = printed.join('');
  assert.doesNotMatch(out, /nothing onboarded found here/,
    'gap A: the store root itself is a valid uninstall target and must not be reported as empty');
  assert.match(out, new RegExp(fixture.storeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('gap B: a submodule\'s own installed commands/skills are found via the store\'s port-facts.md fallback', async () => {
  const fixture = await makeStoreFixture();

  // Pre-condition the investigation found: no per-submodule port-facts.md.
  assert.equal(existsSync(join(fixture.submodulePath, 'serpens', 'port-facts.md')), false,
    'store mode never renders a per-submodule port-facts.md — the fixture must reproduce that');
  assert.ok(existsSync(join(fixture.submodulePath, '.claude', 'commands', 'spns', 'spec.md')),
    'the submodule must have its own installed commands (store-mode project scope)');

  const code = await runStoreUninstall(fixture, ['--repo', fixture.submodulePath, '--apply']);
  assert.equal(code, 0);

  assert.equal(existsSync(join(fixture.submodulePath, '.claude', 'commands', 'spns', 'spec.md')), false,
    'gap B: the submodule\'s own commands must be removed even without its own port-facts.md');
  assert.equal(existsSync(join(fixture.submodulePath, '.claude', 'skills', 'spns-tdd', 'SKILL.md')), false,
    'gap B: the submodule\'s own skills must be removed even without its own port-facts.md');
});
