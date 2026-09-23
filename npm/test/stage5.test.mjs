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
import {
  stage5, onboardOne, appendHardRuleOnce, HARD_RULE_MARKER, HARD_RULE_BLOCKS,
} from '../src/stages/stage5-onboard.mjs';
import { fakeOpenspec } from './helpers/fixture.mjs';
import { LAYOUT, SERPENS_DIR } from '../src/layout.mjs';
import { LEFTHOOK_MARKER } from '../src/shim.mjs';

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

  assert.equal(readFileSync(join(repoRoot, 'serpens', 'repo.txt'), 'utf8').trim(), 'service-a');
  assert.ok(existsSync(join(repoRoot, 'serpens', 'adr', '.gitkeep')));

  const lefthookYml = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
  assert.match(lefthookYml, /serpens\/bin\/serpens-sdd verify-docs/);
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
  // The other two slots OpenSpec injects. `context:` carries the CATALOG — what each fact file
  // answers, so the agent can choose — and never an order to read them all, because the cost of
  // that line grows with every fact file a shop adds. The orders live in `rules:`, keyed by the
  // artifact that cannot be written without them.
  assert.match(configYaml, /^context: \|$/m, 'stage 5 must write the fact-file catalog');
  assert.match(configYaml, /serpens\/testing-stack\.md/);
  assert.match(configYaml, /serpens\/branching\.md/);
  assert.match(configYaml, /Open only what the current step needs\./);
  assert.doesNotMatch(configYaml, /[Rr]ead (all|these|every) /);
  assert.match(configYaml, /^rules:$/m, 'stage 5 must write the per-artifact rules');
  assert.match(configYaml, /^ {2}tasks:$/m);
  assert.doesNotMatch(configYaml, /^ {2}proposal:$/m,
    'proposal is intent; giving it a fact-file order would cost tokens in every proposal');

  const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.trimEnd().endsWith('do not keep looping.'));
  assert.match(claudeMd, /## HARD RULE — disposer self-check/);
  // The HARD RULE must name a command that EXISTS in this repository. Stages 3 and 5 write
  // `serpens/bin/serpens-sdd` and no `tools/*.sh` copy at all, so the rule has to route through the shim
  // exactly like the generated lefthook.yml does.
  assert.match(claudeMd, /"\$\(git rev-parse --show-toplevel\)"\/serpens\/bin\/serpens-sdd verify-docs/);
  assert.doesNotMatch(claudeMd, /tools\/verify-docs\.sh/);
  const namedScript = /tools\/([A-Za-z0-9._-]+)/g;
  for (const m of claudeMd.matchAll(namedScript)) {
    assert.ok(existsSync(join(repoRoot, 'tools', m[1])),
      `the HARD RULE names tools/${m[1]}, which this repository does not have`);
  }

  for (const f of ['adr.md', 'research.md', 'testing-stack.md']) {
    assert.ok(existsSync(join(repoRoot, 'serpens', 'templates', f)), `serpens/templates/${f} missing`);
  }

  assert.deepEqual(readdirSync(join(repoRoot, 'serpens', 'bin')), ['serpens-sdd']);
});

// Gap 7 of the OpenSpec-coexistence list: four artifacts that are OURS — the pinned repo
// identity, the ADR archive, and both halves of the generated capability index — used to be
// written inside `openspec/`, the directory vanilla OpenSpec owns. They now live under
// `serpens/`, so a team running vanilla OpenSpec beside this kit never sees a gate fail on a
// file inside the directory they believe OpenSpec owns.
test('the four Serpens artifacts land under serpens/, and openspec/ holds only OpenSpec\'s own files', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const ctx = makeCtx({ storeRoot });
  assert.equal((await stage5(ctx)).ok, true);
  const repoRoot = join(storeRoot, 'submodules', 'service-a');

  for (const p of [LAYOUT.repoTxt, LAYOUT.adrDir, LAYOUT.indexJson, LAYOUT.indexMd]) {
    assert.ok(existsSync(join(repoRoot, p)), `${p} must exist`);
    assert.ok(p.startsWith(`${SERPENS_DIR}/`), `${p} must be declared under ${SERPENS_DIR}/`);
  }

  // The old homes must be gone, not merely duplicated.
  for (const old of ['repo.txt', 'adr', 'index.json', 'index.md']) {
    assert.equal(existsSync(join(repoRoot, 'openspec', old)), false,
      `openspec/${old} is ours and must no longer be written into OpenSpec's directory`);
  }

  // Nothing else of ours may appear there either: this is the whole set OpenSpec itself creates.
  const OPENSPEC_OWN = new Set(['specs', 'changes', 'config.yaml', 'project.md', 'AGENTS.md']);
  for (const entry of readdirSync(join(repoRoot, 'openspec'))) {
    assert.ok(OPENSPEC_OWN.has(entry),
      `openspec/${entry} is not an OpenSpec artifact — this kit writes under ${SERPENS_DIR}/ only`);
  }
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
  assert.ok(existsSync(join(aRoot, 'serpens', 'repo.txt')));

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
  const dest = join(submodulePath, 'serpens', 'templates', 'research.md');
  const theirs = '# Our own research template\n\nNothing to do with the kit.\n';
  mkdirSync(join(submodulePath, 'serpens', 'templates'), { recursive: true });
  writeFileSync(dest, theirs, 'utf8');

  const r = await onboardOne(ctx, submodulePath);
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(dest, 'utf8'), theirs, "the team's file must survive byte for byte");
  assert.match(r.evidence.join('\n'), /research\.md exists and is not ours — left untouched/);
});

test('a kit-stamped template IS refreshed, so a re-run still upgrades our own copies', async () => {
  const { ctx, submodulePath } = onboardTarget();
  const dest = join(submodulePath, 'serpens', 'templates', 'adr.md');
  mkdirSync(join(submodulePath, 'serpens', 'templates'), { recursive: true });
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

// --- gap 9: a repository that already uses OpenSpec -----------------------------------------
//
// `openspec init` auto-answers OpenSpec's own "Upgrade and clean up legacy files?" prompt when it
// cannot ask (it can never ask from here: `--tools` disables prompting and our child process has
// no TTY), and that auto-clean rewrites the team's CLAUDE.md/AGENTS.md and deletes files, some in
// the user's HOME. So a repository that already has `openspec/` must be asserted, never inited.

/** Give an existing checkout a COMPLETE OpenSpec root, exactly as real `openspec init` leaves it. */
function plantOpenspec(repoRoot, { omit = null, config = 'schema: spec-driven\n' } = {}) {
  for (const dir of [['specs'], ['changes'], ['changes', 'archive']]) {
    // Omitting `changes` must omit `changes/archive` too — mkdir -p would otherwise recreate it.
    if (omit && `${dir.join('/')}/`.startsWith(`${omit}/`)) continue;
    mkdirSync(join(repoRoot, 'openspec', ...dir), { recursive: true });
    writeFileSync(join(repoRoot, 'openspec', ...dir, '.gitkeep'), '');
  }
  mkdirSync(join(repoRoot, 'openspec'), { recursive: true });
  if (config !== null) writeFileSync(join(repoRoot, 'openspec', 'config.yaml'), config, 'utf8');
}

/** Record every `openspec` argv the run made, so a test can assert `init` was or was not called. */
function recordingCtx(base) {
  const calls = [];
  const inner = base.run;
  return {
    ctx: {
      ...base,
      run: (cmd, args, opts) => {
        if (/openspec/.test(cmd)) calls.push(args.join(' '));
        return inner(cmd, args, opts);
      },
    },
    calls,
  };
}

test('greenfield: no openspec/ yet, so `openspec init` still runs', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const { ctx, calls } = recordingCtx(makeCtx({ storeRoot }));
  const submodulePath = join(storeRoot, 'submodules', 'service-a');

  const result = await onboardOne(ctx, submodulePath);
  assert.equal(result.ok, true, result.error);
  assert.ok(calls.some((c) => c === 'init --tools claude'), `expected an init call, got: ${calls.join(' | ')}`);
});

test('a pre-existing complete openspec/ skips init and still onboards', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const { ctx, calls } = recordingCtx(makeCtx({ storeRoot }));
  const submodulePath = join(storeRoot, 'submodules', 'service-a');
  plantOpenspec(submodulePath);

  const result = await onboardOne(ctx, submodulePath);
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.some((c) => c.startsWith('init')), false,
    `init must NOT run against an existing OpenSpec root, got: ${calls.join(' | ')}`);
  assert.match(result.evidence.join('\n'), /already exists in service-a — skipped `openspec init`/);

  // The skip branch must still produce everything the rest of stage 5 owns. `serpens/` in
  // particular used to be created as a side effect of `openspec init`.
  assert.equal(readFileSync(join(submodulePath, LAYOUT.repoTxt), 'utf8').trim(), 'service-a');
  assert.ok(existsSync(join(submodulePath, LAYOUT.adrDir, '.gitkeep')));
  assert.ok(existsSync(join(submodulePath, LAYOUT.indexJson)));
  assert.ok(existsSync(join(submodulePath, LAYOUT.shim)));
  assert.ok(existsSync(join(submodulePath, 'lefthook.yml')));
  // The team's own config survives, with our references: appended rather than replacing it.
  const cfg = readFileSync(join(submodulePath, 'openspec', 'config.yaml'), 'utf8');
  assert.match(cfg, /^schema: spec-driven$/m);
  assert.match(cfg, /references:/);
});

for (const [label, plant, expected] of [
  ['openspec/specs/', { omit: 'specs' }, /openspec\/specs\/ \(directory does not exist\)/],
  ['openspec/changes/', { omit: 'changes' }, /openspec\/changes\/ \(directory does not exist\)/],
  ['openspec/changes/archive/', { omit: 'changes/archive' }, /openspec\/changes\/archive\/ \(directory does not exist\)/],
  ['the config', { config: null }, /config\.yaml or openspec\/config\.yml \(neither exists\)/],
  ['a config that is not YAML', { config: '{ schema: spec-driven, x: 1 }\n' }, /does not parse as YAML/],
]) {
  test(`an incomplete pre-existing openspec/ stops and names ${label}`, async () => {
    const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
    const { ctx, calls } = recordingCtx(makeCtx({ storeRoot }));
    const submodulePath = join(storeRoot, 'submodules', 'service-a');
    plantOpenspec(submodulePath, plant);

    const result = await onboardOne(ctx, submodulePath);
    assert.equal(result.ok, false, 'an incomplete OpenSpec root must stop the repository');
    assert.match(result.error, expected);
    // It must hand the human the command, WITH the reason we are not running it ourselves.
    assert.match(result.error, /openspec init --tools claude/);
    assert.match(result.error, /Upgrade and clean up legacy files\?/);
    assert.equal(calls.some((c) => c.startsWith('init')), false,
      'we must never run init for them here');
    // Nothing of ours may be written before the stop.
    assert.equal(existsSync(join(submodulePath, LAYOUT.repoTxt)), false);
    assert.equal(existsSync(join(submodulePath, 'lefthook.yml')), false);
  });
}

test('--dry-run reports both branches and writes nothing', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['green-repo', 'brown-repo']);
  const ctx = { ...makeCtx({ storeRoot }), dryRun: true };
  const brown = join(storeRoot, 'submodules', 'brown-repo');
  const green = join(storeRoot, 'submodules', 'green-repo');
  plantOpenspec(brown);

  const result = await stage5(ctx);
  assert.equal(result.ok, true, result.error);
  const text = result.evidence.join('\n');

  assert.match(text, /no openspec\/ yet → greenfield/);
  assert.match(text, /openspec\/ already exists → would SKIP `openspec init`/);

  // Nothing was written by the dry run, on either branch.
  for (const repo of [green, brown]) {
    assert.equal(existsSync(join(repo, SERPENS_DIR)), false, `${repo}: dry-run must not create ${SERPENS_DIR}/`);
    assert.equal(existsSync(join(repo, 'lefthook.yml')), false, `${repo}: dry-run must not write lefthook.yml`);
  }
  assert.equal(existsSync(join(green, 'openspec')), false, 'dry-run must not init the greenfield repo');
});

test('--dry-run names the missing piece instead of pretending it would init', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['brown-repo']);
  const ctx = { ...makeCtx({ storeRoot }), dryRun: true };
  const brown = join(storeRoot, 'submodules', 'brown-repo');
  plantOpenspec(brown, { omit: 'changes/archive' });

  const result = await stage5(ctx);
  assert.equal(result.ok, true, result.error);
  const text = result.evidence.join('\n');
  assert.match(text, /would STOP: incomplete OpenSpec root — openspec\/changes\/archive\//);
  assert.match(text, /run by hand in .*brown-repo: openspec init --tools claude/);
});

// --- gap 8: lefthook ownership check ---------------------------------------------------------

/** Record every argv passed to a command matching `re`. */
function trackingCtx(base, re) {
  const calls = [];
  const inner = base.run;
  return {
    ctx: {
      ...base,
      run: (cmd, args, opts) => {
        if (re.test(cmd)) calls.push([cmd, ...args].join(' '));
        return inner(cmd, args, opts);
      },
    },
    calls,
  };
}

test('gap 8 (a): empty repo -> lefthook.yml written, marked, lefthook installed', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const { ctx, calls } = trackingCtx(makeCtx({ storeRoot }), /lefthook/);
  const submodulePath = join(storeRoot, 'submodules', 'service-a');

  const result = await onboardOne(ctx, submodulePath);
  assert.equal(result.ok, true, result.error);

  const lefthookYml = readFileSync(join(submodulePath, 'lefthook.yml'), 'utf8');
  assert.ok(lefthookYml.startsWith(LEFTHOOK_MARKER));
  assert.ok(calls.some((c) => c.endsWith('install')), 'lefthook install must run');
});

test('gap 8 (b): our marked lefthook.yml is rewritten', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const submodulePath = join(storeRoot, 'submodules', 'service-a');
  const ctx1 = makeCtx({ storeRoot });
  await onboardOne(ctx1, submodulePath);
  const first = readFileSync(join(submodulePath, 'lefthook.yml'), 'utf8');
  assert.ok(first.startsWith(LEFTHOOK_MARKER));

  // Re-run against the same, now-marked file.
  const result = await onboardOne(makeCtx({ storeRoot }), submodulePath);
  assert.equal(result.ok, true, result.error);
  const second = readFileSync(join(submodulePath, 'lefthook.yml'), 'utf8');
  assert.ok(second.startsWith(LEFTHOOK_MARKER));
});

test('gap 8 (c): an unmarked team lefthook.yml survives byte-identical; ours goes to serpens/lefthook.yml', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const submodulePath = join(storeRoot, 'submodules', 'service-a');
  const teamConfig = 'pre-commit:\n  commands:\n    lint:\n      run: eslint .\n';
  writeFileSync(join(submodulePath, 'lefthook.yml'), teamConfig, 'utf8');

  const { ctx, calls } = trackingCtx(makeCtx({ storeRoot }), /lefthook/);
  const result = await onboardOne(ctx, submodulePath);
  assert.equal(result.ok, true, result.error);

  assert.equal(readFileSync(join(submodulePath, 'lefthook.yml'), 'utf8'), teamConfig,
    'the team file must be byte-identical');
  const oursPath = join(submodulePath, LAYOUT.lefthookFallback);
  assert.ok(existsSync(oursPath), 'our config must land at serpens/lefthook.yml');
  assert.ok(readFileSync(oursPath, 'utf8').startsWith(LEFTHOOK_MARKER));

  const text = result.evidence.join('\n');
  assert.match(text, /extends:\n\s*- serpens\/lefthook\.yml/);
  assert.equal(calls.some((c) => c.endsWith('install')), false,
    'lefthook install must not run when we do not own the team hooks');
});

test('gap 8 (d): only a team .lefthook.yml -> no lefthook.yml created, ours goes to the fallback path', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-a']);
  const submodulePath = join(storeRoot, 'submodules', 'service-a');
  writeFileSync(join(submodulePath, '.lefthook.yml'), 'pre-commit:\n  commands: {}\n', 'utf8');

  const result = await onboardOne(makeCtx({ storeRoot }), submodulePath);
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(join(submodulePath, 'lefthook.yml')), false,
    'must never create lefthook.yml alongside a team .lefthook.yml (shadowing)');
  assert.ok(existsSync(join(submodulePath, LAYOUT.lefthookFallback)));
});

test('gap 8 (e): dry-run plan names the branch the lefthook decision would take', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['clean-repo', 'team-repo']);
  const teamRepo = join(storeRoot, 'submodules', 'team-repo');
  writeFileSync(join(teamRepo, 'lefthook.yml'), 'pre-commit:\n  commands: {}\n', 'utf8');
  const ctx = { ...makeCtx({ storeRoot }), dryRun: true };

  const result = await stage5(ctx);
  assert.equal(result.ok, true, result.error);
  const text = result.evidence.join('\n');
  const sections = text.split(/(?=dry-run: would onboard )/);
  const cleanSection = sections.find((s) => s.includes('clean-repo'));
  const teamSection = sections.find((s) => s.includes('team-repo'));
  assert.ok(cleanSection, 'no plan section for clean-repo');
  assert.ok(teamSection, 'no plan section for team-repo');
  assert.match(cleanSection, /write .*clean-repo\/lefthook\.yml.*marked/);
  assert.match(teamSection, /serpens\/lefthook\.yml/);
  assert.match(teamSection, /extends/);
  assert.doesNotMatch(teamSection, /write .*team-repo\/lefthook\.yml(?!\.)/,
    'plan must not claim it would write team-repo/lefthook.yml when a team config already owns it');

  // Nothing written on a dry run.
  for (const repo of [join(storeRoot, 'submodules', 'clean-repo'), teamRepo]) {
    assert.equal(existsSync(join(repo, SERPENS_DIR)), false);
  }
  assert.equal(existsSync(join(teamRepo, 'lefthook.yml')), true, 'the team file must still be the only one on disk');
});

// Step 4 of the coexistence spec (gap 4): the HARD RULE must be scoped to Serpens-owned work
// only, in both languages, and a stale block from an older release must be replaced in place —
// never duplicated, never left stale.
for (const lang of ['en', 'ru']) {
  test(`HARD_RULE_BLOCKS.${lang} is scoped to Serpens-owned work, not generic ANY/ALL wording`, () => {
    const block = HARD_RULE_BLOCKS[lang];
    assert.match(block, /\.serpens\.yaml/);
    assert.doesNotMatch(block, /\bANY\b|\bALL\b/, 'EN/RU HARD RULE body must not bind to ANY/ALL work');
    assert.doesNotMatch(block, /ЛЮБОЙ|ВСЕХ/, 'RU HARD RULE body must not bind to ЛЮБОЙ/ВСЕХ work');
    assert.match(block, new RegExp(HARD_RULE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('appendHardRuleOnce writes the current block to a fresh file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-hardrule-'));
  const path = join(dir, 'CLAUDE.md');
  const changed = appendHardRuleOnce(path, 'en');
  assert.equal(changed, true);
  assert.equal(readFileSync(path, 'utf8'), HARD_RULE_BLOCKS.en);
});

test('appendHardRuleOnce is a no-op the second time (current version, not duplicated)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-hardrule-'));
  const path = join(dir, 'CLAUDE.md');
  assert.equal(appendHardRuleOnce(path, 'en'), true);
  const before = readFileSync(path, 'utf8');
  assert.equal(appendHardRuleOnce(path, 'en'), false);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('appendHardRuleOnce replaces a stale block in place, team text above and below untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-hardrule-'));
  const path = join(dir, 'CLAUDE.md');
  const staleBlock = `${HARD_RULE_MARKER}\n`
    + 'After creating or editing ANY file under openspec/ or serpens/, run:\n'
    + '    verify-docs\n'
    + 'do not keep looping.\n';
  const before = '# Team conventions\n\nSome team prose here.\n\n';
  const after = '## Another team section\n\nMore team prose.\n';
  writeFileSync(path, `${before}${staleBlock}${after}`, 'utf8');

  const changed = appendHardRuleOnce(path, 'en');
  assert.equal(changed, true);

  const result = readFileSync(path, 'utf8');
  assert.ok(result.startsWith(before), 'team text before the block must be byte-identical');
  assert.ok(result.endsWith(after), 'team text after the block must be byte-identical');
  assert.equal(result, `${before}${HARD_RULE_BLOCKS.en}${after}`);
  assert.equal(result.split('disposer self-check').length - 1, 1, 'the stale block must be replaced, not duplicated');
  assert.doesNotMatch(result, /\bANY\b/);
});

test('onboardOne writes the RU HARD RULE block for a ru-lang install', async () => {
  const { storeRoot } = makeStoreWithRealSubmodules(['service-ru']);
  const ctx = makeCtx({ storeRoot });
  ctx.config.lang = 'ru';

  const result = await onboardOne(ctx, join(storeRoot, 'submodules', 'service-ru'));
  assert.equal(result.ok, true, result.error);

  const claudeMd = readFileSync(join(storeRoot, 'submodules', 'service-ru', 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /\.serpens\.yaml/);
  assert.doesNotMatch(claudeMd, /ЛЮБОЙ|ВСЕХ/);
});
