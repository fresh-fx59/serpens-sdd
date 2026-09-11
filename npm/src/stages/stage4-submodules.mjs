import { resolveTool } from '../cli/tools.mjs';
import { rowsToTsv, resolveRepositoryRows } from '../inventory.mjs';

// docs/SETUP.md §9 assigns "commit the store and each repository separately" to the
// installer, not the kit — `sync-submodules.sh` (serpens-sdd-npm/tools/sync-submodules.sh:131)
// stages `.gitmodules` and the new gitlink via `git submodule add` but never commits them, so a
// second run's `state prepare-base` sees "uncommitted changes to TRACKED files" and refuses.
// The commit is then pushed too: `prepare-base`'s OWN gate refuses an unpushed local commit
// just as hard ("<base> has N unpushed commit(s)", repository-state.sh:253-254) — leaving it
// unpushed would only move the failure from "dirty" to "ahead" on the very next run.
// This fixed, non-interactive message is used only when there is something staged — a re-run
// that added nothing must never create an empty commit (and nothing is pushed either).
const SUBMODULE_REGISTRATION_COMMIT_MESSAGE = 'chore(serpens-sdd): register project submodules';

/**
 * Stage 4 — materialize project repositories as submodules (docs/SETUP.md §4).
 * Delegates entirely to the packaged `sync-submodules.sh`, which is additive and repeatable:
 * it records every base branch in `.gitmodules`, rejects URL/path mismatches, and reports
 * removed bindings as preserved orphans rather than deleting anything. This stage never
 * touches the filesystem directly beyond that — it runs the script, commits whatever it
 * staged (so the store worktree stays clean and idempotent across runs), and records the
 * resulting state.
 * @param {{config: object, run: Function, log?: object, dryRun?: boolean,
 *   storeRoot: string, kitDir: string}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function stage4(ctx) {
  const { run, log, storeRoot, config, dryRun = false } = ctx;
  // The kit language decides WHICH vendored copy of the script runs: a `--lang ru` install must
  // never execute the English kit's executables under Russian prose.
  const lang = config?.lang ?? 'en';
  const evidence = [];
  // Stage 1 already resolved these (from `.gitmodules` when submodules exist, otherwise
  // `config.repositories` — see stage1-inventory.mjs). Fed on stdin via `--repos-from -`,
  // never through `project-repositories.json`, which is no longer written.
  // A partial rerun (`--only 4` without stage 1) never populates `ctx.repositoryRows` — resolve
  // it here too, rather than defaulting to `[]`, which would silently reconcile ZERO
  // submodules and look like a successful no-op.
  let rows = ctx.repositoryRows;
  if (!Array.isArray(rows)) {
    const resolved = await resolveRepositoryRows({ config, run, storeRoot });
    evidence.push(...resolved.evidence);
    if (!resolved.ok) {
      return { ok: false, evidence, error: resolved.error, exitCode: resolved.exitCode };
    }
    rows = resolved.rows;
    ctx.repositoryRows = rows;
  }

  if (dryRun) {
    const { cmd, args } = resolveTool('sync-submodules', ['--repos-from', '-', '--store-root', storeRoot], lang);
    evidence.push('dry-run: stage4 would do (nothing below is executed):');
    evidence.push(`  $ ${cmd} ${args.join(' ')}   # ${rows.length} row(s) piped on stdin, from stage 1's resolved inventory`);
    evidence.push(`  $ git -C ${storeRoot} diff --cached --name-only   # decides whether anything was staged`);
    evidence.push(`  if staged: $ git -C ${storeRoot} commit -m '${SUBMODULE_REGISTRATION_COMMIT_MESSAGE}'`);
    evidence.push(`  if staged: $ git -C ${storeRoot} push origin ${config?.store?.base_branch ?? '(no base_branch)'}   # the one outward write`);
    evidence.push('  if nothing staged: no commit and no push at all');
    evidence.push(`  $ git -C ${storeRoot} submodule status`);
    evidence.push(`  $ git -C ${storeRoot} diff -- .gitmodules`);
    return { ok: true, evidence };
  }

  const runOpts = { log };
  async function step(cmd, args, opts = {}) {
    const result = await run(cmd, args, { ...runOpts, ...opts });
    evidence.push(`$ ${cmd} ${args.join(' ')} → exit ${result.code}`);
    return result;
  }

  const { cmd, args } = resolveTool('sync-submodules', ['--repos-from', '-', '--store-root', storeRoot], lang);
  const synced = await step(cmd, args, { input: rowsToTsv(rows) });
  if (synced.code !== 0) {
    return {
      ok: false, evidence,
      error: `sync-submodules.sh failed:\n${synced.stderr || synced.stdout}`,
      exitCode: 1,
    };
  }

  // Commit the staged submodule registration, but ONLY when sync-submodules.sh actually staged
  // something — an already-registered, unchanged submodule set must never produce an empty commit.
  const cachedNames = await step('git', ['-C', storeRoot, 'diff', '--cached', '--name-only']);
  if ((cachedNames.stdout || '').trim()) {
    const committed = await step('git', ['-C', storeRoot, 'commit', '-m', SUBMODULE_REGISTRATION_COMMIT_MESSAGE]);
    if (committed.code !== 0) {
      return {
        ok: false, evidence,
        error: `could not commit the staged submodule registration:\n${committed.stderr || committed.stdout}`,
        exitCode: 1,
      };
    }
    evidence.push(`committed staged submodule registration: ${cachedNames.stdout.trim().split('\n').join(', ')}`);

    // Push it: repository-state.sh's own `prepare-base` gate (serpens-sdd-npm/tools/
    // repository-state.sh:253-254) refuses an origin/<base> that is behind local by even one
    // commit ("<base> has N unpushed commit(s)") — an un-pushed registration commit would make
    // every SUBSEQUENT run of this very stage fail, which is the opposite of idempotent.
    const base = config?.store?.base_branch;
    if (base) {
      const pushed = await step('git', ['-C', storeRoot, 'push', 'origin', base]);
      if (pushed.code !== 0) {
        return {
          ok: false, evidence,
          error: `could not push the submodule registration commit to origin/${base}:\n${pushed.stderr || pushed.stdout}`,
          exitCode: 1,
        };
      }
      // A push is an outward write to a SHARED remote — never silent on success, same as the
      // commit's own summary line just above: a handover must be able to paste what actually
      // happened without re-deriving it from a bare `$ git push ... → exit 0` line alone.
      evidence.push(`pushed submodule registration commit to origin/${base}`);
    }
  } else {
    evidence.push('nothing staged by sync-submodules.sh — nothing to commit');
  }

  const status = await step('git', ['-C', storeRoot, 'submodule', 'status']);
  const diff = await step('git', ['-C', storeRoot, 'diff', '--', '.gitmodules']);
  evidence.push(`submodule status:\n${status.stdout}`.trimEnd());
  if (diff.stdout) evidence.push(`.gitmodules diff:\n${diff.stdout}`.trimEnd());

  return { ok: true, evidence };
}
