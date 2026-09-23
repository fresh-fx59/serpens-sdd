import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initMain from '../src/cli/init.mjs';
import uninstallMain from '../src/cli/uninstall.mjs';
import { realOpenspec } from './helpers/real-openspec.mjs';

// investigation-store-uninstall-test-2026-09-23.md §5.2 — the real, offline, end-to-end proof
// that store-topology uninstall leaves NOTHING Serpens-created behind, against the REAL
// `@fission-ai/openspec` binary and the REAL `lefthook` binary (never stubs — see
// test/helpers/real-openspec.mjs's own rationale: a stub asserts our beliefs, the real binary
// asserts the behaviour). This is what actually found gap A (the submodule-protocol block on
// `file://` submodule remotes) and closes the loop the fixture test in uninstall.test.mjs
// cannot: fixture test drives the CLI's own logic; this drives real git submodule adds, a real
// `openspec init`/`store register`, and a real `lefthook install`/`uninstall`.
//
// THROWS rather than skips when either real binary is missing (matching realOpenspec()'s own
// contract) — a silently-skipped e2e reads exactly like a pass. `lefthook` on PATH is required;
// if absent: `brew install lefthook` (Mac) or the fleet's usual package manager (contabo/NixOS).
//
// Isolation: HOME and XDG_DATA_HOME both point at a fresh temp dir for the whole run, so the
// real OpenSpec registry/telemetry at the operator's real $HOME is never touched (checked
// below). `GIT_ALLOW_PROTOCOL=file:git:http:https` is required for `git submodule add` of a
// `file://` remote (`git clone` of the store itself does not need it) — investigation §3.

function requireLefthookOnPath() {
  try {
    execFileSync('/bin/sh', ['-c', 'command -v lefthook'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No real `lefthook` on PATH. test/store-uninstall-e2e.test.mjs deliberately drives the '
      + 'real binary (see its header) — install one (e.g. `brew install lefthook` on macOS) '
      + 'before running this file.',
    );
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGitRepo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch, dir]);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  git(dir, ['config', 'user.name', 'E2E']);
  return dir;
}

function makeBareWithOneCommit(prefix, branch, populate) {
  const bareDir = mkdtempSync(join(tmpdir(), `serpens-sdd-uninstall-e2e-${prefix}-bare-`));
  execFileSync('git', ['init', '--bare', '-q', '-b', branch, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), `serpens-sdd-uninstall-e2e-${prefix}-work-`));
  initGitRepo(workDir, branch);
  populate(workDir);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', branch]);
  return bareDir;
}

/**
 * Leftovers scoped to exactly the two gaps this pass fixes (gap A: the store root's own tree/
 * commands/skills/catalog were never reversed at all; gap B: a submodule's own commands/skills
 * were invisible to row 10 for want of its own port-facts.md). NOT included, because the
 * investigation names them as pre-existing, separately-tracked, out-of-scope gaps (§2 table,
 * §Open questions) that this pass does not fix and must not regress-mask by asserting away:
 * `README.md`/`gitignore.template` (store-scaffold leftovers, "not modeled at all"), a port's own
 * un-relocated `opsx-*`/`openspec-*` files under `.claude/` (row 12 only fires for a relocated
 * port), and the intentionally-kept team-edited fact docs (`serpens/port-facts.md`,
 * `testing-stack.md` — kept unless `--include-history`, by design).
 */
function listUnexpectedEntries(root) {
  const out = [];
  const alwaysOurs = ['bin', 'index.json', 'index.md', 'repo.txt', 'topology', '.install-record.json'];
  for (const rel of alwaysOurs) {
    if (existsSync(join(root, 'serpens', rel))) out.push(`serpens/${rel}`);
  }
  const commandDir = join(root, '.claude', 'commands', 'spns');
  if (existsSync(commandDir) && readdirSync(commandDir).length > 0) {
    out.push(...readdirSync(commandDir).map((f) => `.claude/commands/spns/${f}`));
  }
  const skillsDir = join(root, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith('spns-')) out.push(`.claude/skills/${d.name}`);
    }
  }
  return out;
}

test('real e2e: init then uninstall --apply in store topology leaves nothing Serpens-created behind', async (t) => {
  requireLefthookOnPath();
  const oss = realOpenspec();
  t.diagnostic(`real openspec version ${oss.version}`);

  const branch = 'main';
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-uninstall-e2e-'));
  const fakeHome = join(root, 'fake-home');
  mkdirSync(fakeHome, { recursive: true });
  // stage3 clones the store fresh (no local git identity set on that clone) and commits store
  // identity metadata to it — needs a real HOME-scoped git identity, portable across machines
  // (a bare `root@contabo` account has no GECOS fallback identity the way a real dev Mac does).
  writeFileSync(join(fakeHome, '.gitconfig'), '[user]\n\temail = e2e@example.com\n\tname = E2E\n', 'utf8');

  const storeRemote = makeBareWithOneCommit('store', branch, (workDir) => {
    writeFileSync(join(workDir, 'README.md'), '# store\n');
    mkdirSync(join(workDir, 'openspec', 'specs'), { recursive: true });
    mkdirSync(join(workDir, 'openspec', 'changes'), { recursive: true });
    writeFileSync(join(workDir, 'openspec', 'specs', '.gitkeep'), '');
    writeFileSync(join(workDir, 'openspec', 'changes', '.gitkeep'), '');
  });
  const projectRemote = makeBareWithOneCommit('repo-a', branch, (workDir) => {
    writeFileSync(join(workDir, 'README.md'), '# repo-a\n');
  });

  const storeRoot = join(root, 'system-store');
  const checkout = join(root, 'checkout');
  initGitRepo(checkout, branch);

  const configPath = join(checkout, 'serpens-sdd.config.json');
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    project: 'acme',
    lang: 'en',
    port: 'claude',
    openspec: { invocation: 'openspec' },
    store: { remote: storeRemote, base_branch: branch, root: storeRoot, id: 'store-e2e-probe' },
    repositories: [{ name: 'repo-a', url: projectRemote, base_branch: branch }],
    facts: { repository_source: 'manual' },
  }, null, 2), 'utf8');

  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  process.chdir(checkout);
  Object.assign(process.env, {
    HOME: fakeHome,
    XDG_DATA_HOME: join(fakeHome, '.local', 'share'),
    PATH: `${oss.binDir}:${process.env.PATH}`,
    GIT_ALLOW_PROTOCOL: 'file:git:http:https',
    CI: '1',
    NO_COLOR: '1',
  });

  try {
    const initCode = await initMain(['--config', configPath, '--non-interactive']);
    assert.equal(initCode, 0, 'real init against real openspec/lefthook must complete green');

    const submodulePath = join(storeRoot, 'submodules', 'repo-a');
    assert.ok(existsSync(join(storeRoot, 'serpens', 'port-facts.md')), 'store root must have its own port-facts.md');
    assert.ok(existsSync(join(storeRoot, '.claude', 'commands', 'spns', 'spec.md')));
    assert.ok(existsSync(join(submodulePath, '.claude', 'commands', 'spns', 'spec.md')));
    assert.equal(existsSync(join(submodulePath, 'serpens', 'port-facts.md')), false,
      'store mode never renders a per-submodule port-facts.md (the exact condition gap B needs to survive)');

    // Real store register ran — prove the isolation held (never the operator's real registry).
    const registryPath = join(process.env.XDG_DATA_HOME, 'openspec', 'stores', 'registry.yaml');
    assert.ok(existsSync(registryPath), 'expected a real store register to have written the isolated registry');

    // Uninstall BOTH roots the fixed CLI now reaches: the submodule, then the store root itself.
    const subCode = await uninstallMain(['--repo', submodulePath, '--apply']);
    assert.equal(subCode, 0);
    const storeCode = await uninstallMain(['--repo', storeRoot, '--apply']);
    assert.equal(storeCode, 0);

    const subLeftovers = listUnexpectedEntries(submodulePath);
    const storeLeftovers = listUnexpectedEntries(storeRoot);
    // Match only a REAL (non-comment, start-of-line) `rules:`/`context: |` key — the openspec
    // scaffold's own commented-out example text ("#   rules:", "#   context: |") must not count.
    const submoduleConfigPath = join(submodulePath, 'openspec', 'config.yaml');
    const registryLeftovers = existsSync(submoduleConfigPath)
      && /^(rules:|context: \|)/m.test(readFileSync(submoduleConfigPath, 'utf8'))
      ? ['openspec/config.yaml still carries our catalog/rules']
      : [];

    if (subLeftovers.length || storeLeftovers.length || registryLeftovers.length) {
      assert.fail(
        `leftovers after uninstall --apply — submodule: [${subLeftovers.join(', ')}], `
        + `store root: [${storeLeftovers.join(', ')}], other: [${registryLeftovers.join(', ')}]`,
      );
    }

    assert.equal(existsSync(join(fakeHome, '.local', 'share', 'openspec', 'stores', 'registry.yaml')), true,
      'the machine-level registry entry itself is never removed by design (row 13) — confirm it is still there');
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
  }
});
