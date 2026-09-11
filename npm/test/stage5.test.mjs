import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { run } from '../src/run.mjs';
import { kitPath } from '../src/integrity.mjs';
import { stage5, onboardOne } from '../src/stages/stage5-onboard.mjs';
import { fakeOpenspec } from './helpers/fixture.mjs';

const KIT_DIR = kitPath('en');
const BASE = 'develop';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A plain bare remote with one commit — no openspec/ scaffolding, matching a real,
 * never-onboarded service repository (unlike helpers/fixture.mjs's makeBareRemote, which is
 * built for the system store and ships openspec/ pre-populated). */
function makePlainBareRemote(name) {
  const bareDir = mkdtempSync(join(tmpdir(), `serpens-sdd-plain-remote-${name}-`));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), `serpens-sdd-plain-work-${name}-`));
  git(workDir, ['init', '-q', '-b', BASE, workDir]);
  git(workDir, ['config', 'user.email', 'fixture@example.com']);
  git(workDir, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(workDir, 'README.md'), `# ${name}\n`);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);
  return bareDir;
}

/** A real store with real (locally-hosted, offline) submodules added via `git submodule add`,
 * so onboardOne runs against genuine submodule checkouts, not a hand-authored .gitmodules. */
function makeStoreWithRealSubmodules(names) {
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-store5-'));
  git(storeRoot, ['init', '-q', '-b', BASE, storeRoot]);
  git(storeRoot, ['config', 'user.email', 'fixture@example.com']);
  git(storeRoot, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(storeRoot, 'README.md'), '# store\n');
  git(storeRoot, ['add', '-A']);
  git(storeRoot, ['commit', '-q', '-m', 'initial commit']);

  for (const name of names) {
    const bareDir = makePlainBareRemote(name);
    git(storeRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '-b', BASE, bareDir, `submodules/${name}`]);
  }
  git(storeRoot, ['add', '-A']);
  git(storeRoot, ['commit', '-q', '-m', 'add submodules']);

  return { storeRoot };
}

/** Stub `lefthook` on PATH: `install` (and anything else) is a silent no-op, exit 0. */
function fakeLefthook(dir) {
  const binDir = join(dir, 'lefthook-bin');
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, 'lefthook');
  writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(p, 0o755);
  return binDir;
}

const CLAUDE_PORT = {
  id: 'claude',
  agent_dir: '.claude',
  scope_preference: ['project'],
  instruction_file: 'CLAUDE.md',
  commands_supported: true,
  skills_supported: true,
};

const GIGACODE_PORT = {
  id: 'gigacode',
  agent_dir: '.gigacode',
  scope_preference: ['user', 'project'],
  instruction_file: 'GIGACODE.md',
  commands_supported: true,
  skills_supported: true,
};

function makeCtx({ storeRoot, port = CLAUDE_PORT, home, storeId = 'acme-store', storeRemote = 'ssh://git@forge/acme/store.git' } = {}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-stage5-bin-'));
  const oss = fakeOpenspec(fixtureDir);
  const lefthookBin = fakeLefthook(fixtureDir);
  const env = { ...oss.pathPrepend(process.env), PATH: `${lefthookBin}:${oss.pathPrepend(process.env).PATH}` };
  const wrappedRun = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env });
  const config = {
    project: 'acme',
    store: { id: storeId, root: storeRoot, remote: storeRemote, base_branch: BASE },
    openspec: { invocation: 'openspec', pinned_version: '1.2.3' },
    port_scope: 'auto',
  };
  return { config, port, run: wrappedRun, storeRoot, kitDir: KIT_DIR, home };
}

test('onboards a submodule end to end', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const ctx = makeCtx({ storeRoot });

  const result = await stage5(ctx);
  assert.equal(result.ok, true, result.error);

  const repoRoot = join(storeRoot, 'submodules', 'service-a');

  assert.equal(readFileSync(join(repoRoot, 'openspec', 'repo.txt'), 'utf8').trim(), 'service-a');
  assert.ok(existsSync(join(repoRoot, 'openspec', 'adr', '.gitkeep')));

  const lefthookYml = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
  assert.match(lefthookYml, /tools\/serpens-sdd verify-docs/);
  assert.doesNotMatch(lefthookYml, /bash tools\/verify-docs\.sh/);
  // An INSTALLED lefthook.yml must never carry an install-time token. The kit's
  // config/lefthook.yml.example legitimately does (it is the illustrative copy), and
  // starter-contract-test.sh therefore exempts config/ from its raw-token ban — so this is the
  // only place the "no token in a live hook" rule can be asserted. A `run: <serpens-sdd> …` line
  // fails EVERY commit in the repository.
  assert.doesNotMatch(lefthookYml, /<serpens-sdd>|<openspec>/,
    'the installed lefthook.yml must have no unsubstituted token');

  assert.ok(existsSync(join(repoRoot, '.gitignore')));
  assert.ok(readFileSync(join(repoRoot, '.gitignore'), 'utf8').length > 0);

  const configYaml = readFileSync(join(repoRoot, 'openspec', 'config.yaml'), 'utf8');
  assert.match(configYaml, /- id: acme-store/);
  assert.match(configYaml, /remote: ssh:\/\/git@forge\/acme\/store\.git/);

  const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.trimEnd().endsWith('do not keep looping.'));
  assert.match(claudeMd, /## HARD RULE — disposer self-check/);
  // The HARD RULE must name a command that EXISTS in this repository. Stages 3 and 5 write
  // `tools/serpens-sdd` and no `tools/*.sh` copy at all, so the rule has to route through the shim
  // exactly like the generated lefthook.yml does.
  assert.match(claudeMd, /"\$\(git rev-parse --show-toplevel\)"\/tools\/serpens-sdd verify-docs/);
  assert.doesNotMatch(claudeMd, /tools\/verify-docs\.sh/);
  const namedScript = /tools\/([A-Za-z0-9._-]+)/g;
  for (const m of claudeMd.matchAll(namedScript)) {
    assert.ok(existsSync(join(repoRoot, 'tools', m[1])),
      `the HARD RULE names tools/${m[1]}, which this repository does not have`);
  }

  for (const f of ['adr.md', 'research.md', 'testing-stack.md']) {
    assert.ok(existsSync(join(repoRoot, 'templates', f)), `templates/${f} missing`);
  }

  assert.deepEqual(readdirSync(join(repoRoot, 'tools')), ['serpens-sdd']);
});

test('one failing submodule leaves it un-onboarded, finishes the others, and names it', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a', 'service-b']);
  const ctx = makeCtx({ storeRoot });

  // Make service-b's worktree dirty (a TRACKED-file edit, never a reset/clean) so its
  // `state prepare-base` fails, without touching service-a.
  const bRoot = join(storeRoot, 'submodules', 'service-b');
  writeFileSync(join(bRoot, 'README.md'), '# service-b (locally edited, uncommitted)\n');

  const result = await stage5(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, 'service-b');
  assert.match(result.failures[0].error, /uncommitted changes to TRACKED files/);
  assert.match(result.error, /service-b/);

  const aRoot = join(storeRoot, 'submodules', 'service-a');
  assert.ok(existsSync(join(aRoot, 'lefthook.yml')), 'service-a should be fully onboarded');
  assert.ok(existsSync(join(aRoot, 'openspec', 'repo.txt')));

  assert.ok(!existsSync(join(bRoot, 'lefthook.yml')), 'service-b must not be half-onboarded');
});

test('the HARD RULE is appended once, not twice, on a second run', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const ctx = makeCtx({ storeRoot });

  const first = await stage5(ctx);
  assert.equal(first.ok, true, first.error);
  const second = await stage5(ctx);
  assert.equal(second.ok, true, second.error);

  const claudeMd = readFileSync(join(storeRoot, 'submodules', 'service-a', 'CLAUDE.md'), 'utf8');
  const occurrences = claudeMd.split('disposer self-check').length - 1;
  assert.equal(occurrences, 1);
});

test('a user-scope install sets and proves serpens.agentDir', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const home = mkdtempSync(join(tmpdir(), 'serpens-sdd-home-'));
  const ctx = makeCtx({ storeRoot, port: GIGACODE_PORT, home });

  const result = await onboardOne(ctx, join(storeRoot, 'submodules', 'service-a'));
  assert.equal(result.ok, true, result.error);

  const repoRoot = join(storeRoot, 'submodules', 'service-a');
  const configured = git(repoRoot, ['config', '--get', 'serpens.agentDir']).trim();
  assert.equal(configured, relative(repoRoot, join(home, '.gigacode')));

  assert.ok(result.evidence.some((e) => /assertLintScope\(service-a\) → ok/.test(e)));
});

// The templates step used to `copyFileSync` unconditionally over three generic names —
// `adr.md`, `research.md`, `testing-stack.md`. A repository can legitimately already have one
// (`templates/research.md` especially), and it was destroyed on install. Same class as the
// `openspec/config.yaml` corruption: writing into a namespace we do not own. Ownership is now
// decided by CONTENT, so a re-run still upgrades our own templates.
function onboardTarget() {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const home = mkdtempSync(join(tmpdir(), 'serpens-sdd-home-'));
  return {
    ctx: makeCtx({ storeRoot, home }),
    submodulePath: join(storeRoot, 'submodules', 'service-a'),
  };
}

test('an existing template that is NOT ours survives onboarding, and is reported', async () => {
  const { ctx, submodulePath } = onboardTarget();
  const dest = join(submodulePath, 'templates', 'research.md');
  const theirs = '# Our own research template\n\nNothing to do with the kit.\n';
  mkdirSync(join(submodulePath, 'templates'), { recursive: true });
  writeFileSync(dest, theirs, 'utf8');

  const r = await onboardOne(ctx, submodulePath);
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(dest, 'utf8'), theirs, "the team's file must survive byte for byte");
  assert.match(r.evidence.join('\n'), /research\.md exists and is not ours — left untouched/);
});

test('a kit-stamped template IS refreshed, so a re-run still upgrades our own copies', async () => {
  const { ctx, submodulePath } = onboardTarget();
  const dest = join(submodulePath, 'templates', 'adr.md');
  mkdirSync(join(submodulePath, 'templates'), { recursive: true });
  // An older edition's copy: carries our stamp, but stale content.
  writeFileSync(dest, '---\nserpens-version: 2026-01-01.1\n---\nstale kit content\n', 'utf8');

  const r = await onboardOne(ctx, submodulePath);
  assert.equal(r.ok, true, r.error);
  const shipped = readFileSync(join(kitPath('en'), 'templates', 'adr.md'), 'utf8');
  assert.equal(readFileSync(dest, 'utf8'), shipped, 'a stamped file is ours to refresh');
});

test('a template identical to the kit is left alone rather than rewritten', async () => {
  const { ctx, submodulePath } = onboardTarget();
  const first = await onboardOne(ctx, submodulePath);
  assert.equal(first.ok, true, first.error);
  const second = await onboardOne(ctx, submodulePath);
  assert.equal(second.ok, true, second.error);
  assert.match(second.evidence.join('\n'), /already matches the kit template — not rewritten/);
});
