import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every repository that carries generated call sites after an install: the store itself, plus
 * each materialized submodule under `<store>/submodules/`. Read-only.
 * @param {string} storeRoot
 * @returns {string[]}
 */
export function callSiteRoots(storeRoot) {
  const roots = [];
  if (existsSync(storeRoot)) roots.push(storeRoot);
  const submodulesDir = join(storeRoot, 'submodules');
  if (existsSync(submodulesDir)) {
    for (const entry of readdirSync(submodulesDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) roots.push(join(submodulesDir, entry.name));
    }
  }
  return roots;
}

function isExecutableFile(path) {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Spec §7.2: `--offline` asserts that route 1 (the generated `<repo>/tools/serpens-sdd` shim) or
 * route 2 (`node_modules/.bin/serpens-sdd`, only where the repository already has its own
 * `package.json`) exists for EVERY generated call site, and fails the install otherwise.
 * Route 3 (`npx --no-install`) does not count: it is the route that reaches the registry, which
 * is exactly what `--offline` is asked to rule out. Nothing here executes anything or touches
 * the network — it is a filesystem assertion about the routes the generated `lefthook.yml`,
 * command prose and CI templates call.
 * @param {{roots: string[]}} opts
 * @returns {{ok: boolean, evidence: string[], missing: string[]}}
 */
export function assertOfflineRoutes({ roots }) {
  const evidence = [];
  const missing = [];

  if (roots.length === 0) {
    return {
      ok: false,
      evidence: ['✗ --offline: no repository with generated call sites was found to check'],
      missing: [],
    };
  }

  for (const root of roots) {
    const shim = join(root, 'tools', 'serpens-sdd');
    const nodeModulesBin = join(root, 'node_modules', '.bin', 'serpens-sdd');
    if (isExecutableFile(shim)) {
      evidence.push(`✓ ${root}: route 1 present and executable (${shim})`);
    } else if (existsSync(nodeModulesBin)) {
      evidence.push(`✓ ${root}: route 2 present (${nodeModulesBin})`);
    } else {
      missing.push(root);
      evidence.push(
        `✗ ${root}: neither route 1 (${shim}) nor route 2 (${nodeModulesBin}) exists — every `
        + 'generated call site here would fall through to `npx --no-install`, which needs the registry',
      );
    }
  }

  return { ok: missing.length === 0, evidence, missing };
}
