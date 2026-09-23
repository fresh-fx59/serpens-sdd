import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { run as realRun } from '../src/run.mjs';
import { registerSystemStore, readCommittedStoreId, REGISTRY_LOCK_ATTEMPTS } from '../src/storeregistry.mjs';
import { declaredReferenceIds } from '../src/openspecconfig.mjs';
import { callSiteRoots } from '../src/offline.mjs';
import { stage3 } from '../src/stages/stage3-store.mjs';
import { kitPath } from '../src/integrity.mjs';
import { makeBareRemote, fakeOpenspec } from './helpers/fixture.mjs';
import { realOpenspec, realRegistrySnapshot, realRegistryPath, assertRegistryIsolated } from './helpers/real-openspec.mjs';
import { requireOpenspec } from './helpers/prereqs.mjs';

// Acceptance for spec-openspec-store-registration-2026-09-11, §5 as amended by §7.
//
// Every test here drives a REAL `@fission-ai/openspec` in a temp directory, with XDG_DATA_HOME
// pointed into that directory so the registry OpenSpec reads and writes is the fixture's, never
// the developer's (`dist/core/global-config.js:44-51` → `dist/core/store/foundation.js:20`).
// Isolation is not assumed: `assertRegistryIsolated` checks the registry path OpenSpec itself
// reports, and `REAL_REGISTRY_BEFORE` below is compared after the whole file has run.
//
// The one exception is the "no `store` subcommand" case, which no real 1.11-1.13 binary can
// produce: that uses the stub, which models Commander's unknown-command error exactly.

const KIT_DIR = kitPath('en');
const FIXTURE_SPEC_ID = 'fixture-shared-capability';
const REAL_REGISTRY_BEFORE = realRegistrySnapshot();

// OpenSpec stores the CANONICAL root (`FileSystemUtils.canonicalizeExistingPath`), and on macOS
// every mkdtemp path is behind the `/var` → `/private/var` symlink. Comparing anything the CLI
// reports against a plain `resolve()` would fail on this machine and pass on Linux.
const canon = (p) => realpathSync(p);

/** A store checkout: a git repo with a real `openspec init`, one named spec, and a commit. */
function makeRealStore(oss, { name = 'store', withSpec = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), `serpens-sdd-realstore-${name}-`));
  const storeRoot = join(parent, name);
  mkdirSync(storeRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'develop', storeRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: storeRoot });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: storeRoot });
  const inited = oss.run(['init', '--tools', 'claude'], { cwd: storeRoot });
  assert.equal(inited.code, 0, `real openspec init failed: ${inited.stderr}${inited.stdout}`);
  if (withSpec) {
    const specDir = join(storeRoot, 'openspec', 'specs', FIXTURE_SPEC_ID);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'spec.md'), [
      `# ${FIXTURE_SPEC_ID}`,
      '',
      '## Purpose',
      'A named fixture spec, so the end-to-end check asserts a SPEC resolving, not merely a non-empty index.',
      '',
      '## Requirements',
      '### Requirement: Fixture Requirement',
      'The store SHALL expose this spec to a spoke that references it.',
      '',
      '#### Scenario: the spoke resolves it',
      '- **WHEN** the spoke declares this store under references:',
      '- **THEN** the spec is listed under the store id',
      '',
    ].join('\n'), 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: storeRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: storeRoot });
  return storeRoot;
}

/** A spoke repository with a real OpenSpec root and a `references:` entry for `storeId`. */
function makeSpoke(oss, storeId, { remote = 'ssh://git@forge/o/store.git' } = {}) {
  const spokeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-spoke-'));
  const inited = oss.run(['init', '--tools', 'claude'], { cwd: spokeRoot });
  assert.equal(inited.code, 0, `real openspec init failed in the spoke: ${inited.stderr}${inited.stdout}`);
  const configPath = join(spokeRoot, 'openspec', 'config.yaml');
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeFileSync(configPath, `${existing.replace(/\n*$/, '\n')}references:\n  - id: ${storeId}\n    remote: ${remote}\n`, 'utf8');
  return { spokeRoot, configPath };
}

const STORE_REMOTE = 'ssh://git@forge/o/store.git';

/** Commit `.openspec-store/store.yaml` into a store checkout — the shared, versioned identity. */
function commitMetadata(storeRoot, text) {
  mkdirSync(join(storeRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(storeRoot, '.openspec-store', 'store.yaml'), text, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: storeRoot });
  execFileSync('git', ['commit', '-m', 'commit store identity'], { cwd: storeRoot });
}

/**
 * A spoke INSIDE the store's own `submodules/` — i.e. one that `callSiteRoots` reaches, which is
 * the only kind whose `references:` entries this package ever writes or rewrites.
 */
function makeReachableSpoke(storeRoot, storeId, { name = 'billing', remote = STORE_REMOTE } = {}) {
  const spokeRoot = join(storeRoot, 'submodules', name);
  mkdirSync(join(spokeRoot, 'openspec'), { recursive: true });
  const configPath = join(spokeRoot, 'openspec', 'config.yaml');
  writeFileSync(configPath, `schema: default\ncontext: |\n  our own prose\nreferences:\n  - id: ${storeId}\n    remote: ${remote}\n`, 'utf8');
  assert.ok(
    callSiteRoots(storeRoot).includes(spokeRoot),
    'the fixture spoke is not a call site — the assertion below would prove nothing',
  );
  return { spokeRoot, configPath };
}

/** Give a store an `origin` bare remote already holding its base branch. */
function giveOrigin(storeRoot, base = 'develop') {
  const bare = join(mkdtempSync(join(tmpdir(), 'serpens-sdd-store-origin-')), 'store.git');
  execFileSync('git', ['init', '--bare', '-b', base, bare], { stdio: 'ignore' });
  execFileSync('git', ['-C', storeRoot, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', storeRoot, 'push', '-q', 'origin', base]);
  return bare;
}

/** `run` that fails every `git push` while `fail()` says so, and is otherwise the real one. */
function runWithPushControl(oss, fail) {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args });
    if (fail() && cmd === 'git' && args.includes('push')) {
      return { code: 1, stdout: '', stderr: 'simulated: the remote rejected the push' };
    }
    return realRun(cmd, args, { ...opts, env: oss.env });
  };
  fn.calls = calls;
  fn.storeCalls = () => calls.filter((c) => c.args.includes('store'));
  return fn;
}

/** `run` that records every invocation and then delegates to the real one under `oss.env`. */
function recordingRun(oss) {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args });
    return realRun(cmd, args, { ...opts, env: oss.env });
  };
  fn.calls = calls;
  fn.storeCalls = () => calls.filter((c) => c.args.includes('store'));
  return fn;
}

function ctxFor(oss, { storeRoot, storeId, configPath, dryRun = false, ...rest }) {
  return {
    config: { project: 'acme', store: { id: storeId, root: storeRoot, remote: 'ssh://git@forge/o/store.git', base_branch: 'develop' } },
    run: recordingRun(oss),
    storeRoot,
    configPath,
    openspecCmd: 'openspec',
    openspecBaseArgs: [],
    dryRun,
    ...rest,
  };
}

// ---------------------------------------------------------------------------------------------
// §5.1 — fresh store, nothing registered
// ---------------------------------------------------------------------------------------------
test('fresh store: registered, .openspec-store/store.yaml created AND committed, and store list proves our path', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  const headBefore = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const ctx = ctxFor(oss, { storeRoot, storeId: 'acme-store' });
  const result = await registerSystemStore(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);

  // The metadata file exists, carries our id, and is COMMITTED — upstream never commits it
  // (operations.js:525), so an uncommitted file here would mean the identity is not shared.
  assert.deepEqual(readCommittedStoreId(storeRoot), {
    present: true, id: 'acme-store', version: '1', path: join(storeRoot, '.openspec-store', 'store.yaml'),
  });
  const tracked = execFileSync('git', ['-C', storeRoot, 'ls-files', '.openspec-store/store.yaml'], { encoding: 'utf8' }).trim();
  assert.equal(tracked, '.openspec-store/store.yaml', 'the identity metadata was not committed');
  const headAfter = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(headAfter, headBefore);

  // The REAL CLI agrees it is registered, at our absolute path.
  const listed = oss.json(['store', 'list', '--json']);
  assert.deepEqual(
    listed.stores.map((s) => ({ id: s.id, root: s.root })),
    [{ id: 'acme-store', root: canon(storeRoot) }],
  );
  assert.equal(listed.registryPath, undefined);
  assert.ok(existsSync(oss.registryPath), 'the temp registry file was never written');
});

// ---------------------------------------------------------------------------------------------
// §5.2 — re-run is idempotent
// ---------------------------------------------------------------------------------------------
test('re-run on the same store: no second registration, no empty commit, ok', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);

  const first = await registerSystemStore(ctxFor(oss, { storeRoot, storeId: 'acme-store' }));
  assert.equal(first.ok, true, first.error);
  const headAfterFirst = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const ctx2 = ctxFor(oss, { storeRoot, storeId: 'acme-store' });
  const second = await registerSystemStore(ctx2);
  assert.equal(second.error, undefined);
  assert.equal(second.ok, true);

  // No second `store register` call at all, and no commit.
  assert.deepEqual(ctx2.run.storeCalls().map((c) => c.args.join(' ')), ['store list --json', 'store list --json']);
  assert.ok(second.evidence.some((e) => /already registered at/.test(e)));
  const headAfterSecond = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(headAfterSecond, headAfterFirst, 'the re-run created an empty commit');
  assert.equal(oss.json(['store', 'list', '--json']).stores.length, 1);
});

// ---------------------------------------------------------------------------------------------
// §5.3 — our id registered at ANOTHER path
// ---------------------------------------------------------------------------------------------
test('our id registered at another path: refuses, prints BOTH paths, leaves registry.yaml byte-for-byte unchanged', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const theirs = makeRealStore(oss, { name: 'theirs' });
  const ours = makeRealStore(oss, { name: 'ours' });

  // The user's own checkout of that id, registered by hand — through the CLI, never by editing
  // registry.yaml.
  const theirPayload = oss.json(['store', 'register', theirs, '--id', 'acme-store', '--yes', '--json']);
  assertRegistryIsolated(oss, theirPayload, assert);
  const registryBefore = readFileSync(oss.registryPath);

  const result = await registerSystemStore(ctxFor(oss, { storeRoot: ours, storeId: 'acme-store' }));

  assert.equal(result.ok, false);
  assert.ok(result.exitCode >= 1);
  assert.match(result.error, new RegExp(resolve(theirs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.error, new RegExp(resolve(ours).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.deepEqual(readFileSync(oss.registryPath), registryBefore, 'the registry was modified by a refusal');
  // Nothing was created in our checkout either.
  assert.equal(existsSync(join(ours, '.openspec-store', 'store.yaml')), false);
});

// ---------------------------------------------------------------------------------------------
// §5.4 — an unrelated store is left alone
// ---------------------------------------------------------------------------------------------
test("an unrelated store registered first is still registered, untouched, after our run", async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const unrelated = makeRealStore(oss, { name: 'unrelated' });
  const ours = makeRealStore(oss, { name: 'ours' });

  const theirPayload = oss.json(['store', 'register', unrelated, '--id', 'someone-elses-store', '--yes', '--json']);
  assertRegistryIsolated(oss, theirPayload, assert);
  const theirMetadataBefore = readFileSync(join(unrelated, '.openspec-store', 'store.yaml'), 'utf8');

  const result = await registerSystemStore(ctxFor(oss, { storeRoot: ours, storeId: 'acme-store' }));
  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.ok(result.evidence.some((e) => /preserved, untouched: store "someone-elses-store"/.test(e)));

  const listed = oss.json(['store', 'list', '--json']);
  const byId = Object.fromEntries(listed.stores.map((s) => [s.id, s.root]));
  assert.equal(byId['someone-elses-store'], canon(unrelated), "the user's unrelated store lost its registration");
  assert.equal(byId['acme-store'], canon(ours));
  assert.equal(readFileSync(join(unrelated, '.openspec-store', 'store.yaml'), 'utf8'), theirMetadataBefore);
});

// ---------------------------------------------------------------------------------------------
// §7 amended — id adoption, completely, BEFORE the register call
// ---------------------------------------------------------------------------------------------
test('committed metadata id X vs config id Y: adopts X before registering, passes no competing --id, and rewrites config AND references', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  // The store already carries a committed identity — the shared, versioned fact.
  mkdirSync(join(storeRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(storeRoot, '.openspec-store', 'store.yaml'), 'version: 1\nid: committed-store\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: storeRoot });
  execFileSync('git', ['commit', '-m', 'commit store identity'], { cwd: storeRoot });

  // A previous run already wrote a `references:` entry naming the OLD id, in an onboarded spoke.
  const spokeRoot = join(storeRoot, 'submodules', 'billing');
  mkdirSync(join(spokeRoot, 'openspec'), { recursive: true });
  const spokeConfig = join(spokeRoot, 'openspec', 'config.yaml');
  writeFileSync(spokeConfig, 'schema: default\ncontext: |\n  our own prose\nreferences:\n  - id: config-store\n    remote: ssh://git@forge/o/store.git\n', 'utf8');

  // And the serpens config FILE on disk still says the old id too.
  const configPath = join(mkdtempSync(join(tmpdir(), 'serpens-sdd-conf-')), 'serpens.json');
  writeFileSync(configPath, `${JSON.stringify({ project: 'acme', store: { id: 'config-store', root: storeRoot, remote: 'ssh://git@forge/o/store.git', base_branch: 'develop' } }, null, 2)}\n`, 'utf8');

  const configInoBefore = statSync(configPath).ino;
  const spokeInoBefore = statSync(spokeConfig).ino;

  const ctx = ctxFor(oss, { storeRoot, storeId: 'config-store', configPath });
  const result = await registerSystemStore(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.adoptedId, 'committed-store');

  // The register call carried NO `--id`: a competing one throws store_metadata_id_mismatch
  // (operations.js:487-497), which is what makes adoption-after-register impossible.
  const registerCall = ctx.run.calls.find((c) => c.args.includes('register'));
  assert.ok(registerCall, 'no store register call was made');
  assert.equal(registerCall.args.includes('--id'), false, 'a competing --id was passed');
  assert.ok(registerCall.args.includes('--yes'));

  // Adoption persisted in all three places.
  assert.equal(ctx.config.store.id, 'committed-store');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).store.id, 'committed-store');
  // Both files were REPLACED, not truncated and rewritten in place: a new inode is the signature
  // of write-to-temp-then-rename, which is what keeps a crash mid-write from leaving a half-
  // written config no re-run can reason about.
  assert.notEqual(statSync(configPath).ino, configInoBefore, `${configPath} was truncated in place, not replaced atomically`);
  assert.notEqual(statSync(spokeConfig).ino, spokeInoBefore, `${spokeConfig} was truncated in place, not replaced atomically`);
  assert.deepEqual(
    readdirSync(join(spokeRoot, 'openspec')).filter((f) => /\.tmp$/.test(f)), [],
    'an atomic-write temp file was left behind',
  );
  assert.deepEqual(declaredReferenceIds(readFileSync(spokeConfig, 'utf8')), ['committed-store']);
  // The spoke's own prose is untouched.
  assert.match(readFileSync(spokeConfig, 'utf8'), /context: \|\n {2}our own prose\n/);

  // And the REAL registry holds the adopted id at our path.
  assert.deepEqual(
    oss.json(['store', 'list', '--json']).stores.map((s) => ({ id: s.id, root: s.root })),
    [{ id: 'committed-store', root: canon(storeRoot) }],
  );
});

test('adoption re-runs the conflict check under the ADOPTED id: an adopted id already registered elsewhere refuses', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const theirs = makeRealStore(oss, { name: 'theirs' });
  oss.json(['store', 'register', theirs, '--id', 'committed-store', '--yes', '--json']);
  const registryBefore = readFileSync(oss.registryPath);

  const storeRoot = makeRealStore(oss, { name: 'ours' });
  mkdirSync(join(storeRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(storeRoot, '.openspec-store', 'store.yaml'), 'version: 1\nid: committed-store\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: storeRoot });
  execFileSync('git', ['commit', '-m', 'commit store identity'], { cwd: storeRoot });

  const ctx = ctxFor(oss, { storeRoot, storeId: 'config-store' });
  const result = await registerSystemStore(ctx);

  // Refused under the ADOPTED id — `config-store` is registered nowhere, so a conflict check
  // that still used it would have sailed straight through into a doomed register call.
  assert.equal(result.ok, false);
  assert.match(result.error, /store id "committed-store" is already registered/);
  assert.equal(ctx.run.calls.some((c) => c.args.includes('register')), false, 'it attempted to register anyway');
  assert.deepEqual(readFileSync(oss.registryPath), registryBefore);
});

// ---------------------------------------------------------------------------------------------
// §7 amended — a held registry lock
// ---------------------------------------------------------------------------------------------
test('a held registry lock: 3 bounded attempts, clean failure, and NO reachable references: entry was written', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  // The store's committed identity AGREES with the config id, so adoption has nothing to do and
  // any write to a reachable config would be a write this run had no business making. The old
  // version of this test watched a spoke in an unrelated temp dir — outside callSiteRoots — so it
  // stayed green even while adoption rewrote reachable entries BEFORE the registry failed.
  commitMetadata(storeRoot, 'version: 1\nid: acme-store\n');
  const { configPath: spokeConfigPath } = makeReachableSpoke(storeRoot, 'acme-store');
  const spokeBefore = readFileSync(spokeConfigPath);
  const spokeStatBefore = statSync(spokeConfigPath);

  // Hold the lock foundation.js:197 guards. Taken with 'wx', exactly as acquireFileLock does,
  // so this is contention and not a permission error.
  mkdirSync(dirname(oss.registryPath), { recursive: true });
  const lockPath = `${oss.registryPath}.lock`;
  const fd = openSync(lockPath, 'wx');
  try {
    const ctx = ctxFor(oss, { storeRoot, storeId: 'acme-store', registryBackoffMs: 5 });
    const result = await registerSystemStore(ctx);

    assert.equal(result.ok, false);
    assert.match(result.error, /store_registry_busy/);
    // The counts below are LITERAL 3s on purpose. Asserting them against the imported constant
    // made this test move with the source: dropping the retry budget to 1 kept it green, because
    // both sides of the comparison changed together. §7.2 fixes the number at three.
    assert.equal(REGISTRY_LOCK_ATTEMPTS, 3, 'the spec fixes the bounded retry budget at 3');
    assert.match(result.error, /3 attempts/);
    const registerCalls = ctx.run.calls.filter((c) => c.args.includes('register'));
    assert.equal(registerCalls.length, 3, `expected 3 bounded attempts, saw ${registerCalls.length}`);

    // THE HARD RULE: on a registry failure of any kind, no reachable `references:` entry was
    // written or rewritten. Content AND identity: an atomic write replaces the file, so a rewrite
    // that happened to produce the same bytes still shows up as a new inode and a new mtime.
    assert.deepEqual(readFileSync(spokeConfigPath), spokeBefore, 'a reachable references: entry was rewritten');
    const spokeStatAfter = statSync(spokeConfigPath);
    assert.equal(spokeStatAfter.ino, spokeStatBefore.ino, 'the reachable spoke config was replaced');
    assert.equal(spokeStatAfter.mtimeMs, spokeStatBefore.mtimeMs, 'the reachable spoke config was written to');
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
});

test('a registration failure STOPS stage 3, which is what keeps stage 5 from writing references:', async () => {
  // The "no references: write on a registry failure" rule is enforced by the stage returning
  // ok:false — `src/cli/init.mjs` stops at the first stage that does, and stage 5 is where the
  // `references:` entry is written. This asserts that propagation directly, so the byte-for-byte
  // assertion in the lock test above rests on a proven mechanism rather than on nothing having
  // been called.
  const remote = makeBareRemote('registration-failure', { base: 'develop' });
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-openspec-'));
  const oss = fakeOpenspec(fixtureDir);
  // Somebody else already holds our id, at a path that is not ours.
  writeFileSync(oss.registryPath, JSON.stringify({ stores: [{ id: 'acme-store', root: '/somewhere/else/store' }] }), 'utf8');
  const env = oss.pathPrepend(process.env);

  const result = await stage3({
    config: {
      project: 'acme',
      store: { id: 'acme-store', root: storeRoot, remote: remote.remotePath, base_branch: 'develop' },
      openspec: { invocation: 'openspec', pinned_version: '1.2.3' },
    },
    run: (cmd, args, opts = {}) => realRun(cmd, args, { ...opts, env }),
    storeRoot,
    kitDir: KIT_DIR,
  });

  assert.equal(result.ok, false, 'stage 3 reported success after a registry failure — stage 5 would then write references:');
  assert.match(result.error, /already registered on this machine at a DIFFERENT path/);
  assert.match(result.error, /\/somewhere\/else\/store/);
});

// ---------------------------------------------------------------------------------------------
// §5.6 — an OpenSpec with no `store` subcommand
// ---------------------------------------------------------------------------------------------
test('an OpenSpec without the store subcommand: the stage is skipped and stage 3 still succeeds', async () => {
  const remote = makeBareRemote('no-store-subcommand', { base: 'develop' });
  const parent = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-parent-'));
  const storeRoot = join(parent, 'store');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-openspec-'));
  const oss = fakeOpenspec(fixtureDir, { supportsStore: false });
  const env = oss.pathPrepend(process.env);

  const result = await stage3({
    config: {
      project: 'acme',
      store: { id: 'acme-store', root: storeRoot, remote: remote.remotePath, base_branch: 'develop' },
      openspec: { invocation: 'openspec', pinned_version: '1.2.3' },
    },
    run: (cmd, args, opts = {}) => realRun(cmd, args, { ...opts, env }),
    storeRoot,
    kitDir: KIT_DIR,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true, 'the install failed over a missing store subcommand');
  assert.equal(result.registrationSkipped, 'no-store-subcommand');
  assert.ok(result.evidence.some((e) => /Store registration SKIPPED/.test(e)));
  assert.equal(existsSync(join(storeRoot, '.openspec-store', 'store.yaml')), false);
});

// ---------------------------------------------------------------------------------------------
// §5.7 — --dry-run executes nothing
// ---------------------------------------------------------------------------------------------
test('--dry-run plans the calls and executes no openspec store call at all', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);

  const ctx = ctxFor(oss, { storeRoot, storeId: 'acme-store', dryRun: true });
  const result = await registerSystemStore(ctx);

  assert.equal(result.ok, true);
  assert.deepEqual(ctx.run.calls, [], 'a dry run executed a command');
  assert.ok(result.evidence.some((e) => /store register .* --yes --json/.test(e)), 'the plan does not name the register call');
  assert.equal(oss.json(['store', 'list', '--json']).stores.length, 0);
  assert.equal(existsSync(join(storeRoot, '.openspec-store', 'store.yaml')), false);
});

test('--offline REGISTERS: it is a filesystem assertion about call routes, not a mode that skips work', async (t) => {
  if (requireOpenspec(t)) return;
  // `--offline` asserts that every generated call site can reach this package without the
  // registry (src/offline.mjs: "Nothing here executes anything or touches the network"). Skipping
  // registration under it produced the one state this whole step exists to remove: an install
  // that writes `references:` for a store nothing ever registered. Registration is local — the
  // machine's own registry file and the checkout's own metadata.
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);

  const ctx = ctxFor(oss, { storeRoot, storeId: 'acme-store', offline: true });
  const result = await registerSystemStore(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.ok(ctx.run.calls.some((c) => c.args.includes('register')), '--offline planned the register call instead of making it');
  assert.deepEqual(
    oss.json(['store', 'list', '--json']).stores.map((s) => ({ id: s.id, root: s.root })),
    [{ id: 'acme-store', root: canon(storeRoot) }],
    '--offline left the store unregistered, so every references: entry it writes is decoration',
  );
  assert.equal(result.evidence.some((e) => /would do \(nothing below is executed\)/.test(e)), false);
});

// ---------------------------------------------------------------------------------------------
// §7 amended — the end-to-end proof, with the false positive removed
// ---------------------------------------------------------------------------------------------
test('end-to-end: the spoke resolves the named fixture spec under our id at the canonical root, with no reference_unresolved', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  const { spokeRoot } = makeSpoke(oss, 'acme-store');

  // BEFORE registration the index is already NON-EMPTY — this is the false positive §7.3 found:
  // `references.js:287` emits an entry carrying the store id PLUS a `reference_unresolved`
  // warning. Asserted here so the "after" assertion cannot be satisfied by the same state.
  const before = oss.json(['context', '--json'], { cwd: spokeRoot });
  assert.equal(before.members.length, 1);
  assert.equal(before.members[0].id, 'acme-store');
  assert.ok(
    JSON.stringify(before).includes('reference_unresolved'),
    'the unregistered baseline did not warn — this assertion would prove nothing',
  );

  const result = await registerSystemStore(ctxFor(oss, { storeRoot, storeId: 'acme-store' }));
  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);

  const after = oss.json(['context', '--json'], { cwd: spokeRoot });
  const member = after.members.find((m) => m.id === 'acme-store');
  assert.ok(member, 'the store is missing from the spoke index');
  assert.equal(member.role, 'referenced_store');
  // The canonical root, resolved through the registry — not merely an id echoed back.
  assert.equal(statSync(member.path).ino, statSync(storeRoot).ino);
  const diagnostics = JSON.stringify(after);
  assert.equal(diagnostics.includes('reference_unresolved'), false);
  assert.equal(diagnostics.includes('reference_root_unhealthy'), false);

  // And the NAMED fixture spec actually resolves through the store id.
  const specs = oss.json(['list', '--specs', '--store', 'acme-store', '--json'], { cwd: spokeRoot });
  assert.ok(
    specs.specs.some((s) => s.id === FIXTURE_SPEC_ID),
    `${FIXTURE_SPEC_ID} did not resolve through the store id: ${JSON.stringify(specs)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// The metadata commit publishes the metadata — and nothing else
// ---------------------------------------------------------------------------------------------

test('the identity commit carries ONLY .openspec-store/store.yaml, whatever else is staged in the worktree', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);

  // Somebody else's work, already in the index when we arrive — a half-finished `git add -p`, a
  // concurrent tool, an editor plugin. A pathspec-less `git commit` would publish it under our
  // message, and the push below would put it on the shared remote.
  writeFileSync(join(storeRoot, 'SOMEONE-ELSES-WORK.md'), 'half-finished, not ours to commit\n', 'utf8');
  execFileSync('git', ['-C', storeRoot, 'add', '--', 'SOMEONE-ELSES-WORK.md']);

  const result = await registerSystemStore(ctxFor(oss, { storeRoot, storeId: 'acme-store' }));
  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);

  const committedFiles = execFileSync('git', ['-C', storeRoot, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  assert.deepEqual(committedFiles, ['.openspec-store/store.yaml'],
    'the registration commit published files it did not build');
  assert.equal(
    execFileSync('git', ['-C', storeRoot, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).includes('SOMEONE-ELSES-WORK.md'),
    false,
    "someone else's staged file was committed by us",
  );
  // ...and it is still exactly where they left it: staged, uncommitted.
  assert.equal(
    execFileSync('git', ['-C', storeRoot, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(),
    'SOMEONE-ELSES-WORK.md',
    'their staged change was consumed by our commit',
  );

  // And the decision to commit is about OUR path too, not about the index as a whole: with the
  // metadata already committed and someone else's change still staged, a re-run has nothing to
  // do. Asking "is anything staged?" here answers yes and drives a commit of a path that has not
  // changed, which git refuses — the run would fail on a store that is already correct.
  const head = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const second = await registerSystemStore(ctxFor(oss, { storeRoot, storeId: 'acme-store' }));
  assert.equal(second.error, undefined);
  assert.equal(second.ok, true);
  assert.ok(second.evidence.some((e) => /nothing to commit/.test(e)));
  assert.equal(execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  assert.equal(
    execFileSync('git', ['-C', storeRoot, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(),
    'SOMEONE-ELSES-WORK.md',
  );
});

// ---------------------------------------------------------------------------------------------
// A push that failed must be repairable by re-running
// ---------------------------------------------------------------------------------------------

test('a failed push is retried on the NEXT run, which makes no commit of its own', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  const origin = giveOrigin(storeRoot);

  // Run 1: register and commit succeed, the push does not.
  const first = await registerSystemStore(ctxFor(oss, {
    storeRoot, storeId: 'acme-store', run: runWithPushControl(oss, () => true),
  }));
  assert.equal(first.ok, false);
  assert.match(first.error, /could not push the store identity commit to origin\/develop/);
  const head = execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(execFileSync('git', ['-C', origin, 'rev-parse', 'develop'], { encoding: 'utf8' }).trim(), head,
    'the fixture did not actually leave an unpushed commit');

  // Run 2: nothing left to commit — the old code therefore never reached the push at all, and
  // `repository-state.sh prepare-base` then refused the base for having an unpushed commit, so
  // the half-applied state was unrepairable by re-running.
  const ctx2 = ctxFor(oss, { storeRoot, storeId: 'acme-store' });
  const second = await registerSystemStore(ctx2);
  assert.equal(second.error, undefined);
  assert.equal(second.ok, true);
  assert.ok(second.evidence.some((e) => /nothing to commit/.test(e)), 'the re-run made a second commit');
  assert.equal(execFileSync('git', ['-C', storeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  assert.ok(ctx2.run.calls.some((c) => c.cmd === 'git' && c.args.includes('push')), 'the re-run never pushed');
  assert.equal(
    execFileSync('git', ['-C', origin, 'rev-parse', 'develop'], { encoding: 'utf8' }).trim(), head,
    'origin/develop is still behind: a re-run cannot repair the failed push',
  );
  assert.equal(
    execFileSync('git', ['-C', storeRoot, 'rev-list', '--count', 'origin/develop..develop'], { encoding: 'utf8' }).trim(), '0',
  );
});

// ---------------------------------------------------------------------------------------------
// Store metadata we do not understand is a refusal, never an adoption
// ---------------------------------------------------------------------------------------------

test('store metadata with an unknown version is REFUSED before anything is adopted', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  // Upstream pins the schema with `z.literal(1)` and rejects anything else as
  // `invalid_store_metadata`. Adopting the id out of this file first would rewrite the serpens
  // config and every references: entry to an id no `openspec store` call will ever accept.
  commitMetadata(storeRoot, 'version: 2\nid: committed-store\n');
  const { configPath: spokeConfigPath } = makeReachableSpoke(storeRoot, 'config-store');
  const spokeBefore = readFileSync(spokeConfigPath);

  const configPath = join(mkdtempSync(join(tmpdir(), 'serpens-sdd-conf-')), 'serpens.json');
  const configBefore = `${JSON.stringify({ project: 'acme', store: { id: 'config-store', root: storeRoot, remote: STORE_REMOTE, base_branch: 'develop' } }, null, 2)}\n`;
  writeFileSync(configPath, configBefore, 'utf8');

  const ctx = ctxFor(oss, { storeRoot, storeId: 'config-store', configPath });
  const result = await registerSystemStore(ctx);

  assert.equal(result.ok, false);
  assert.ok(result.exitCode >= 1);
  assert.match(result.error, /store\.yaml/, 'the refusal does not name the file');
  assert.match(result.error, /version 2/, 'the refusal does not name the version');

  // Nothing adopted, anywhere, and no call attempted under the id we could not validate.
  assert.equal(ctx.config.store.id, 'config-store');
  assert.equal(readFileSync(configPath, 'utf8'), configBefore);
  assert.deepEqual(readFileSync(spokeConfigPath), spokeBefore);
  assert.equal(ctx.run.calls.some((c) => c.args.includes('register')), false);
  assert.equal(oss.json(['store', 'list', '--json']).stores.length, 0);
});

test('store metadata with NO version at all is refused, and says so in those words', async (t) => {
  if (requireOpenspec(t)) return;
  // `MetadataStateSchema` requires the key; a file without it is as unreadable to OpenSpec as one
  // carrying a version from the future, but the fix a user needs is a different one, so the
  // refusal has to tell them which case they are in.
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  commitMetadata(storeRoot, 'id: committed-store\n');

  const ctx = ctxFor(oss, { storeRoot, storeId: 'config-store' });
  const result = await registerSystemStore(ctx);

  assert.equal(result.ok, false);
  assert.match(result.error, /store\.yaml/);
  assert.match(result.error, /declares no 'version:'/, 'the refusal does not say the version key is missing');
  assert.equal(ctx.config.store.id, 'config-store');
  assert.equal(ctx.run.calls.some((c) => c.args.includes('register')), false);
});

// ---------------------------------------------------------------------------------------------
// A half-adopted id must be finished by the next run
// ---------------------------------------------------------------------------------------------

test('a half-adopted id is finished by the next run — the condition is the reference entries, not the config field', async (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  commitMetadata(storeRoot, 'version: 1\nid: committed-store\n');

  // THE HALF-APPLIED STATE, exactly as a previous run leaves it when the config is written and
  // the reference rewrite then fails (or the process dies between the two): the serpens config
  // already names the committed id, while a reachable spoke still names the old one.
  const { spokeRoot, configPath: spokeConfigPath } = makeReachableSpoke(storeRoot, 'config-store');
  const configPath = join(mkdtempSync(join(tmpdir(), 'serpens-sdd-conf-')), 'serpens.json');
  writeFileSync(configPath, `${JSON.stringify({ project: 'acme', store: { id: 'committed-store', root: storeRoot, remote: STORE_REMOTE, base_branch: 'develop' } }, null, 2)}\n`, 'utf8');
  const spokeInoBefore = statSync(spokeConfigPath).ino;

  // The config already agrees with the committed metadata, so a run that asks "is the id already
  // adopted?" sees yes, skips the repair, and reports success over a spoke that still resolves to
  // the wrong store.
  const ctx = ctxFor(oss, { storeRoot, storeId: 'committed-store', configPath });
  const result = await registerSystemStore(ctx);

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(declaredReferenceIds(readFileSync(spokeConfigPath, 'utf8')), ['committed-store'],
    'the re-run reported success while the spoke still named the old id');
  assert.ok(result.evidence.some((e) => /FINISHING A PARTIAL ADOPTION/.test(e)));
  assert.match(readFileSync(spokeConfigPath, 'utf8'), /context: \|\n {2}our own prose\n/, "the spoke's own prose was disturbed");
  assert.notEqual(statSync(spokeConfigPath).ino, spokeInoBefore, 'the spoke config was truncated in place, not replaced atomically');
  assert.deepEqual(readdirSync(join(spokeRoot, 'openspec')).filter((f) => /\.tmp$/.test(f)), [],
    'an atomic-write temp file was left behind');

  assert.deepEqual(
    oss.json(['store', 'list', '--json']).stores.map((s) => ({ id: s.id, root: s.root })),
    [{ id: 'committed-store', root: canon(storeRoot) }],
  );
});

test('a partial adoption caused by a QUOTED reference entry is repaired, not reported as success', async (t) => {
  if (requireOpenspec(t)) return;
  // The reviewer's reproduction, without any crash: run 1 writes the config, then the rewrite of
  // a quoted entry refuses, and run 2 sees "already adopted" and sails past it.
  const oss = realOpenspec();
  const storeRoot = makeRealStore(oss);
  commitMetadata(storeRoot, 'version: 1\nid: committed-store\n');
  const spokeRoot = join(storeRoot, 'submodules', 'billing');
  mkdirSync(join(spokeRoot, 'openspec'), { recursive: true });
  const spokeConfigPath = join(spokeRoot, 'openspec', 'config.yaml');
  writeFileSync(spokeConfigPath, `schema: default\nreferences:\n  - id: 'config-store'\n    remote: ${STORE_REMOTE}\n`, 'utf8');

  const configPath = join(mkdtempSync(join(tmpdir(), 'serpens-sdd-conf-')), 'serpens.json');
  writeFileSync(configPath, `${JSON.stringify({ project: 'acme', store: { id: 'config-store', root: storeRoot, remote: STORE_REMOTE, base_branch: 'develop' } }, null, 2)}\n`, 'utf8');

  const result = await registerSystemStore(ctxFor(oss, { storeRoot, storeId: 'config-store', configPath }));
  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(declaredReferenceIds(readFileSync(spokeConfigPath, 'utf8')), ['committed-store']);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).store.id, 'committed-store');
});

// ---------------------------------------------------------------------------------------------
// §7 amended — the grep gate
// ---------------------------------------------------------------------------------------------

/** Every file this package actually ships (package.json `files`), read as text. */
function shippedFiles() {
  const pkgRoot = resolve(new URL('..', import.meta.url).pathname);
  const roots = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).files;
  const out = [];
  const skipExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.zip']);
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e));
      return;
    }
    if (skipExt.has(extname(p))) return;
    out.push({ path: p, text: readFileSync(p, 'utf8') });
  };
  for (const r of roots) walk(join(pkgRoot, r));
  return out;
}

/**
 * The matcher the gate uses. Kept separate from the scan so the negative control can prove it
 * actually fires — a gate whose matcher never matches anything passes forever.
 */
function destructiveStoreCalls(text) {
  return [...text.matchAll(/store['"\s,]+['"]?(unregister|remove)\b/g)].map((m) => m[0]);
}

test('grep gate: no `openspec store unregister` or `store remove` appears anywhere in the shipped package', () => {
  // The negative control FIRST: if the matcher cannot fire, the scan below is decoration.
  assert.deepEqual(destructiveStoreCalls('await run(openspec, ["store", "unregister", id]);'), ['store", "unregister']);
  assert.deepEqual(destructiveStoreCalls('$ openspec store remove acme-store --yes'), ['store remove']);
  assert.deepEqual(destructiveStoreCalls('openspec store register /path --yes'), []);

  const offenders = [];
  for (const file of shippedFiles()) {
    const hits = destructiveStoreCalls(file.text);
    if (hits.length) offenders.push(`${file.path}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'a destructive store command reached the shipped package');
});

// ---------------------------------------------------------------------------------------------
// The isolation claim itself
// ---------------------------------------------------------------------------------------------
test("the developer's real store registry was never touched by this suite", () => {
  assert.deepEqual(
    realRegistrySnapshot(),
    REAL_REGISTRY_BEFORE,
    `${realRegistryPath()} changed while this suite ran — the XDG_DATA_HOME isolation leaked`,
  );
});
