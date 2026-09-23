import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import initMain from '../src/cli/init.mjs';
import { proveBadCommitRejected } from '../src/stages/stage8-guards.mjs';
import { onboardOne } from '../src/stages/stage5-onboard.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';
import { run } from '../src/run.mjs';
import { kitPath } from '../src/integrity.mjs';
import { fakeOpenspec } from './helpers/fixture.mjs';
import { fillTestingStack } from './helpers/testing-stack.mjs';
import { renderTestingStack } from '../src/testingstack.mjs';

const KIT_DIR = kitPath('en');
const BASE = 'main';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGitRepo(dir, { branch = BASE } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch, dir]);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  git(dir, ['config', 'user.name', 'E2E']);
  return dir;
}

/** A bare "system store" remote that already carries a base commit AND an openspec/ root —
 * matching a store an earlier onboarding already created, so stage3 clones it (never inits a
 * second history) and `state prepare-base` succeeds on every subsequent run. */
function makeStoreRemote() {
  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-store-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-store-work-'));
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

/** A no-op `lefthook` stub on PATH: `install` (and anything else) exits 0 without doing
 * anything real — sufficient for stage5's onboarding, which only calls `lefthook install`. */
function noopLefthook(dir) {
  const binDir = mkdtempSync(join(dir, 'lefthook-noop-'));
  const p = join(binDir, 'lefthook');
  writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(p, 0o755);
  return binDir;
}

/** A real (if minimal) `lefthook` stand-in: `install` is a no-op, and `run <hook>` actually
 * parses the installed `lefthook.yml` (the exact shape `renderLefthook` produces) and executes
 * every `run:` command line found under that hook's block, offline, exiting non-zero if any of
 * them do. lefthook itself is not installable in this offline sandbox, so this is what proves
 * the pre-commit path is real and green rather than merely present on disk. */
function capableLefthook(dir) {
  const binDir = mkdtempSync(join(dir, 'lefthook-capable-'));
  const p = join(binDir, 'lefthook');
  const script = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'install') process.exit(0);
if (args[0] !== 'run') process.exit(0);
const hook = args[1];
const text = readFileSync('lefthook.yml', 'utf8');
const lines = text.split('\\n');
let inBlock = false;
const cmds = [];
for (const line of lines) {
  if (/^[A-Za-z0-9_-]+:\\s*$/.test(line)) { inBlock = line.trim() === hook + ':'; continue; }
  if (inBlock) {
    const m = /^\\s*run:\\s*(.+)$/.exec(line);
    // YAML single-quoted scalar (what renderLefthook emits): strip the quotes, undouble ''.
    if (m) cmds.push(/^'.*'$/.test(m[1]) ? m[1].slice(1, -1).replaceAll("''", "'") : m[1]);
  }
}
let failed = false;
for (const cmd of cmds) {
  try {
    execSync(cmd, { stdio: 'pipe', shell: '/bin/sh' });
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
`;
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return binDir;
}

function hashTree(root) {
  const hash = createHash('sha256');
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.git') continue;
      if (/^\.serpens-sdd-init-.*\.log$/.test(e.name)) continue; // the run log itself always differs
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  }(root));
  for (const f of files) {
    hash.update(relative(root, f));
    hash.update(readFileSync(f));
  }
  return hash.digest('hex');
}

function porcelainStatus(storeRoot) {
  return git(storeRoot, ['status', '--porcelain', '--ignore-submodules=untracked'])
    .split('\n')
    .filter((l) => !l.includes('.serpens-sdd-init-'))
    .sort()
    .join('\n');
}

/** A plain bare remote with one commit and no `openspec/` scaffolding — a real project
 * repository, offline, matching what `config.repositories` names (never the store). */
function makePlainBareRemote(name) {
  const bareDir = mkdtempSync(join(tmpdir(), `serpens-sdd-e2e-project-remote-${name}-`));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), `serpens-sdd-e2e-project-work-${name}-`));
  initGitRepo(workDir);
  writeFileSync(join(workDir, 'README.md'), `# ${name}
`);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);
  return bareDir;
}

/**
 * Build a full offline fixture: a store remote (pre-populated), a repo directory to run
 * `init` from, a fake `openspec`, and a JSON config file (the shape `configTemplate` and
 * `--config` both use). `repositories` names real, offline project repositories to include —
 * each becomes a real bare remote and a `repositories[]` entry, exercising stage 4/5 for real.
 * Returns everything a test needs plus a `run()` helper that invokes `initMain` with the right
 * env/argv set up, restoring `process.env` afterwards.
 */
function makeFixture({ withLefthookBin, repositories = [], openspecVersion = '1.13.0', pinnedVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-'));
  const storeRemote = makeStoreRemote();
  const storeRoot = join(root, 'store');
  const repoRoot = join(root, 'repo');
  initGitRepo(repoRoot);

  const oss = fakeOpenspec(root, { version: openspecVersion });
  const lefthookBin = withLefthookBin ?? noopLefthook(root);

  const repoEntries = repositories.map((name) => ({
    name, url: makePlainBareRemote(name), base_branch: BASE,
  }));

  const openspec = { invocation: 'openspec' };
  if (pinnedVersion !== undefined) openspec.pinned_version = pinnedVersion;

  const configPath = join(repoRoot, 'serpens-sdd.json');
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    project: 'acme',
    lang: 'en',
    port: 'claude',
    openspec,
    store: { remote: storeRemote, base_branch: BASE, root: storeRoot },
    repositories: repoEntries,
    facts: { repository_source: 'manual' },
  }, null, 2), 'utf8');

  return { root, storeRemote, storeRoot, repoRoot, configPath, oss, lefthookBin };
}

async function runInit(fixture, extraArgv = [], envOverrides = {}) {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  process.chdir(fixture.repoRoot);
  process.env.PATH = `${fixture.oss.binDir}:${fixture.lefthookBin}:${process.env.PATH}`;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  Object.assign(process.env, envOverrides);
  try {
    return await initMain(['--config', fixture.configPath, '--non-interactive', ...extraArgv]);
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
  }
}

/**
 * Same as runInit, but also captures everything written to stdout. The captured chunks are
 * ALSO forwarded to the real stdout: `node --test` reports each finished test by writing to
 * this same stream, so a capture that swallows its writes silently loses whole test results
 * from the run summary (observed: the test declared just before a capturing one disappeared
 * from the TAP output while still counting as neither pass nor fail).
 */
async function runInitCapturingStdout(fixture, extraArgv = [], envOverrides = {}) {
  const savedWrite = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (chunk, ...rest) => { printed += chunk; return savedWrite(chunk, ...rest); };
  try {
    const code = await runInit(fixture, extraArgv, envOverrides);
    return { code, printed };
  } finally {
    process.stdout.write = savedWrite;
  }
}

/** Replace every `UNFILLED — …` line in a file, the operator's own follow-up step (spec §12). */
// A team filling in `serpens/testing-stack.md` completely: every `UNFILLED` line, every slot, and
// the template's own `...` placeholder rows. Shared with the other suites (and self-checked
// against the schema) in test/helpers/testing-stack.mjs.
const fillUnfilled = fillTestingStack;

test('a full init against bare remotes ends green', async () => {
  const fixture = makeFixture();
  const code = await runInit(fixture);
  assert.equal(code, 0);

  assert.ok(existsSync(join(fixture.storeRoot, 'serpens', 'port-facts.md')));
  // Project scope (claude) installs into the STORE — spec §5.4 — never into the directory the
  // CLI was invoked from.
  assert.ok(existsSync(join(fixture.storeRoot, '.claude', 'commands', 'spns', 'spec.md')));
  assert.ok(existsSync(join(fixture.storeRoot, '.claude', 'skills', 'spns-tdd', 'SKILL.md')));
  assert.equal(existsSync(join(fixture.repoRoot, '.claude')), false,
    'the CLI working directory must never be an install target');
  assert.equal(existsSync(join(fixture.repoRoot, 'serpens', 'testing-stack.md')), false,
    'testing-stack.md belongs to each onboarded repository, not to the cwd');

  const logs = readdirSync(fixture.storeRoot).filter((f) => /^\.serpens-sdd-init-.*\.log$/.test(f));
  assert.equal(logs.length, 1, 'expected exactly one run log');
  const logText = readFileSync(join(fixture.storeRoot, logs[0]), 'utf8');
  for (const marker of [
    'stage 0 (prereqs) OK', 'stage 3 (store) OK', 'stage 1 (inventory) OK',
    'stage 4 (submodules) OK', 'stage 5 (onboard) OK', 'stage 6 (install) OK',
    'stage 8 (guards) OK', 'stage 9 (accept) OK', 'serpens-sdd init completed green',
  ]) {
    assert.ok(logText.includes(marker), `expected the run log to include "${marker}"`);
  }
});

/**
 * Snapshot every file under `root`, with NO exclusions (unlike `hashTree`, which deliberately
 * skips `.git` and the run log — this snapshot must catch exactly those, since a write to
 * either would be the bug). Returns a sorted `relative-path -> sha256` map so a diff names
 * exactly what changed, not just that something did.
 * @param {string} root
 * @returns {Record<string, string>}
 */
function snapshotDir(root) {
  const out = {};
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // Record the directory entry itself — not just its contents — so a newly created
        // EMPTY directory (nothing written inside it, but a real filesystem change) still
        // shows up as a diff instead of silently escaping detection.
        out[`${relative(root, p)}/`] = 'dir';
        walk(p);
      } else {
        out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  }(root));
  return out;
}

test('an out-of-window OpenSpec version writes nothing at all, and reports the detected version', async () => {
  // '2.4.6' is deliberately outside SUPPORTED_MINORS (1.13, 1.12, 1.11) — a real, parseable,
  // out-of-window version, exercising the 'unsupported' path (not 'unparseable').
  const fixture = makeFixture({ openspecVersion: '2.4.6' });

  // storeRoot must not exist yet: this is the case where the old pre-stage-0 `log.attach`
  // could still leave a `.serpens-sdd-init-*.log` behind once the store existed. Confirmed
  // absent up front so the snapshot below is a true "nothing existed, nothing was created".
  assert.equal(existsSync(fixture.storeRoot), false);

  const before = snapshotDir(fixture.root);

  const savedWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk, ...rest) => { stderr += chunk; return savedWrite(chunk, ...rest); };
  let code;
  try {
    code = await runInit(fixture);
  } finally {
    process.stderr.write = savedWrite;
  }

  assert.equal(code, 3, 'an out-of-window version must be exit 3');
  assert.match(stderr, /2\.4\.6/, 'the detected version must be printed to stderr, not lost');
  assert.match(stderr, /1\.13, 1\.12, 1\.11/, 'the three supported minors must be named in the diagnostic');

  assert.equal(existsSync(fixture.storeRoot), false, 'the store must never be created');

  const after = snapshotDir(fixture.root);
  assert.deepEqual(after, before, 'the target directory must be byte-for-byte unchanged, including no run log');
});

test('an out-of-window OpenSpec version against an ALREADY-EXISTING store root leaves it byte-for-byte unchanged', async () => {
  // The absent-store case above exercises init.mjs's pre-attach guard (`existsSync(storeRoot)`
  // false, so the early-attach branch is never reached at all — the ORIGINAL bug there is
  // unreachable and this suite would stay green even with that line restored). This test
  // exercises the other branch: a store root that already exists on disk (a prior successful
  // run) is exactly the case the original `if (!dryRun && existsSync(storeRoot))
  // log.attach(...)` line — placed before stage 0 ran — would still corrupt, by writing a
  // fresh `.serpens-sdd-init-*.log` into it on a run that must write nothing.
  const fixture = makeFixture();
  const first = await runInit(fixture);
  assert.equal(first, 0, 'the seeding run must succeed so the store root really exists on disk');
  assert.equal(existsSync(fixture.storeRoot), true);

  const before = snapshotDir(fixture.storeRoot);

  // Swap in an out-of-window `openspec` on the SAME PATH the fixture already uses — same
  // fixture, same (now-existing) store root, only the detected version changes.
  fixture.oss = fakeOpenspec(fixture.root, { version: '2.4.6' });

  const savedWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk, ...rest) => { stderr += chunk; return savedWrite(chunk, ...rest); };
  let code;
  try {
    code = await runInit(fixture);
  } finally {
    process.stderr.write = savedWrite;
  }

  assert.equal(code, 3, 'an out-of-window version must be exit 3 even with an existing store root');
  assert.match(stderr, /2\.4\.6/, 'the detected version must be printed to stderr, not lost');
  assert.match(stderr, /1\.13, 1\.12, 1\.11/, 'the three supported minors must be named in the diagnostic');

  const after = snapshotDir(fixture.storeRoot);
  assert.deepEqual(after, before, 'an existing store root must be byte-for-byte unchanged, including no new run log');

  const logs = readdirSync(fixture.storeRoot).filter((f) => /^\.serpens-sdd-init-.*\.log$/.test(f));
  assert.equal(logs.length, 1, 'no NEW log must be written; only the seeding run\'s own log may exist');
});

test('an explicit pinned_version matching the detected version ends green end-to-end', async () => {
  // makeFixture no longer sets a pin by default (spec §3: pinned_version is optional) — this
  // is the end-to-end coverage for a shop that DOES set one, and sets it correctly.
  const fixture = makeFixture({ openspecVersion: '1.12.4', pinnedVersion: '1.12.4' });
  const code = await runInit(fixture);
  assert.equal(code, 0, 'a pin that matches the detected version must not block the run');
  assert.ok(existsSync(fixture.storeRoot), 'a passing run must actually write the store');
});

test('an explicit pinned_version that disagrees with the detected version fails exit 3, writing nothing', async () => {
  const fixture = makeFixture({ openspecVersion: '1.12.4', pinnedVersion: '1.13.0' });
  assert.equal(existsSync(fixture.storeRoot), false);
  const before = snapshotDir(fixture.root);

  const savedWrite = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk, ...rest) => { stderr += chunk; return savedWrite(chunk, ...rest); };
  let code;
  try {
    code = await runInit(fixture);
  } finally {
    process.stderr.write = savedWrite;
  }

  assert.equal(code, 3, 'a pin mismatch must be exit 3, even though 1.12.4 is itself in-window');
  assert.match(stderr, /expected pinned 1\.13\.0, got '1\.12\.4'/, 'the mismatch must name both the pin and the detected version');
  assert.equal(existsSync(fixture.storeRoot), false, 'the store must never be created on a pin mismatch');

  const after = snapshotDir(fixture.root);
  assert.deepEqual(after, before, 'a pin-mismatch run must leave the target directory byte-for-byte unchanged');
});

test('a second run is a no-op', async () => {
  // A real project repository is included so this proves idempotence for the headline case —
  // stage4 now commits sync-submodules.sh's staged `.gitmodules`/gitlink registration (fix
  // round 1), which is what makes a second run's `state prepare-base` accept the store at all.
  const fixture = makeFixture({ repositories: ['svc-a'] });
  const first = await runInit(fixture);
  assert.equal(first, 0, 'first run must be green');
  assert.ok(existsSync(join(fixture.storeRoot, 'submodules', 'svc-a', 'README.md')), 'svc-a must be a real, materialized submodule');

  // Stage 6 leaves `svc-a/serpens/testing-stack.md` carrying a literal UNFILLED marker, and per
  // spec §9 an install "cannot be closed on unfilled facts" — the spoke's own verify-docs gate
  // (run by stage 5) refuses while it remains. So the operator's §12 follow-up happens here,
  // exactly once, and the re-run below is then measured on a genuinely green install: it must
  // add nothing of its own. (The store's `port-facts.md` is deliberately left as stage 6
  // renders it: stage 6 owns that file and rewrites it from what each run proved.)
  fillUnfilled(join(fixture.storeRoot, 'submodules', 'svc-a', 'serpens', 'testing-stack.md'));

  const beforeHash = hashTree(fixture.storeRoot);
  const beforeStatus = porcelainStatus(fixture.storeRoot);

  const second = await runInit(fixture);
  assert.equal(second, 0, 'second run must also be green');

  const afterHash = hashTree(fixture.storeRoot);
  const afterStatus = porcelainStatus(fixture.storeRoot);

  assert.equal(afterHash, beforeHash, 'the store tree must be byte-identical after a no-op re-run');
  assert.equal(afterStatus, beforeStatus, 'git status --porcelain must be unchanged after a no-op re-run');
});

test('--dry-run touches nothing, on a fresh target and on a green install', async () => {
  const fresh = makeFixture();
  const dryOnFresh = await runInit(fresh, ['--dry-run']);
  assert.equal(dryOnFresh, 0);
  assert.equal(existsSync(fresh.storeRoot), false, 'dry-run must never create the store on a fresh target');

  const green = makeFixture();
  const first = await runInit(green);
  assert.equal(first, 0);
  const beforeHash = hashTree(green.storeRoot);
  const beforeRepoFiles = readdirSync(green.repoRoot, { recursive: true }).sort();

  const dryOnGreen = await runInit(green, ['--dry-run']);
  assert.equal(dryOnGreen, 0);
  assert.equal(hashTree(green.storeRoot), beforeHash, 'dry-run on a green install must not change the store');
  assert.deepEqual(readdirSync(green.repoRoot, { recursive: true }).sort(), beforeRepoFiles);
});

test('lefthook pre-commit is green with the registry unreachable, in a repo with no package.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-lh-home-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-lh-bin-'));
  const oss = fakeOpenspec(fixtureDir, { version: '9.9.9' });
  const lefthookBin = noopLefthook(fixtureDir);
  const env = {
    ...oss.pathPrepend(process.env),
    PATH: `${lefthookBin}:${oss.pathPrepend(process.env).PATH}`,
    GIT_ALLOW_PROTOCOL: 'file',
  };
  const wrappedRun = (cmd, args, opts = {}) => run(cmd, args, { ...opts, env });

  const bareDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-lh-remote-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', BASE, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-lh-work-'));
  initGitRepo(workDir);
  writeFileSync(join(workDir, 'README.md'), '# service\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', BASE]);

  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-lh-store-'));
  git(storeRoot, ['init', '-q', '-b', BASE, storeRoot]);
  git(storeRoot, ['config', 'user.email', 'e2e@example.com']);
  git(storeRoot, ['config', 'user.name', 'E2E']);
  writeFileSync(join(storeRoot, 'README.md'), '# store\n');
  git(storeRoot, ['add', '-A']);
  git(storeRoot, ['commit', '-q', '-m', 'initial commit']);
  git(storeRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '-b', BASE, bareDir, 'submodules/service-a']);
  git(storeRoot, ['add', '-A']);
  git(storeRoot, ['commit', '-q', '-m', 'add submodule']);

  const CLAUDE_PORT = {
    id: 'claude', agent_dir: '.claude', scope_preference: ['project'], instruction_file: 'CLAUDE.md',
    commands_supported: true, skills_supported: true,
  };
  const config = {
    project: 'acme',
    store: { id: 'acme-store', root: storeRoot, remote: bareDir, base_branch: BASE },
    openspec: { invocation: 'openspec', pinned_version: '9.9.9' },
    port_scope: 'auto',
  };
  const ctx = {
    config, port: CLAUDE_PORT, run: wrappedRun, storeRoot, kitDir: KIT_DIR, home,
  };
  const onboarded = await onboardOne(ctx, join(storeRoot, 'submodules', 'service-a'));
  assert.equal(onboarded.ok, true, onboarded.error);

  const repoRoot = join(storeRoot, 'submodules', 'service-a');
  assert.equal(existsSync(join(repoRoot, 'package.json')), false, 'fixture must have no package.json');
  assert.ok(existsSync(join(repoRoot, 'lefthook.yml')));

  // This test drives stage 5 alone, but a real pre-commit only ever runs in a repository stage 6
  // also finished — and stage 6 is what writes `serpens/testing-stack.md`, whose absence in an
  // onboarded repository verify-docs now (correctly) refuses. Stand stage 6 in, filled, so the
  // subject of THIS test stays what it says on the tin: the pre-commit path never touching the
  // npm registry.
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'serpens', 'testing-stack.md'),
    renderTestingStack(readFileSync(join(KIT_DIR, 'templates', 'testing-stack.md'), 'utf8')),
    'utf8',
  );
  fillTestingStack(join(repoRoot, 'serpens', 'testing-stack.md'));

  // Stage everything onboarding wrote — a real pre-commit hook runs against staged content, and
  // verify-docs' own index check (fix round 3) now requires the index to be tracked, not merely
  // present on disk. onboardOne itself never stages (it must stay re-runnable against its own
  // not-yet-committed writes — see checkGitTracking: false in stage5-onboard.mjs); the operator
  // does, right before the commit this test's `lefthook run pre-commit` stands in for.
  git(repoRoot, ['add', '-A']);

  // A real "lefthook run pre-commit" stand-in, with the npm registry pointed unroutable — proof
  // that the whole pre-commit path (the shim -> serpens-sdd verify-docs) never depends on it.
  const capableBin = capableLefthook(fixtureDir);
  const runEnv = {
    ...env,
    PATH: `${capableBin}:${env.PATH}`,
    npm_config_registry: 'http://127.0.0.1:1/',
  };
  let out = '';
  let code = 0;
  try {
    out = execSync('lefthook run pre-commit', { cwd: repoRoot, env: runEnv, encoding: 'utf8' });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.equal(code, 0, `expected lefthook run pre-commit to exit 0, output:\n${out}`);
});

test('stage 8 fails when a guard is weakened', async () => {
  const result = await proveBadCommitRejected({ run }, { hookBody: '#!/bin/sh\nexit 0\n' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /accepted a bad commit/);
});

test('--only 4,9 against an existing but deinitialized submodule restores the checkout (defect: a partial rerun must not silently no-op)', async () => {
  // Before spec-drop-inventory-file-2026-09-11.md, stage1's resolved rows lived only on
  // ctx.repositoryRows for the run that computed them. `--only 4,9` never runs stage 1, so
  // ctx.repositoryRows was undefined and stage4/stage9 defaulted it to `[]` — sync-submodules.sh
  // then reconciled ZERO repositories, exited 0, and a deinitialized submodule was left exactly
  // as deinitialized: a silent success over a real no-op. This test drives the real CLI
  // (`initMain`), not stage functions directly.
  const fixture = makeFixture({ repositories: ['svc-a'] });
  const first = await runInit(fixture);
  assert.equal(first, 0, 'the seeding run must succeed');

  const spokeDir = join(fixture.storeRoot, 'submodules', 'svc-a');
  assert.ok(existsSync(join(spokeDir, 'README.md')), 'svc-a must be a real, materialized submodule after the seeding run');

  // Deinitialize it: .gitmodules and the gitlink survive, the checkout is emptied.
  git(fixture.storeRoot, ['submodule', 'deinit', '-f', 'submodules/svc-a']);
  assert.equal(existsSync(join(spokeDir, 'README.md')), false, 'sanity check: deinit must have actually emptied the checkout');

  const repaired = await runInit(fixture, ['--only', '4,9']);
  assert.equal(repaired, 0, 'a partial --only 4,9 rerun must still succeed');

  assert.ok(existsSync(join(spokeDir, 'README.md')),
    'the deinitialized submodule checkout must be RESTORED by --only 4,9 — an empty ctx.repositoryRows default would leave it absent while still exiting 0');
  const subStatus = git(fixture.storeRoot, ['submodule', 'status']);
  assert.doesNotMatch(subStatus, /^-/m, 'git submodule status must show no uninitialized ("-") submodules after the repair');
});

test('--only 4 ALONE restores the checkout — stage 9 must not be what saves a stage-4 regression', async () => {
  // The `--only 4,9` test above passes even when stage 4 silently no-ops, because stage 9
  // re-resolves the rows and re-runs sync-submodules, repairing what stage 4 skipped. Verified
  // by mutation: defaulting ctx.repositoryRows to `[]` in stage 4 alone left that test GREEN.
  // `--only 4` is a documented invocation in its own right, so it gets its own isolating test.
  const fixture = makeFixture({ repositories: ['svc-a'] });
  assert.equal(await runInit(fixture), 0, 'the seeding run must succeed');

  const spokeDir = join(fixture.storeRoot, 'submodules', 'svc-a');
  git(fixture.storeRoot, ['submodule', 'deinit', '-f', 'submodules/svc-a']);
  assert.equal(existsSync(join(spokeDir, 'README.md')), false, 'sanity check: deinit must have actually emptied the checkout');

  assert.equal(await runInit(fixture, ['--only', '4']), 0, 'a partial --only 4 rerun must still succeed');
  assert.ok(existsSync(join(spokeDir, 'README.md')),
    'stage 4 ALONE must restore the checkout; an empty ctx.repositoryRows default would exit 0 having reconciled nothing');
});

test('--only 6 repairs a partial install without re-running stage 3', async () => {
  const fixture = makeFixture();
  const first = await runInit(fixture);
  assert.equal(first, 0);

  const storeReadmeBefore = readFileSync(join(fixture.storeRoot, 'README.md'), 'utf8');
  const storeMtimeBefore = statSync(join(fixture.storeRoot, 'README.md')).mtimeMs;

  // Simulate a partial install: the installed commands are gone.
  const commandDir = join(fixture.storeRoot, '.claude', 'commands', 'spns');
  for (const f of readdirSync(commandDir)) {
    unlinkSync(join(commandDir, f));
  }

  const repaired = await runInit(fixture, ['--only', '6']);
  assert.equal(repaired, 0);
  assert.ok(existsSync(join(commandDir, 'spec.md')), 'stage 6 should have re-installed the commands');

  // Never re-ran stage 3: the store's README (only ever written by stage3's template/clone
  // path) is untouched, in content AND on disk (no fresh write).
  assert.equal(readFileSync(join(fixture.storeRoot, 'README.md'), 'utf8'), storeReadmeBefore);
  assert.equal(statSync(join(fixture.storeRoot, 'README.md')).mtimeMs, storeMtimeBefore);
});

async function runWithCapturedStderr(argv) {
  const savedWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  try {
    const code = await initMain(argv);
    return { code, captured };
  } finally {
    process.stderr.write = savedWrite;
  }
}

test('--only \'\' is exit 2 and never runs a stage', async () => {
  const { code, captured } = await runWithCapturedStderr(['--only', '', '--non-interactive']);
  assert.equal(code, 2);
  assert.match(captured, /--only/);
});

test('--only 99 (an unknown stage id) is exit 2, never silently green', async () => {
  const { code, captured } = await runWithCapturedStderr(['--only', '99', '--non-interactive']);
  assert.equal(code, 2);
  assert.match(captured, /99/);
});

test('--only 6,99 (one good id mixed with one unknown) is exit 2, not a partial run', async () => {
  const { code, captured } = await runWithCapturedStderr(['--only', '6,99', '--non-interactive']);
  assert.equal(code, 2);
  assert.match(captured, /99/);
});

test('a missing required input without a TTY is exit 2 naming the flag', async () => {
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SERPENS_SDD_')) delete process.env[key];
  }
  const savedWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  let code;
  try {
    code = await initMain(['--non-interactive']);
  } finally {
    process.stderr.write = savedWrite;
    process.env = savedEnv;
  }
  assert.equal(code, 2);
  assert.match(captured, /--project/);
});

test('an onboarded spoke gets its own serpens/testing-stack.md, and its UNFILLED marker gates that spoke verify-docs run until it is filled', async () => {
  const fixture = makeFixture({ repositories: ['svc-a'] });
  const code = await runInit(fixture);
  assert.equal(code, 0);

  const spoke = join(fixture.storeRoot, 'submodules', 'svc-a');
  const testingStack = join(spoke, 'serpens', 'testing-stack.md');
  assert.ok(existsSync(testingStack), 'the spoke must receive its own serpens/testing-stack.md');
  assert.match(readFileSync(testingStack, 'utf8'), /^UNFILLED — /m);

  // Stage (never commit — onboardOne itself never does either) everything onboarding wrote, so
  // the ONLY remaining gate this test isolates is testing-stack.md's UNFILLED marker, not the
  // index's own git-tracking check (fix round 3) — a separate concern already covered by
  // test/verify-docs.test.mjs.
  execFileSync('git', ['add', '-A'], { cwd: spoke });

  // The gate is reachable for a spoke now that the file actually lands there: verify-docs must
  // refuse this repository by name while the marker remains.
  const gated = await runVerifyDocs({ repoRoot: spoke });
  assert.equal(gated.ok, false, 'verify-docs must fail while testing-stack.md carries UNFILLED');
  const gatedText = `${gated.evidence.join('\n')}${gated.output}`;
  assert.match(gatedText, /testing-stack\.md/);
  assert.match(gatedText, /UNFILLED/);

  // ...and pass once the team fills it in, with nothing else changed.
  fillUnfilled(testingStack);
  const ungated = await runVerifyDocs({ repoRoot: spoke });
  assert.equal(ungated.ok, true, ungated.output);
});

test('--offline is green when every generated call site has route 1, and exit 3 when one does not', async () => {
  const fixture = makeFixture();
  const { code, printed } = await runInitCapturingStdout(fixture, ['--offline']);
  assert.equal(code, 0, 'a store carrying the generated shim satisfies --offline');
  assert.match(printed, /--offline: route 1 or 2 present/);
  assert.ok(existsSync(join(fixture.storeRoot, 'serpens', 'bin', 'serpens-sdd')));

  // Now take the offline route away from that one call site (nothing else touched) and assert
  // the flag actually fails the install instead of handing CI a false assurance.
  unlinkSync(join(fixture.storeRoot, 'serpens', 'bin', 'serpens-sdd'));
  const savedWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  let failing;
  try {
    failing = await runInit(fixture, ['--only', '9', '--offline']);
  } finally {
    process.stderr.write = savedWrite;
  }
  assert.equal(failing, 3, '--offline with no route 1 or 2 must be exit 3 (missing precondition)');
  assert.match(captured, /--offline/);
  assert.match(captured, /serpens\/bin\/serpens-sdd/);
});

test('--dry-run prints the plan for every stage — the commands and the file writes — while still touching nothing', async () => {
  const fixture = makeFixture();
  const { code, printed } = await runInitCapturingStdout(fixture, ['--dry-run']);
  assert.equal(code, 0);
  assert.equal(existsSync(fixture.storeRoot), false, 'dry-run must never create the store');

  for (const id of [0, 3, 1, 4, 5, 6, 8, 9]) {
    assert.match(printed, new RegExp(`=== stage ${id} \\(.*\\) — plan ===`), `expected a plan block for stage ${id}`);
  }
  // stage 0: the real probe commands, from the same table the real run iterates
  assert.match(printed, /\$ git --version/);
  assert.match(printed, /\$ lefthook version/);
  // stage 3: the remote probe that decides the case, and the files it would write
  assert.match(printed, /\$ git ls-remote --heads/);
  assert.match(printed, new RegExp(`\\$ cp .*templates/adr\\.md ${fixture.storeRoot}/serpens/templates/adr\\.md`));
  assert.match(printed, new RegExp(`\\$ write ${fixture.storeRoot}/serpens/bin/serpens-sdd`));
  // stage 4/9: the resolved sync-submodules invocation, never a bare label — it feeds stage 1's
  // resolved rows on stdin (project-repositories.json is no longer written or referenced).
  assert.match(printed, /sync-submodules\.sh --repos-from -/);
  // stage 6: the per-target destinations, through the same commandDestination() the install uses
  assert.match(printed, /\$ write <agent-root>\/commands\/spns\/spec\.md/);
  assert.match(printed, /\$ write <agent-root>\/skills\/spns-tdd\/SKILL\.md/);
  // stage 8: every guard it would prove, from the GUARDS list itself
  assert.match(printed, /guard: a deliberate bad commit rejected by the installed hook/);
});

// ---------------------------------------------------------------------------------------------
// Step 6 (gap 3, spec-openspec-coexistence-2026-09-22.md): repo-local topology. ONE repository
// that already runs vanilla OpenSpec by hand and has its own lefthook.yml; init with no store,
// no submodule, no push. The vanilla work must keep committing cleanly through the hooks; a
// marked (Serpens) change must be gated.

const VANILLA_CHANGE = 'add-vanilla-thing';

function makeRepoLocalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-e2e-repolocal-'));
  const repoRoot = join(root, 'trial');
  initGitRepo(repoRoot);
  // A team that already runs vanilla OpenSpec: its own root, one hand-made change, its own
  // lefthook config and its own CLAUDE.md.
  for (const d of ['openspec/specs', 'openspec/changes/archive', `openspec/changes/${VANILLA_CHANGE}/specs/thing`]) {
    mkdirSync(join(repoRoot, d), { recursive: true });
  }
  writeFileSync(join(repoRoot, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  writeFileSync(join(repoRoot, 'openspec', 'specs', '.gitkeep'), '');
  writeFileSync(join(repoRoot, 'openspec', 'changes', 'archive', '.gitkeep'), '');
  writeFileSync(join(repoRoot, 'openspec', 'changes', VANILLA_CHANGE, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-09-23\n');
  writeFileSync(join(repoRoot, 'openspec', 'changes', VANILLA_CHANGE, 'proposal.md'), '# vanilla\nhand-written, no Why section at all\n');
  writeFileSync(join(repoRoot, 'lefthook.yml'), '# the team\'s own hooks\npre-commit:\n  commands:\n    team-lint:\n      run: "true"\n');
  writeFileSync(join(repoRoot, 'CLAUDE.md'), '# Team rules\n\nOur own text.\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'vanilla openspec repo']);

  const oss = fakeOpenspec(root, { version: '1.13.0' });
  const lefthookBin = noopLefthook(root);
  // The config file lives OUTSIDE the trial repo — it is not a file the team would commit.
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
  return { root, repoRoot, storeRoot: join(root, 'no-store-here'), configPath, oss, lefthookBin };
}

/** Install plain git hooks that run exactly what our generated serpens/lefthook.yml runs — the
 * team owns lefthook.yml here, so ours is `serpens/lefthook.yml` and would be `extends:`-ed by
 * hand; this stands in for that without a real lefthook binary (none is installable offline). */
function installOurHooks(repoRoot) {
  const shim = join(repoRoot, 'serpens', 'bin', 'serpens-sdd');
  const hooks = join(repoRoot, '.git', 'hooks');
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n"${shim}" verify-docs --staged-scope || exit 1\n"${shim}" git-naming --branch || exit 1\n`);
  writeFileSync(join(hooks, 'commit-msg'), `#!/bin/sh\nexec "${shim}" git-naming --commit-msg "$1"\n`);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  chmodSync(join(hooks, 'commit-msg'), 0o755);
}

function tryCommit(repoRoot, message) {
  try {
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output: '' };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('repo-local init: no store, no submodule, no push; facts land in the repo; team files untouched; vanilla commits pass the hooks and a marked change is gated', async () => {
  const fixture = makeRepoLocalFixture();
  const { repoRoot } = fixture;
  const teamFiles = ['lefthook.yml', `openspec/changes/${VANILLA_CHANGE}/proposal.md`,
    `openspec/changes/${VANILLA_CHANGE}/.openspec.yaml`, 'openspec/specs/.gitkeep'];
  const before = Object.fromEntries(teamFiles.map((f) => [f, readFileSync(join(repoRoot, f))]));

  const { code, printed } = await runInitCapturingStdout(fixture);
  assert.equal(code, 0, printed);

  // No store, anywhere.
  assert.equal(existsSync(fixture.storeRoot), false);
  assert.equal(existsSync(join(repoRoot, '.gitmodules')), false);
  assert.equal(existsSync(join(repoRoot, 'submodules')), false);
  assert.equal(git(repoRoot, ['remote']).trim(), '', 'no remote was added');

  // The run log lives in serpens/ and is ignored there; it proves no outward write was run.
  const logs = readdirSync(join(repoRoot, 'serpens')).filter((f) => /^\.serpens-sdd-init-.*\.log$/.test(f));
  assert.equal(logs.length, 1);
  const logText = readFileSync(join(repoRoot, 'serpens', logs[0]), 'utf8');
  assert.doesNotMatch(logText, /\$ git push/);
  assert.doesNotMatch(logText, /\$ git (-C \S+ )?submodule/);
  assert.doesNotMatch(logText, /\$ openspec store/);
  // Stage 8's own throwaway-fixture commit (in a temp dir, "bad ticket") is the only commit allowed.
  const commits = logText.split('\n').filter((l) => /\$ git (-C \S+ )?commit\b/.test(l) && !l.includes('(bad ticket'));
  assert.deepEqual(commits, [], 'init must never commit in repo-local');
  assert.doesNotMatch(logText, /stage 1 \(|stage 4 \(/);
  assert.equal(git(repoRoot, ['check-ignore', `serpens/${logs[0]}`]).trim(), `serpens/${logs[0]}`);

  for (const f of ['serpens/branching.md', 'serpens/port-facts.md', 'serpens/testing-stack.md', 'serpens/topology', 'serpens/bin/serpens-sdd', 'serpens/lefthook.yml']) {
    assert.ok(existsSync(join(repoRoot, f)), `${f} must exist`);
  }
  assert.equal(readFileSync(join(repoRoot, 'serpens', 'topology'), 'utf8'), 'repo-local\n');
  assert.equal(git(repoRoot, ['config', 'serpens.baseBranch']).trim(), BASE);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'openspec', 'config.yaml'), 'utf8'), /^references:/m,
    'no store to declare in repo-local');
  assert.ok(existsSync(join(repoRoot, '.claude', 'commands', 'spns', 'spec.md')), 'claude = project scope → the repo itself');
  for (const f of teamFiles) assert.deepEqual(readFileSync(join(repoRoot, f)), before[f], `${f} must be byte-identical`);
  assert.match(readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8'), /^# Team rules\n\nOur own text.\n/);

  // The human's follow-up: fill the facts, commit the install on a conforming branch — through
  // the hooks, which must accept correct Serpens work.
  installOurHooks(repoRoot);
  git(repoRoot, ['checkout', '-q', '-b', 'feature/ABCD-1']);
  fillUnfilled(join(repoRoot, 'serpens', 'testing-stack.md'));
  const pf = join(repoRoot, 'serpens', 'port-facts.md');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace(/^UNFILLED — .*$/gm, 'answered by the operator'));
  git(repoRoot, ['add', '-A']);
  const installCommit = tryCommit(repoRoot, 'feat(ABCD-1): onboard serpens-sdd repo-local');
  assert.equal(installCommit.code, 0, installCommit.output);

  // Vanilla work: a non-conforming branch AND message, unmarked change — must pass.
  git(repoRoot, ['checkout', '-q', '-b', 'wip/not-a-ticket']);
  writeFileSync(join(repoRoot, 'openspec', 'changes', VANILLA_CHANGE, 'tasks.md'), '- [ ] do the thing\n');
  git(repoRoot, ['add', '-A']);
  const vanilla = tryCommit(repoRoot, 'random words');
  assert.equal(vanilla.code, 0, `a vanilla commit must pass our hooks:\n${vanilla.output}`);

  // The SAME change, marked as Serpens' — same branch, same kind of message: gated.
  writeFileSync(join(repoRoot, 'openspec', 'changes', VANILLA_CHANGE, '.serpens.yaml'),
    '# serpens-sdd:change-marker\nowner: serpens-sdd\nticket: ABCD-2\nbranch: feature/ABCD-2\ncreated: 2026-09-23\n');
  git(repoRoot, ['add', '-A']);
  const marked = tryCommit(repoRoot, 'random words again');
  assert.notEqual(marked.code, 0, 'a marked change on a bad branch must be refused');
  assert.match(marked.output, /✗/, marked.output);
  assert.equal(git(repoRoot, ['log', '-1', '--format=%s']).trim(), 'random words', 'the refused commit did not land');
});

test('repo-local --dry-run lists exactly stages 0,3,5,6,8,9 and touches nothing', async () => {
  const fixture = makeRepoLocalFixture();
  const snap = snapshotDir(fixture.repoRoot);
  const { code, printed } = await runInitCapturingStdout(fixture, ['--dry-run']);
  assert.equal(code, 0);
  const ids = [...printed.matchAll(/=== stage (\d+) \(/g)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [0, 3, 5, 6, 8, 9]);
  assert.doesNotMatch(printed, /git push|submodule add|ls-remote|openspec store|git clone/);
  assert.match(printed, /serpens\/branching\.md\s+# only when absent/);
  assert.deepEqual(snapshotDir(fixture.repoRoot), snap, 'dry-run must not change a byte');
});

test('repo-local: --only 4 is refused (no such stage), and a store: key is a config error', async () => {
  const fixture = makeRepoLocalFixture();
  const savedWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  let only4;
  let withStore;
  try {
    only4 = await runInit(fixture, ['--only', '4']);
    const cfg = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    cfg.store = { remote: 'x', base_branch: 'main', root: '../s' };
    writeFileSync(fixture.configPath, JSON.stringify(cfg));
    withStore = await runInit(fixture);
  } finally {
    process.stderr.write = savedWrite;
  }
  assert.equal(only4, 2);
  assert.equal(withStore, 2);
  assert.match(captured, /store: is not allowed with topology repo-local/);
  assert.equal(existsSync(join(fixture.repoRoot, 'serpens')), false, 'nothing written on either refusal');
});
