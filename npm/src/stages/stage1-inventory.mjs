import { resolveRepositoryRows } from '../inventory.mjs';

/**
 * Stage 1 — discover the repository inventory (docs/SETUP.md §1).
 * Source of truth is `.gitmodules` in the store when the store already carries
 * submodules; otherwise `config.repositories`. When BOTH are present and disagree,
 * stop before writing anything — never guess which one is right.
 * `repository_source` comes from `config.facts.repository_source` (set in stage 1 of the
 * manual flow, e.g. 'mcp' or 'manual'), defaulting to 'manual'.
 * This stage writes NOTHING: it resolves the row list and records it on `ctx.repositoryRows`,
 * which stage 4 and stage 9 feed to `sync-submodules.sh --repos-from -` on stdin.
 * `project-repositories.json` is never written here (nor deleted if one already exists) — see
 * spec-drop-inventory-file-2026-09-11.md §6.
 * @param {{config: object, run: Function, storeRoot: string, dryRun?: boolean}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function stage1(ctx) {
  const { config, run, storeRoot, dryRun = false } = ctx;
  const source = config?.facts?.repository_source ?? 'manual';

  const resolved = await resolveRepositoryRows({ config, run, storeRoot });
  if (!resolved.ok) {
    return { ok: false, evidence: resolved.evidence, error: resolved.error, exitCode: resolved.exitCode };
  }
  const { evidence, rows } = resolved;

  // Stage 4 and stage 9 read this to feed sync-submodules.sh on stdin — NOT the raw config,
  // which can legitimately be empty right here (see `resolveRepositoryRows`'s
  // `if (configRows.length)` guard: a store with submodules and an empty config.repositories
  // is a real, supported case). When `ctx.repositoryRows` is absent (a partial `--only 4`/`9`
  // rerun that skipped this stage), stage 4/9 call `resolveRepositoryRows` themselves instead
  // of defaulting to an empty list.
  ctx.repositoryRows = rows;

  if (dryRun) {
    evidence.push(`dry-run: resolved ${rows.length} repository row(s) for stage 4/9 (stdin), `
      + `project=${config?.project}, repository_source=${source}`);
    for (const r of rows) {
      evidence.push(`  row: ${r.name} ${r.url} (${r.base_branch})`);
    }
    return { ok: true, evidence };
  }

  evidence.push(`resolved ${rows.length} repository row(s) — project-repositories.json is not written`);

  return { ok: true, evidence };
}
