import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Parse .gitmodules text and extract submodule information.
 * Returns an array of rows with {name, url, base_branch}.
 * name is the last path segment of the submodule path.
 * Throws if a submodule is missing its branch.
 * @param {string} text - Raw .gitmodules file text
 * @returns {Array<{name: string, url: string, base_branch: string}>}
 */
export function parseGitmodules(text) {
  const rows = [];
  const lines = text.split('\n');

  let currentSubmodule = null;
  let currentPath = null;
  let currentUrl = null;
  let currentBranch = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Match [submodule "name"] sections
    const submoduleMatch = trimmed.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (submoduleMatch) {
      // Save previous submodule if exists
      if (currentSubmodule !== null) {
        if (!currentPath) {
          const err = new Error(`Submodule "${currentSubmodule}" missing path`);
          err.exitCode = 2;
          throw err;
        }
        if (!currentBranch) {
          const err = new Error(`Submodule "${currentSubmodule}" missing branch`);
          err.exitCode = 2;
          throw err;
        }
        const name = basename(currentPath);
        rows.push({
          name,
          url: currentUrl,
          base_branch: currentBranch,
        });
      }

      currentSubmodule = submoduleMatch[1];
      currentPath = null;
      currentUrl = null;
      currentBranch = null;
      continue;
    }

    // Only process lines within a submodule section
    if (currentSubmodule === null) {
      continue;
    }

    // Parse path = value
    const pathMatch = trimmed.match(/^path\s*=\s*(.+)$/);
    if (pathMatch) {
      currentPath = pathMatch[1].trim();
      continue;
    }

    // Parse url = value
    const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/);
    if (urlMatch) {
      currentUrl = urlMatch[1].trim();
      continue;
    }

    // Parse branch = value
    const branchMatch = trimmed.match(/^branch\s*=\s*(.+)$/);
    if (branchMatch) {
      currentBranch = branchMatch[1].trim();
      continue;
    }
  }

  // Don't forget the last submodule
  if (currentSubmodule !== null) {
    if (!currentPath) {
      const err = new Error(`Submodule "${currentSubmodule}" missing path`);
      err.exitCode = 2;
      throw err;
    }
    if (!currentBranch) {
      const err = new Error(`Submodule "${currentSubmodule}" missing branch`);
      err.exitCode = 2;
      throw err;
    }
    const name = basename(currentPath);
    rows.push({
      name,
      url: currentUrl,
      base_branch: currentBranch,
    });
  }

  return rows;
}

/**
 * Read .gitmodules from the store root and return rows.
 * Prefers `git config -f .gitmodules --get-regexp` when file exists,
 * falls back to parseGitmodules for raw text.
 * @param {string} storeRoot - Path to the store root
 * @param {{run: Function}} opts - Options with run function
 * @returns {Promise<Array<{name: string, url: string, base_branch: string}>>}
 */
export async function readGitmodules(storeRoot, { run }) {
  const gitmodulesPath = join(storeRoot, '.gitmodules');

  // If .gitmodules doesn't exist, return empty array
  if (!existsSync(gitmodulesPath)) {
    return [];
  }

  // Try to use git config
  const result = await run('git', ['config', '-f', gitmodulesPath, '--get-regexp', '^submodule\\.'], {
    cwd: storeRoot,
  });

  if (result.code === 0 && result.stdout) {
    // Parse git config output
    return parseGitconfigOutput(result.stdout);
  }

  // Fallback: read raw text
  const text = readFileSync(gitmodulesPath, 'utf8');
  return parseGitmodules(text);
}

/**
 * Parse output from `git config -f .gitmodules --get-regexp '^submodule\.'`
 * Output format:
 * submodule.service-a.path submodules/service-a
 * submodule.service-a.url ssh://git@forge/acme/service-a.git
 * submodule.service-a.branch develop
 * @param {string} stdout - git config output
 * @returns {Array<{name: string, url: string, base_branch: string}>}
 */
function parseGitconfigOutput(stdout) {
  const rows = [];
  const submodules = new Map();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse "submodule.NAME.FIELD VALUE"
    const match = trimmed.match(/^submodule\.([^.]+)\.(.+?)\s+(.*)$/);
    if (!match) continue;

    const [, submoduleName, field, value] = match;

    if (!submodules.has(submoduleName)) {
      submodules.set(submoduleName, {});
    }

    const data = submodules.get(submoduleName);
    data[field] = value;
  }

  // Convert to rows
  for (const [submoduleName, data] of submodules) {
    if (!data.path) {
      const err = new Error(`Submodule "${submoduleName}" missing path`);
      err.exitCode = 2;
      throw err;
    }
    if (!data.branch) {
      const err = new Error(`Submodule "${submoduleName}" missing branch`);
      err.exitCode = 2;
      throw err;
    }

    const name = basename(data.path);
    rows.push({
      name,
      url: data.url,
      base_branch: data.branch,
    });
  }

  return rows;
}

/**
 * Resolve the repository row list — the ONE mechanism stage 1, stage 4, and stage 9 all share.
 * Source of truth is `.gitmodules` in the store when the store already carries submodules;
 * otherwise `config.repositories`. When BOTH are present and disagree, stop before anything
 * downstream runs — never guess which one is right.
 *
 * Stage 1 calls this to populate `ctx.repositoryRows` on a full run. Stage 4 and stage 9 call
 * it TOO, whenever `ctx.repositoryRows` is absent (a partial `--only 4` / `--only 9` rerun that
 * never ran stage 1) — so a partial rerun re-derives the same rows stage 1 would have, instead
 * of silently treating "stage 1 didn't run" as "there are zero repositories".
 * @param {{config: object, run: Function, storeRoot: string}} opts
 * @returns {Promise<{ok: boolean, evidence: string[], rows?: Array<{name:string,url:string,base_branch:string}>, error?: string, exitCode?: number}>}
 */
export async function resolveRepositoryRows({ config, run, storeRoot }) {
  const evidence = [];

  const configRows = Array.isArray(config?.repositories) ? config.repositories : [];
  let gitmodulesRows = [];
  try {
    gitmodulesRows = await readGitmodules(storeRoot, { run });
  } catch (err) {
    evidence.push(`.gitmodules: unreadable (${err.message})`);
    return { ok: false, evidence, error: err.message, exitCode: err.exitCode ?? 2 };
  }

  const hasSubmodules = gitmodulesRows.length > 0;

  let rows;
  if (hasSubmodules) {
    evidence.push(`inventory source: .gitmodules (${gitmodulesRows.length} row(s))`);
    if (configRows.length) {
      const diffs = diffInventories(gitmodulesRows, configRows);
      if (diffs.length) {
        evidence.push(...diffs.map((d) => `disagreement: ${d}`));
        return {
          ok: false,
          evidence,
          error: `.gitmodules and config.repositories disagree:\n${diffs.join('\n')}`,
          exitCode: 2,
        };
      }
    }
    rows = gitmodulesRows;
  } else {
    evidence.push(`inventory source: config.repositories (${configRows.length} row(s))`);
    rows = configRows;
  }

  return { ok: true, evidence, rows };
}

/**
 * Serialize resolved repository rows to the `name<TAB>url<TAB>base_branch` lines
 * `tools/sync-submodules.sh --repos-from -` reads on stdin — its own internal row format
 * (see the script's per-row validation loop). This is how stage 4 and stage 9 hand it the
 * rows stage 1 already resolved (from `.gitmodules` or `config.repositories`), instead of a
 * `project-repositories.json` file that is no longer written.
 * @param {Array<{name: string, url: string, base_branch: string}>} rows
 * @returns {string}
 */
export function rowsToTsv(rows) {
  return rows.map((r) => `${r.name}\t${r.url}\t${r.base_branch}\n`).join('');
}

/**
 * Compare two arrays of repository rows and report disagreements.
 * Each disagreement is one human-readable line naming the repository and the field.
 * @param {Array<{name: string, url: string, base_branch: string}>} a
 * @param {Array<{name: string, url: string, base_branch: string}>} b
 * @returns {Array<string>} Array of human-readable disagreement lines
 */
export function diffInventories(a, b) {
  const diffs = [];

  // Build maps for easy lookup
  const mapA = new Map(a.map(row => [row.name, row]));
  const mapB = new Map(b.map(row => [row.name, row]));

  // Check all names in A
  for (const [name, rowA] of mapA) {
    if (!mapB.has(name)) {
      diffs.push(`Repository "${name}" missing from second inventory`);
      continue;
    }

    const rowB = mapB.get(name);

    // Compare each field
    if (rowA.url !== rowB.url) {
      diffs.push(`Repository "${name}": url disagreement ("${rowA.url}" vs "${rowB.url}")`);
    }
    if (rowA.base_branch !== rowB.base_branch) {
      diffs.push(`Repository "${name}": base_branch disagreement ("${rowA.base_branch}" vs "${rowB.base_branch}")`);
    }
  }

  // Check for names in B but not in A
  for (const [name, rowB] of mapB) {
    if (!mapA.has(name)) {
      diffs.push(`Repository "${name}" missing from first inventory`);
    }
  }

  return diffs;
}
