import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initMain from '../src/cli/init.mjs';
import uninstallMain from '../src/cli/uninstall.mjs';
import { declaredReferenceIds } from '../src/openspecconfig.mjs';
import { realOpenspec } from './helpers/real-openspec.mjs';
import { requireOpenspec, requireLefthook } from './helpers/prereqs.mjs';

// Acceptance box 2 of spec-openspec-store-registry-2026-09-10.md §7:
// "the same [real init run] for a repo carrying a `store:` key in `openspec/config.yaml`; what
// happens is recorded — not predicted."
//
// `store:` here is OPENSPEC'S OWN top-level pointer key (§10/§11 of that spec, read from the
// real 1.13 install's dist/core/project-config.js:290-295 and dist/core/root-selection.js:
// 160-193) — NOT serpens-sdd's own `serpens.config.store` (a different, same-named field tested
// elsewhere, e.g. e2e.test.mjs's repo-local "store: is not allowed" case). OpenSpec's `store:`
// accepts exactly ONE shape: a plain string id (project-config.js:290-295 — anything else is
// dropped with a console.warn). It is only CONSULTED when the `openspec/` directory is
// config-only (no specs/ or changes/ planning shape); a real root — which is exactly what a
// brownfield spoke that already ran `openspec init` has — makes the pointer a no-op, printed as
// a warning, never an error (root-selection.js:190-196). This test drives a repo shaped exactly
// that way: a real root, carrying a hand-authored `store:` pointer, onboarded by a real
// `serpens-sdd init` in store topology.
//
// Modeled directly on test/store-uninstall-e2e.test.mjs (same isolation: fake HOME +
// XDG_DATA_HOME, real openspec/lefthook, GIT_ALLOW_PROTOCOL for file:// submodule remotes).

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
  const bareDir = mkdtempSync(join(tmpdir(), `serpens-sdd-storekey-e2e-${prefix}-bare-`));
  execFileSync('git', ['init', '--bare', '-q', '-b', branch, bareDir]);
  const workDir = mkdtempSync(join(tmpdir(), `serpens-sdd-storekey-e2e-${prefix}-work-`));
  initGitRepo(workDir, branch);
  populate(workDir);
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-q', '-m', 'initial commit']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  git(workDir, ['push', '-q', 'origin', branch]);
  return bareDir;
}

const LEGACY_STORE_ID = 'legacy-team-store';

test('real e2e: init onto a repo whose openspec/config.yaml already carries a `store:` pointer preserves it byte-for-byte and adds references: alongside it', async (t) => {
  if (requireLefthook(t)) return;
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  t.diagnostic(`real openspec version ${oss.version}`);

  const branch = 'main';
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-storekey-e2e-'));
  const fakeHome = join(root, 'fake-home');
  mkdirSync(fakeHome, { recursive: true });
  writeFileSync(join(fakeHome, '.gitconfig'), '[user]\n\temail = e2e@example.com\n\tname = E2E\n', 'utf8');

  const storeRemote = makeBareWithOneCommit('store', branch, (workDir) => {
    writeFileSync(join(workDir, 'README.md'), '# store\n');
    mkdirSync(join(workDir, 'openspec', 'specs'), { recursive: true });
    mkdirSync(join(workDir, 'openspec', 'changes'), { recursive: true });
    writeFileSync(join(workDir, 'openspec', 'specs', '.gitkeep'), '');
    writeFileSync(join(workDir, 'openspec', 'changes', '.gitkeep'), '');
  });

  // The brownfield project repo: a REAL `openspec init` already ran here by hand (giving it a
  // genuine planning shape — specs/, changes/, changes/archive/ — the exact precondition
  // stage5-onboard.mjs's brownfield branch requires), then the team hand-authored a top-level
  // `store:` pointer into its config.yaml, on top of what init wrote, and committed both.
  let userConfigBefore;
  const projectRemote = makeBareWithOneCommit('billing', branch, (workDir) => {
    const inited = execFileSync(oss.binPath, ['init', '--tools', 'claude'], { cwd: workDir, encoding: 'utf8', env: oss.env });
    t.diagnostic(`seed openspec init in billing workdir: ${inited.split('\n')[0]}`);
    const configPath = join(workDir, 'openspec', 'config.yaml');
    const generated = readFileSync(configPath, 'utf8');
    // A plain scalar id, prepended — the ONLY shape OpenSpec's own config parser accepts
    // (project-config.js:290-295: `typeof raw.store === 'string'`, else dropped with a warning).
    userConfigBefore = `store: ${LEGACY_STORE_ID}\n${generated}`;
    writeFileSync(configPath, userConfigBefore, 'utf8');
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
    store: { remote: storeRemote, base_branch: branch, root: storeRoot, id: 'storekey-e2e-probe' },
    repositories: [{ name: 'billing', url: projectRemote, base_branch: branch }],
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
    assert.equal(initCode, 0, 'real init against a repo carrying an openspec store: pointer must complete green');

    const submodulePath = join(storeRoot, 'submodules', 'billing');
    const submoduleConfigPath = join(submodulePath, 'openspec', 'config.yaml');
    assert.ok(existsSync(submoduleConfigPath), 'billing must have been onboarded as a real submodule');
    const configAfter = readFileSync(submoduleConfigPath, 'utf8');

    // OBSERVED, RECORDED: the user's store: pointer line is preserved byte-for-byte — it is
    // the very first line of the config, untouched, and stage5 never ran `openspec init` again
    // over it (inspectExistingOpenspec's brownfield branch, which prints "skipped `openspec
    // init`" instead).
    assert.equal(configAfter.startsWith(`store: ${LEGACY_STORE_ID}\n`), true,
      `the user's store: pointer must be the untouched first line; got:\n${configAfter.slice(0, 200)}`);

    // The rest of what `openspec init` originally generated is still there too (context:/rules:
    // scaffold comments etc.) — only `references:` was appended.
    const generatedBody = userConfigBefore.slice(`store: ${LEGACY_STORE_ID}\n`.length);
    assert.equal(
      configAfter.slice(0, `store: ${LEGACY_STORE_ID}\n`.length + generatedBody.length),
      `store: ${LEGACY_STORE_ID}\n${generatedBody}`,
      'the originally-generated body between the store: pointer and our appended references: must be byte-identical',
    );

    // Our own references: entry landed too, alongside — not instead of — the pointer.
    assert.ok(/^references:/m.test(configAfter), 'serpens-sdd must still declare its system store under references:');
    assert.deepEqual(declaredReferenceIds(configAfter), ['storekey-e2e-probe']);

    // The REAL CLI still resolves this spoke as its own root and does not error: the pointer is
    // ignored (planning shape wins per root-selection.js:190-196), recorded via stderr, never a
    // hard failure.
    const listed = execFileSync(oss.binPath, ['list', '--json'], {
      cwd: submodulePath, encoding: 'utf8', env: oss.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.doesNotThrow(() => JSON.parse(listed), 'openspec list --json must still produce valid JSON from the spoke');

    // Uninstall the spoke: our references: entry goes, the user's store: pointer must not.
    // OBSERVED: uninstall does NOT reverse the references: entry automatically unless told
    // which store it is — `--store-id`/`--store-remote` (src/cli/uninstall.mjs:279-280,
    // 656-663); without them row 5 is printed as "left in place, remove by hand". Not a bug —
    // the file records this as the actual, current behavior.
    const subCode = await uninstallMain([
      '--repo', submodulePath, '--apply',
      '--store-id', 'storekey-e2e-probe', '--store-remote', storeRemote,
    ]);
    assert.equal(subCode, 0);
    const configAfterUninstall = readFileSync(submoduleConfigPath, 'utf8');
    assert.equal(configAfterUninstall.startsWith(`store: ${LEGACY_STORE_ID}\n`), true,
      "uninstall --apply must leave the user's store: pointer intact");
    assert.deepEqual(declaredReferenceIds(configAfterUninstall), [], 'uninstall must remove our own references: entry');
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
  }
});
