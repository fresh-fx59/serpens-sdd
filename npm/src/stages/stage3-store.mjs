import {
  existsSync, mkdirSync, copyFileSync, cpSync, realpathSync, readFileSync, writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeShim } from '../shim.mjs';
import { LAYOUT, SERPENS_DIR as SERPENS_DIR_NAME } from '../layout.mjs';
import { registerSystemStore, readCommittedStoreId, registrationPlan } from '../storeregistry.mjs';
import { toolPath } from '../cli/tools.mjs';
import { splitInvocation } from '../invocation.mjs';
import { openspecToolId } from '../ports.mjs';
import { snapshotOpenspecToolDir, relocateAfterOpenspecRun } from '../openspec-tool-relocate.mjs';

// docs/SETUP.md §3: the four generic templates from templates/*.md go into <store>/templates/
// verbatim; the other two are renamed/relocated, not copied as-is.
const PLAIN_TEMPLATES = ['adr.md', 'research.md', 'store-contract.md', 'testing-stack.md'];

const BIN_PATH = fileURLToPath(new URL('../../bin/serpens-sdd.mjs', import.meta.url));

/**
 * Everything stage 3 would do, printed by `--dry-run`. Built from the same constants and the
 * same `config`/`kitDir` expressions the real run uses (PLAIN_TEMPLATES, the template and
 * conventions destinations, the shim path, the OpenSpec invocation), so the printed plan cannot
 * describe files this stage does not actually write. The clone/template/local decision is not
 * knowable without the `ls-remote` probe, so all three outcomes are printed as the conditional
 * they really are.
 * @param {{config: object, port?: object, storeRoot: string, kitDir: string}} opts
 * @returns {string[]}
 */
export function storePlan({ config, port, storeRoot, kitDir }) {
  const { remote, base_branch: base, id: storeId } = config.store;
  const lang = config?.lang ?? 'en';
  const { cmd: openspecCmd, args: openspecBaseArgs } = splitInvocation(config?.openspec?.invocation);
  const openspec = [openspecCmd, ...openspecBaseArgs].join(' ');
  // The wrapped executables ship from the package's own tools/ (src/cli/tools.mjs), never from
  // the vendored kit tree — kitDir only supplies language-specific prose/templates.
  const stateSh = toolPath('state', lang);
  const lines = [];
  lines.push('dry-run: stage3 would do (nothing below is executed):');
  if (existsSync(storeRoot)) {
    lines.push(`  case: local — ${storeRoot} already exists on this machine, its worktree is left untouched`);
    lines.push(`  $ git -C ${storeRoot} rev-parse --show-toplevel   # must be its own git root`);
    lines.push(`  $ git -C ${storeRoot} status --short --branch`);
    lines.push(`  $ bash ${stateSh} prepare-base --repo ${storeRoot} --base ${base}`);
  } else {
    lines.push(`  $ git ls-remote --heads ${remote} ${base}   # decides the case; a failed probe is exit 3, never "no ref"`);
    lines.push(`  case A (ref present): $ git clone --branch ${base} --single-branch ${remote} ${storeRoot}`);
    lines.push(`                        $ bash ${stateSh} prepare-base --repo ${storeRoot} --base ${base}`);
    lines.push(`  case B (no ref):      $ cp -R ${join(kitDir, 'system-store-template')} ${storeRoot}`);
    lines.push(`                        $ git init -b ${base} ${storeRoot}`);
    lines.push(`                        $ git -C ${storeRoot} remote add origin ${remote}`);
  }
  lines.push(`  $ git -C ${storeRoot} config serpens.baseBranch ${base}`);
  lines.push(`  $ mkdir -p ${join(storeRoot, LAYOUT.templates)}`);
  for (const file of PLAIN_TEMPLATES) {
    lines.push(`  $ cp ${join(kitDir, 'templates', file)} ${join(storeRoot, LAYOUT.templates, file)}`);
  }
  lines.push(`  $ cp ${join(kitDir, 'templates', 'port-facts.md')} ${join(storeRoot, LAYOUT.portFacts)}`);
  lines.push(`  $ mkdir -p ${dirname(join(storeRoot, LAYOUT.branching))}`);
  lines.push(`  $ cp ${join(kitDir, 'templates', 'conventions-branching.md')} ${join(storeRoot, LAYOUT.branching)}`);
  lines.push(`  $ cp ${join(kitDir, 'templates', 'conventions-delivery.md')} ${join(storeRoot, LAYOUT.delivery)}`);
  lines.push(`  $ write ${join(storeRoot, LAYOUT.shim)}   # the shim; no script copies, ever`);
  lines.push(`  $ ${openspec} init${openspecToolId(port) ? ` --tools ${openspecToolId(port)}` : ''}   # cwd=${storeRoot}`);
  lines.push(`  $ bash ${toolPath('openspec-root', lang)}   # cwd=${storeRoot}`);
  lines.push('  then the store-registration step (spec-openspec-store-registration-2026-09-11 §3):');
  for (const l of registrationPlan({
    openspec, storeRoot, storeId, committed: readCommittedStoreId(resolve(storeRoot)),
  })) lines.push(`  ${l}`);
  return lines;
}

/**
 * Stage 3 — create or verify the sibling system store (docs/SETUP.md §3).
 * Decides between exactly three cases, never guesses:
 *  - the remote already has the base ref: clone it, never `git init` a second history;
 *  - no ref and no local store: copy the shipped `system-store-template/` and `git init`;
 *  - the store is already on this machine: leave the worktree untouched, just gate it.
 * A remote that cannot be probed at all (network/auth/transport failure) is its own outcome —
 * never treated as "no ref", which would route into the template path against a remote that may
 * already hold the project's real history.
 * Nothing is ever deleted, reset, cleaned, rebased, force-checked-out or rewritten.
 * @param {{config: object, port?: object, run: Function, log?: object, dryRun?: boolean,
 *   storeRoot: string, kitDir: string}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function stage3(ctx) {
  const { config, port, run, log, storeRoot, kitDir, dryRun = false } = ctx;
  const lang = config?.lang ?? 'en';
  const evidence = [];

  const store = config?.store && typeof config.store === 'object' ? config.store : null;
  if (!store || !store.remote || !store.base_branch || !store.id) {
    return {
      ok: false, evidence,
      error: 'config.store is malformed: remote, base_branch and id are all required',
      exitCode: 2,
    };
  }
  // `store.id` is deliberately NOT bound to a local here: registerSystemStore may ADOPT the
  // store's committed id and rewrite `config.store.id`, and a local copy taken now would go
  // stale at exactly the moment it matters.
  const { remote, base_branch: base } = store;
  const runOpts = { log };

  if (dryRun) {
    // Printed, never executed. The branch this stage takes depends on `git ls-remote` and on
    // whether the store is already on this machine, so the plan states the probe and all three
    // outcomes rather than pretending to know which one it would be; every path below it is
    // unconditional and is listed exactly as the real run performs it.
    for (const line of storePlan({ config, port, storeRoot, kitDir })) evidence.push(line);
    return { ok: true, evidence };
  }

  async function step(cmd, args, opts = {}) {
    const result = await run(cmd, args, { ...runOpts, ...opts });
    evidence.push(`$ ${cmd} ${args.join(' ')} → exit ${result.code}`);
    return result;
  }

  // Every direct filesystem write (no `run`/`log` involved) still gets its own evidence line,
  // in the same shape `step()` produces, so a handover has no invisible action.
  function recordWrite(description, fn) {
    fn();
    evidence.push(`$ ${description} → done`);
  }

  let storeCase;

  if (existsSync(storeRoot)) {
    // Case 3: the store is already on this machine. Prove it is its own git root before
    // touching anything, then leave the worktree exactly as it is.
    storeCase = 'local';
    const rootResult = await step('git', ['-C', storeRoot, 'rev-parse', '--show-toplevel']);
    if (rootResult.code !== 0) {
      return {
        ok: false, evidence,
        error: `${storeRoot} exists but is not a git repository`,
        exitCode: 3,
      };
    }
    let resolvedTop;
    try {
      resolvedTop = realpathSync(rootResult.stdout.trim());
    } catch {
      resolvedTop = rootResult.stdout.trim();
    }
    let resolvedStoreRoot;
    try {
      resolvedStoreRoot = realpathSync(storeRoot);
    } catch {
      resolvedStoreRoot = resolve(storeRoot);
    }
    if (resolvedTop !== resolvedStoreRoot) {
      return {
        ok: false, evidence,
        error: `${storeRoot} exists but is not its own git root (found ${rootResult.stdout.trim()})`,
        exitCode: 3,
      };
    }
    await step('git', ['-C', storeRoot, 'status', '--short', '--branch']);
    const prepared = await step('bash', [toolPath('state', lang), 'prepare-base', '--repo', storeRoot, '--base', base]);
    if (prepared.code !== 0) {
      return { ok: false, evidence, error: `state prepare-base failed on the existing local store:\n${prepared.stderr || prepared.stdout}`, exitCode: 1 };
    }
  } else {
    const lsRemote = await step('git', ['ls-remote', '--heads', remote, base]);
    if (lsRemote.code !== 0) {
      // The probe itself failed (network/auth/transport) — this is NOT "no ref". Never fall
      // through to the template path: that would `git init` a second history against a remote
      // that may already hold the project's real store.
      return {
        ok: false, evidence,
        error: `git ls-remote could not reach '${remote}' to decide whether the store already exists there:\n${lsRemote.stderr || lsRemote.stdout}`,
        exitCode: 3,
      };
    }
    if ((lsRemote.stdout || '').trim()) {
      // Case 1: the store already exists on the remote — clone it, never git init.
      storeCase = 'clone';
      const cloned = await step('git', ['clone', '--branch', base, '--single-branch', remote, storeRoot]);
      if (cloned.code !== 0) {
        return { ok: false, evidence, error: `git clone of the system store failed:\n${cloned.stderr}`, exitCode: 1 };
      }
      const prepared = await step('bash', [toolPath('state', lang), 'prepare-base', '--repo', storeRoot, '--base', base]);
      if (prepared.code !== 0) {
        return { ok: false, evidence, error: `state prepare-base failed after cloning:\n${prepared.stderr || prepared.stdout}`, exitCode: 1 };
      }
    } else {
      // Case 2: nothing on the remote and nothing local — start from the shipped template.
      storeCase = 'template';
      recordWrite(`cp -R ${join(kitDir, 'system-store-template')} ${storeRoot}`, () => {
        cpSync(join(kitDir, 'system-store-template'), storeRoot, { recursive: true });
      });
      const inited = await step('git', ['init', '-b', base, storeRoot]);
      if (inited.code !== 0) {
        return { ok: false, evidence, error: `git init of the new store failed:\n${inited.stderr}`, exitCode: 1 };
      }
      const remoteAdd = await step('git', ['-C', storeRoot, 'remote', 'add', 'origin', remote]);
      if (remoteAdd.code !== 0) {
        return { ok: false, evidence, error: `git remote add failed:\n${remoteAdd.stderr}`, exitCode: 1 };
      }
      // No `state prepare-base` here: the remote carries no ref yet, so a fetch would fail.
    }
  }

  const baseConfig = await step('git', ['-C', storeRoot, 'config', 'serpens.baseBranch', base]);
  if (baseConfig.code !== 0) {
    return { ok: false, evidence, error: `could not set serpens.baseBranch:\n${baseConfig.stderr}`, exitCode: 1 };
  }

  // Install the six templates the kit's commands cite by path. No script copies, ever — the
  // shim below replaces every `tools/<script>` copy this stage would otherwise make.
  const templatesDir = join(storeRoot, LAYOUT.templates);
  recordWrite(`mkdir -p ${templatesDir}`, () => mkdirSync(templatesDir, { recursive: true }));
  for (const file of PLAIN_TEMPLATES) {
    const src = join(kitDir, 'templates', file);
    const dest = join(templatesDir, file);
    recordWrite(`cp ${src} ${dest}`, () => copyFileSync(src, dest));
  }
  const portFactsDest = join(storeRoot, LAYOUT.portFacts);
  recordWrite(`cp ${join(kitDir, 'templates', 'port-facts.md')} ${portFactsDest}`, () => {
    copyFileSync(join(kitDir, 'templates', 'port-facts.md'), portFactsDest);
  });
  const branchingDest = join(storeRoot, LAYOUT.branching);
  const conventionsDir = dirname(branchingDest);
  recordWrite(`mkdir -p ${conventionsDir}`, () => mkdirSync(conventionsDir, { recursive: true }));
  recordWrite(`cp ${join(kitDir, 'templates', 'conventions-branching.md')} ${branchingDest}`, () => {
    copyFileSync(join(kitDir, 'templates', 'conventions-branching.md'), branchingDest);
  });
  const deliveryDest = join(storeRoot, LAYOUT.delivery);
  recordWrite(`cp ${join(kitDir, 'templates', 'conventions-delivery.md')} ${deliveryDest}`, () => {
    copyFileSync(join(kitDir, 'templates', 'conventions-delivery.md'), deliveryDest);
  });
  evidence.push(`templates installed: ${PLAIN_TEMPLATES.join(', ')}, ${LAYOUT.portFacts}, ${LAYOUT.branching}, ${LAYOUT.delivery}`);

  const shimPath = writeShim(storeRoot, { binPath: BIN_PATH });
  evidence.push(`shim written: ${shimPath}`);

  const { cmd: openspecCmd, args: openspecBaseArgs } = splitInvocation(config?.openspec?.invocation);

  const initArgs = ['init'];
  if (openspecToolId(port)) initArgs.push('--tools', openspecToolId(port));
  const relocationSnapshot = snapshotOpenspecToolDir(storeRoot, port ?? {});
  const inited = await step(openspecCmd, [...openspecBaseArgs, ...initArgs], { cwd: storeRoot });
  if (inited.code !== 0) {
    return { ok: false, evidence, error: `openspec init failed in the store:\n${inited.stderr || inited.stdout}`, exitCode: 1 };
  }
  if (port) {
    const relocation = relocateAfterOpenspecRun(storeRoot, port, relocationSnapshot);
    if (relocation.moved.length > 0) {
      evidence.push(`relocated ${relocation.moved.length} OpenSpec-generated file(s) for ${port.openspec_tool} into ${port.agent_dir}/ in the store`);
    }
  }

  const rootCheck = await step('bash', [toolPath('openspec-root', lang)], { cwd: storeRoot });
  if (rootCheck.code !== 0) {
    return { ok: false, evidence, error: `check-openspec-root failed in the store:\n${rootCheck.stderr || rootCheck.stdout}`, exitCode: 1 };
  }

  // The store is now on disk, healthy and OpenSpec-initialized — the earliest point at which
  // `openspec store register` can succeed (it requires a healthy OpenSpec root,
  // operations.js:465) and still earlier than any `references:` write, which stage 5 does. See
  // src/storeregistry.mjs for why id adoption has to happen before the register call, not after.
  const registration = await registerSystemStore({
    config, run, log, storeRoot, configPath: ctx.configPath, dryRun,
    openspecCmd, openspecBaseArgs,
    ...(ctx.registryAttempts !== undefined ? { registryAttempts: ctx.registryAttempts } : {}),
    ...(ctx.registryBackoffMs !== undefined ? { registryBackoffMs: ctx.registryBackoffMs } : {}),
  });
  evidence.push(...registration.evidence);
  if (!registration.ok) {
    // A registry failure of ANY kind stops the run here, so stage 5 never writes a `references:`
    // entry for a store we failed to register — a reference to an unregistered store is exactly
    // the decoration this whole step exists to eliminate.
    return { ok: false, evidence, error: registration.error, exitCode: registration.exitCode ?? 1 };
  }

  return {
    ok: true, evidence, case: storeCase,
    ...(registration.skipped ? { registrationSkipped: registration.skipped } : {}),
    ...(registration.adoptedId ? { adoptedId: registration.adoptedId } : {}),
  };
}

/** The run-log pattern repo-local mode ignores inside `serpens/` (the log lives there, since
 * there is no store to hold it — see `logPathFor` in src/cli/init.mjs). */
export const INIT_LOG_IGNORE = '.serpens-sdd-init-*.log';

/**
 * Repo-local replacement for stage 3 (step 6, gap 3 — spec-openspec-coexistence-2026-09-22.md).
 * There is no store: the branching contract the store would hold is seeded into the trial
 * repository's OWN `serpens/` instead — `branching.md` from `templates/conventions-branching.md`
 * — ONLY WHEN ABSENT, so a re-run (or a team that already edited it) never loses an answer.
 * (`port-facts.md` is rendered by stage 6 into the same `serpens/`; see the note below.) `tools/lib/branch-contract.sh` already
 * resolves `<repo-root>/serpens/branching.md` by default, so the hooks find it with no env var.
 * Also seeds `serpens/.gitignore` with the init run-log pattern (our file, under our directory;
 * the line is appended if the file exists without it). No git call, no network, no store.
 * @param {{config: object, repoRoot: string, kitDir: string, dryRun?: boolean}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string}>}
 */
export async function seedRepoFacts(ctx) {
  const { repoRoot, kitDir, dryRun = false } = ctx;
  const evidence = [];
  // Only branching.md. port-facts.md is NOT seeded from the raw template here (deviation from
  // the spec's table, recorded there): in repo-local the repository that holds the facts is
  // also the one stage 5 onboards, and stage 5's verify-docs lints `serpens/port-facts.md` —
  // the raw template fails that lint by design (placeholder header, `...` probe row). In store
  // mode the same raw copy sits in the store, which stage 5 never verifies. Stage 6 writes the
  // RENDERED port-facts.md into this repo instead (`ctx.factsRoot`), exactly as it re-renders
  // the store's copy today.
  const seeds = [
    [join(kitDir, 'templates', 'conventions-branching.md'), join(repoRoot, LAYOUT.branching), LAYOUT.branching],
    [join(kitDir, 'templates', 'conventions-delivery.md'), join(repoRoot, LAYOUT.delivery), LAYOUT.delivery],
  ];
  const gitignorePath = join(repoRoot, LAYOUT.gitignore);

  if (dryRun) {
    evidence.push('dry-run: repo-local facts would be seeded (no store; nothing below is executed):');
    for (const [src, dest] of seeds) {
      evidence.push(`  $ cp ${src} ${dest}   # only when absent; never overwritten`);
    }
    evidence.push(`  $ write ${gitignorePath}   # ignores ${INIT_LOG_IGNORE}`);
    return { ok: true, evidence };
  }

  mkdirSync(join(repoRoot, SERPENS_DIR_NAME), { recursive: true });
  for (const [src, dest, rel] of seeds) {
    if (existsSync(dest)) {
      evidence.push(`${rel} already present — not overwritten`);
      continue;
    }
    copyFileSync(src, dest);
    evidence.push(`$ cp ${src} ${dest} → done`);
  }
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : null;
  if (current === null) {
    writeFileSync(gitignorePath, `${INIT_LOG_IGNORE}\n`, 'utf8');
    evidence.push(`$ write ${gitignorePath} → done`);
  } else if (!current.split(/\r?\n/).includes(INIT_LOG_IGNORE)) {
    writeFileSync(gitignorePath, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${INIT_LOG_IGNORE}\n`, 'utf8');
    evidence.push(`$ append ${INIT_LOG_IGNORE} to ${gitignorePath} → done`);
  }
  return { ok: true, evidence };
}
