import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveTool } from '../cli/tools.mjs';

// docs/SETUP.md §8: "run all tools against temporary bad inputs before using a live change."
// Every check below builds its own throwaway bad input in a fresh mkdtempSync directory and
// proves the guard REJECTS it — never against a real target, and nothing here ever touches a
// real repository. No guard is ever weakened to make this stage green: a guard that accepts bad
// input is a stage-8 failure, reported as such, never accommodated.

/**
 * A tracker for the throwaway fixture directories one guard creates, so every guard removes
 * exactly what it made instead of leaving ~8 `mkdtempSync` directories behind on every run.
 * The ONLY paths it ever removes are the ones this call itself created under `tmpdir()`; no
 * target repository is ever touched, and a removal failure is swallowed (a leftover temp
 * directory must never fail a guard proof).
 * @returns {{dir(prefix: string): string, cleanup(): void}}
 */
function tempDirs() {
  const made = [];
  return {
    dir(prefix) {
      const d = mkdtempSync(join(tmpdir(), prefix));
      made.push(d);
      return d;
    },
    cleanup() {
      for (const d of made.reverse()) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* leave it */ }
      }
    },
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir, { branch = 'develop' } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch, dir]);
  git(dir, ['config', 'user.email', 'stage8@example.com']);
  git(dir, ['config', 'user.name', 'Stage8']);
  writeFileSync(join(dir, 'README.md'), '# stage8 fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial commit']);
  return dir;
}

/**
 * Stage a Serpens-owned path (under `serpens/`) so check-git-naming.sh's ownership gate (gap 1,
 * serpens-openspec-coexistence-gaps-2026-09-22.md, step 3) treats the guard's bad-input commit
 * as Serpens work — every real onboarded repository's commits touch `serpens/` sooner or later,
 * and these guards must keep proving the naming convention itself is enforced, not re-prove the
 * ownership gate (that gate has its own suite, tests/git-naming-ownership-test.sh).
 */
function stageOwnedMarker(dir) {
  mkdirSync(join(dir, 'serpens'), { recursive: true });
  writeFileSync(join(dir, 'serpens', '.stage8-fixture'), 'x\n');
  git(dir, ['add', 'serpens/.stage8-fixture']);
}

/**
 * Guard 1 — a wrong OpenSpec root must fail. Nest an un-onboarded repo (no `openspec/` of its
 * own) inside a directory that itself carries an `openspec/` root. `check-openspec-root.sh`
 * refuses on its OWN early check ("no openspec/ in this repo") before it ever reaches the
 * upward-walk-mismatch branch — this bad input never exercises that second branch, only the
 * first. Still a genuine "wrong root" case (the fix path it prints — `openspec init` here — is
 * exactly what a correctly-nested repo needs), just via the simpler of the script's two exits.
 */
async function guardWrongOpenspecRoot({ run, lang = 'en' }) {
  const evidence = [];
  const tmp = tempDirs();
  try {
    const parent = tmp.dir('serpens-sdd-stage8-root-');
    mkdirSync(join(parent, 'openspec', 'specs'), { recursive: true });
    const child = join(parent, 'child');
    initRepo(child);
    const { cmd, args } = resolveTool('openspec-root', [], lang);
    const result = await run(cmd, args, { cwd: child });
    evidence.push(`$ ${cmd} ${args.join(' ')} (cwd=${child}, no openspec/ of its own) → exit ${result.code}`);
    return { ok: result.code !== 0, evidence, detail: result.code === 0 ? 'check-openspec-root.sh accepted a wrong root' : undefined };
  } finally {
    tmp.cleanup();
  }
}

/**
 * Guard 2 — a duplicated shared contract shape must fail the split-brain check. A store
 * carries a spec with a `### Requirement:` heading; a spoke declares `references:` to that
 * store and restates the same heading verbatim. `OPENSPEC_STORE_REGISTRY` is pointed at a
 * throwaway registry file so this never touches the real one.
 */
async function guardSplitBrain({ run, lang = 'en' }) {
  const evidence = [];
  const tmp = tempDirs();
  try {
    const storeDir = tmp.dir('serpens-sdd-stage8-store-');
    mkdirSync(join(storeDir, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(
      join(storeDir, 'openspec', 'specs', 'billing', 'spec.md'),
      '### Requirement: Invoices are issued in the customer currency\nSome body text.\n',
      'utf8',
    );

    const spokeDir = tmp.dir('serpens-sdd-stage8-spoke-');
    mkdirSync(join(spokeDir, 'openspec', 'specs'), { recursive: true });
    writeFileSync(
      join(spokeDir, 'openspec', 'config.yaml'),
      'references:\n  - id: stage8-store\n    remote: ssh://git@forge/stage8/store.git\n',
      'utf8',
    );
    mkdirSync(join(spokeDir, 'openspec', 'specs', 'own'), { recursive: true });
    writeFileSync(
      join(spokeDir, 'openspec', 'specs', 'own', 'spec.md'),
      '### Requirement: Invoices are issued in the customer currency\nRestated here, which is exactly the fault.\n',
      'utf8',
    );

    const registryFile = join(tmp.dir('serpens-sdd-stage8-registry-'), 'registry.yaml');
    writeFileSync(registryFile, `  stage8-store:\n    local_path: ${storeDir}\n`, 'utf8');

    const { cmd, args } = resolveTool('split-brain', [], lang);
    const result = await run(cmd, args, {
      cwd: spokeDir,
      env: { ...process.env, OPENSPEC_STORE_REGISTRY: registryFile },
    });
    evidence.push(`$ ${cmd} ${args.join(' ')} (cwd=${spokeDir}, restated heading) → exit ${result.code}`);
    return { ok: result.code !== 0, evidence, detail: result.code === 0 ? 'split-brain check accepted a restated contract heading' : undefined };
  } finally {
    tmp.cleanup();
  }
}

/**
 * Guard 3 — a bad branch name must fail naming checks.
 */
async function guardBadBranch({ run, lang = 'en' }) {
  const evidence = [];
  const tmp = tempDirs();
  try {
    const dir = tmp.dir('serpens-sdd-stage8-branch-');
    initRepo(dir, { branch: 'not-a-good-branch-name' });
    stageOwnedMarker(dir);
    const { cmd, args } = resolveTool('git-naming', ['--branch'], lang);
    const result = await run(cmd, args, { cwd: dir });
    evidence.push(`$ ${cmd} ${args.join(' ')} (branch=not-a-good-branch-name) → exit ${result.code}`);
    return { ok: result.code !== 0, evidence, detail: result.code === 0 ? 'check-git-naming.sh --branch accepted a malformed branch name' : undefined };
  } finally {
    tmp.cleanup();
  }
}

/**
 * Guard 4 — a mismatched ticket in a commit message must fail naming checks: the branch names
 * one ticket, the commit message another.
 */
async function guardMismatchedTicket({ run, lang = 'en' }) {
  const evidence = [];
  const tmp = tempDirs();
  try {
    const dir = tmp.dir('serpens-sdd-stage8-ticket-');
    initRepo(dir, { branch: 'feature/ABCD-1234' });
    stageOwnedMarker(dir);
    const msgFile = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(msgFile, 'feat(WXYZ-9999): message ticket does not match the branch ticket\n', 'utf8');
    const { cmd, args } = resolveTool('git-naming', ['--commit-msg', msgFile], lang);
    const result = await run(cmd, args, { cwd: dir });
    evidence.push(`$ ${cmd} ${args.join(' ')} (branch=feature/ABCD-1234, message ticket=WXYZ-9999) → exit ${result.code}`);
    return { ok: result.code !== 0, evidence, detail: result.code === 0 ? 'check-git-naming.sh --commit-msg accepted a mismatched ticket' : undefined };
  } finally {
    tmp.cleanup();
  }
}

/**
 * A `core.hooksPath` value is acceptable exactly when it is unset (git falls back to
 * `.git/hooks`, which is always repository-local) or when it resolves to a path INSIDE the
 * repository — never an absolute path elsewhere, which would let hooks be swapped out from
 * under this repository by something with write access to that other location.
 * @param {{repoRoot: string, run: Function}} opts
 * @returns {Promise<{ok: boolean, value: string}>}
 */
export async function checkHooksPathIsLocal({ repoRoot, run }) {
  const result = await run('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath']);
  const value = (result.stdout || '').trim();
  if (result.code !== 0 || value === '') {
    return { ok: true, value: '' };
  }
  const abs = resolve(repoRoot, value);
  const rel = relative(repoRoot, abs);
  const local = !isAbsolute(rel) && !rel.startsWith('..');
  return { ok: local, value };
}

/**
 * Guard 5 — `core.hooksPath` must be empty or repository-local. Bad input: set it to an
 * absolute path OUTSIDE the repo, and the check must refuse it.
 */
async function guardHooksPath({ run }) {
  const evidence = [];
  const tmp = tempDirs();
  try {
    const dir = tmp.dir('serpens-sdd-stage8-hookspath-');
    initRepo(dir);
    const outside = tmp.dir('serpens-sdd-stage8-hookspath-outside-');
    await run('git', ['-C', dir, 'config', 'core.hooksPath', outside]);
    const proof = await checkHooksPathIsLocal({ repoRoot: dir, run });
    evidence.push(`core.hooksPath set to an outside path (${outside}) → checkHooksPathIsLocal ok=${proof.ok}`);
    return { ok: !proof.ok, evidence, detail: proof.ok ? 'checkHooksPathIsLocal accepted a hooksPath outside the repository' : undefined };
  } finally {
    tmp.cleanup();
  }
}

/**
 * Guard 6 — a deliberate bad temporary commit must be rejected by the installed hook. Builds a
 * real git repository, installs a real `commit-msg` hook that calls the shipped
 * `check-git-naming.sh`, then attempts a commit whose message ticket does not match its
 * branch's ticket. The hook must reject it (`git commit` exits non-zero).
 *
 * Exported (not only called from `stage8`) so a test can pass `hookBody` to deliberately
 * WEAKEN the installed hook (e.g. a bare `exit 0`) and assert this function itself reports the
 * bad commit was wrongly accepted — proof that the assertion is a real check of `git commit`'s
 * outcome, not an assumption.
 * @param {{run: Function}} ctx
 * @param {{hookBody?: string}} [opts]
 * @returns {Promise<{ok: boolean, evidence: string[], detail?: string}>}
 */
export async function proveBadCommitRejected({ run, lang = 'en' }, { hookBody } = {}) {
  const evidence = [];
  const tmp = tempDirs();
  try {
    const dir = tmp.dir('serpens-sdd-stage8-hook-');
    initRepo(dir, { branch: 'feature/ABCD-1234' });

    const hooksDir = join(dir, '.serpens-sdd-hooks');
    mkdirSync(hooksDir, { recursive: true });
    const { cmd: naming, args: namingArgs } = resolveTool('git-naming', ['--commit-msg', '"$1"'], lang);
    const body = hookBody ?? `#!/bin/sh\nexec ${naming} ${namingArgs.join(' ')}\n`;
    const hookPath = join(hooksDir, 'commit-msg');
    writeFileSync(hookPath, body, 'utf8');
    chmodSync(hookPath, 0o755);
    await run('git', ['-C', dir, 'config', 'core.hooksPath', '.serpens-sdd-hooks']);

    writeFileSync(join(dir, 'file.txt'), 'change\n', 'utf8');
    // Owned path staged too — check-git-naming.sh's ownership gate (gap 1, step 3) must see
    // this bad commit as Serpens work, or it would (correctly, per that gate) let it through.
    mkdirSync(join(dir, 'serpens'), { recursive: true });
    writeFileSync(join(dir, 'serpens', '.stage8-fixture'), 'x\n', 'utf8');
    await run('git', ['-C', dir, 'add', '-A']);
    const commit = await run('git', ['-C', dir, 'commit', '-m', 'feat(WXYZ-9999): ticket does not match the branch'], { cwd: dir });
    evidence.push(`$ git commit (bad ticket, hook=${hookBody ? 'WEAKENED' : 'real check-git-naming.sh'}) → exit ${commit.code}`);
    return {
      ok: commit.code !== 0,
      evidence,
      detail: commit.code === 0 ? 'the installed hook accepted a bad commit' : undefined,
    };
  } finally {
    tmp.cleanup();
  }
}

const GUARDS = [
  ['a wrong OpenSpec root', guardWrongOpenspecRoot],
  ['a duplicated shared contract shape', guardSplitBrain],
  ['a bad branch name', guardBadBranch],
  ['a mismatched ticket in a commit message', guardMismatchedTicket],
  ['git config core.hooksPath empty or repository-local', guardHooksPath],
  ['a deliberate bad commit rejected by the installed hook', proveBadCommitRejected],
];

/**
 * Stage 8 — prove hooks and guards (docs/SETUP.md §8). Runs every shipped guard against a
 * deliberately bad, throwaway input and asserts each one refuses it. A guard that accepts bad
 * input is reported as a stage-8 failure; nothing here is ever weakened to make it pass, and
 * nothing here ever touches a real repository — every fixture lives in its own mkdtempSync
 * directory.
 * @param {{run: Function, dryRun?: boolean}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function stage8(ctx) {
  const { dryRun = false } = ctx;
  const lang = ctx.config?.lang ?? 'en';
  const evidence = [];

  if (dryRun) {
    // Derived from GUARDS itself — the same list the real run iterates.
    evidence.push('dry-run: stage8 would prove each guard fires on its own throwaway bad input '
      + '(each fixture in a fresh temp directory, removed afterwards; no real repository is touched):');
    for (const [label] of GUARDS) evidence.push(`  guard: ${label}`);
    return { ok: true, evidence };
  }

  const failures = [];
  for (const [label, fn] of GUARDS) {
    const result = await fn({ ...ctx, lang });
    evidence.push(`--- guard: ${label} ---`);
    evidence.push(...result.evidence);
    if (result.ok) {
      evidence.push(`✓ guard fired on bad input: ${label}`);
    } else {
      failures.push(label);
      evidence.push(`✗ guard did NOT fire: ${label} — ${result.detail}`);
    }
  }

  if (failures.length) {
    return {
      ok: false,
      evidence,
      error: `guard(s) failed to fire on bad input: ${failures.join(', ')}`,
      exitCode: 1,
    };
  }

  return { ok: true, evidence };
}
