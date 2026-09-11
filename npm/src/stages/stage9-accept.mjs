import { resolveTool } from '../cli/tools.mjs';
import { buildHelp } from '../cli/help.mjs';
import { rowsToTsv, resolveRepositoryRows } from '../inventory.mjs';

/**
 * Stage 9 — final acceptance (docs/SETUP.md §9). Re-runs `sync-submodules.sh` to prove the
 * whole submodule reconciliation is idempotent (an install that changes anything on a second
 * pass is not accepted), records `git status --short --branch` and `git submodule status` for
 * the store as the durable evidence of what state was reached, and appends `help --json` —
 * the install's own record of what commands and skills it built — so a handover never has to
 * re-derive that from the filesystem.
 * @param {{run: Function, log?: object, dryRun?: boolean, storeRoot: string, port?: object,
 *   config?: object, edition?: string}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function stage9(ctx) {
  const { run, log, storeRoot, port, config, dryRun = false } = ctx;
  // Same rule as every other wrapper call site: the resolved kit language picks the script.
  const lang = config?.lang ?? 'en';
  const evidence = [];
  // Same resolved rows stage 1 put in ctx and stage 4 already fed on stdin — this re-run must
  // be a no-op precisely BECAUSE the rows are unchanged, not because a file survived unwritten.
  // A partial rerun (`--only 9` without stage 1) never populates `ctx.repositoryRows` — resolve
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
    evidence.push('dry-run: stage9 would do (nothing below is executed):');
    evidence.push(`  $ ${cmd} ${args.join(' ')}   # must be a no-op re-run, or acceptance fails`);
    evidence.push(`  $ git -C ${storeRoot} status --short --branch`);
    evidence.push(`  $ git -C ${storeRoot} submodule status`);
    evidence.push('  $ help --json appended to the log as the install\'s own record');
    return { ok: true, evidence };
  }

  const runOpts = { log };
  async function step(cmd, args, opts = {}) {
    const result = await run(cmd, args, { ...runOpts, ...opts });
    evidence.push(`$ ${cmd} ${args.join(' ')} → exit ${result.code}`);
    return result;
  }

  const { cmd: syncCmd, args: syncArgs } = resolveTool('sync-submodules', ['--repos-from', '-', '--store-root', storeRoot], lang);
  const resynced = await step(syncCmd, syncArgs, { input: rowsToTsv(rows) });
  if (resynced.code !== 0) {
    return {
      ok: false,
      evidence,
      error: `sync-submodules.sh was not idempotent on re-run:\n${resynced.stderr || resynced.stdout}`,
      exitCode: 1,
    };
  }

  const status = await step('git', ['-C', storeRoot, 'status', '--short', '--branch']);
  evidence.push(`store status:\n${status.stdout}`.trimEnd());

  const subStatus = await step('git', ['-C', storeRoot, 'submodule', 'status']);
  evidence.push(`submodule status:\n${subStatus.stdout}`.trimEnd());

  const helpCtx = {
    port: port?.id ?? 'unknown',
    scope: config?.port_scope ?? 'unknown',
    lang: config?.lang ?? 'en',
    edition: ctx.edition,
  };
  const help = buildHelp(helpCtx);
  evidence.push(`help --json:\n${JSON.stringify(help, null, 2)}`);

  return { ok: true, evidence };
}
