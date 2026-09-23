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

  const applied = await runUninstall(fixture, ['--apply']);
  assert.equal(applied.code, 0, applied.printed);
  assert.match(applied.printed, /APPLYING/);

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
