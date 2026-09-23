import { relative, resolve } from 'node:path';
import { classifyOpenspecVersion } from './openspecversion.mjs';

/** The two install topologies (step 6, gap 3). `store` is the default. */
export const TOPOLOGIES = ['store', 'repo-local'];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Approximation of `git check-ref-format --branch` semantics.
const BRANCH = /^(?!\/|.*([/.]\.|\/\/|@\{|\\\\))[^\040\177 ~^:?*[]+(?<![./])$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a nested Serpens SDD config object.
 * Never throws on bad input; reports every problem it finds instead.
 * @param {object} obj - The nested config object to validate.
 * @param {{checkoutRoot?: string, resolveFrom?: string}} [opts]
 * @returns {{ok: boolean, errors: string[], value: object}}
 */
export function validateConfig(obj, opts = {}) {
  const checkoutRoot = opts.checkoutRoot ?? process.cwd();
  const resolveFrom = opts.resolveFrom ?? process.cwd();
  const errors = [];

  const config = obj && typeof obj === 'object' ? obj : {};

  // project
  if (!isNonEmptyString(config.project) || !KEBAB.test(config.project)) {
    errors.push('project must be lower-case kebab-case (e.g. acme-billing)');
  }

  // topology (step 6, gap 3 — spec-openspec-coexistence-2026-09-22.md). `store` (the default,
  // unchanged behaviour) = a sibling system store plus submodules; `repo-local` = ONE repository,
  // no store, no submodule, no push. `store:`/`repositories:` are FORBIDDEN in repo-local rather
  // than ignored, so nobody believes a store is in play when none is.
  const topology = config.topology === undefined ? 'store' : config.topology;
  if (!TOPOLOGIES.includes(topology)) {
    errors.push(`topology must be one of ${TOPOLOGIES.join(', ')} (got '${config.topology}')`);
  }

  if (topology === 'repo-local') {
    if (config.store !== undefined) {
      errors.push('store: is not allowed with topology repo-local (there is no system store) — remove it');
    }
    if (config.repositories !== undefined) {
      errors.push('repositories: is not allowed with topology repo-local (the one repository is repo:) — remove it');
    }
    const repo = config.repo && typeof config.repo === 'object' ? config.repo : {};
    // repo.root is NOT subject to the store's outside-the-checkout rule: the trial user runs
    // init from inside their own repository. That it is its own git top-level is proven by
    // `init` (a git call), not here — this validator stays pure.
    if (!isNonEmptyString(repo.root)) {
      errors.push('repo.root is required with topology repo-local (the repository to onboard, e.g. .)');
    }
    if (!isNonEmptyString(repo.name) || !KEBAB.test(repo.name)) {
      errors.push('repo.name must be lower-case kebab-case (written to serpens/repo.txt)');
    }
    if (!isNonEmptyString(repo.base_branch) || !BRANCH.test(repo.base_branch)) {
      errors.push('repo.base_branch must be a valid git branch name');
    }
  }

  // store (store topology only)
  const isStore = topology !== 'repo-local';
  const storeIn = config.store && typeof config.store === 'object' ? config.store : {};
  const store = { ...storeIn };
  if (isStore && !isNonEmptyString(store.id)) {
    store.id = isNonEmptyString(config.project) ? `${config.project}-store` : undefined;
  }
  if (isStore && (!isNonEmptyString(store.id) || !KEBAB.test(store.id))) {
    errors.push('store.id must be lower-case kebab-case (e.g. acme-billing-store)');
  }
  if (!isStore) {
    // repo-local: no store to validate.
  } else if (!isNonEmptyString(store.root)) {
    errors.push('store.root is required');
  } else {
    const absRoot = resolve(resolveFrom, store.root);
    const absCheckout = resolve(checkoutRoot);
    const rel = relative(absCheckout, absRoot);
    // store.root must resolve OUTSIDE checkoutRoot: relative() starting with '..' is "outside";
    // anything else (including '' for identical paths, or a path with no leading '..') is inside.
    if (!rel.startsWith('..')) {
      errors.push('store.root must resolve outside the serpens-sdd checkout');
    }
  }
  if (isStore && !isNonEmptyString(store.remote)) {
    errors.push('store.remote must be a non-empty string');
  }
  if (isStore && (!isNonEmptyString(store.base_branch) || !BRANCH.test(store.base_branch))) {
    errors.push('store.base_branch must be a valid git branch name');
  }

  // repositories
  const repositories = Array.isArray(config.repositories) ? config.repositories : [];
  if (isStore && !Array.isArray(config.repositories)) {
    errors.push('repositories must be an array');
  }
  const seenNames = new Set();
  if (isStore) repositories.forEach((repo, i) => {
    const r = repo && typeof repo === 'object' ? repo : {};
    const path = `repositories[${i}]`;
    if (!isNonEmptyString(r.name) || !KEBAB.test(r.name)) {
      errors.push(`${path}.name must be lower-case kebab-case and a safe single path segment`);
    } else if (seenNames.has(r.name)) {
      errors.push(`${path}.name must be unique across repositories ('${r.name}' is duplicated)`);
    } else {
      seenNames.add(r.name);
    }
    if (!isNonEmptyString(r.url)) {
      errors.push(`${path}.url must be a non-empty string`);
    }
    if (!isNonEmptyString(r.base_branch) || !BRANCH.test(r.base_branch)) {
      errors.push(`${path}.base_branch must be a valid git branch name`);
    }
  });

  // lang / port_scope defaults
  const lang = isNonEmptyString(config.lang) ? config.lang : 'en';
  const port_scope = isNonEmptyString(config.port_scope) ? config.port_scope : 'auto';

  // openspec
  const openspec = config.openspec && typeof config.openspec === 'object' ? config.openspec : {};
  if (!isNonEmptyString(openspec.invocation)) {
    errors.push('openspec.invocation must be a non-empty string');
  }
  // openspec.pinned_version is OPTIONAL: with it absent, proveOpenspec's only constraint is the
  // detected version falling inside SUPPORTED_MINORS (openspecversion.mjs). When set, it must
  // still be a non-empty string here; proveOpenspec is what checks it against what's detected.
  if ('pinned_version' in openspec && !isNonEmptyString(openspec.pinned_version)) {
    errors.push('openspec.pinned_version, if set, must be a non-empty string');
  }

  // facts: recorded, never dispatched on.
  const facts = config.facts && typeof config.facts === 'object' ? config.facts : {};

  const value = {
    ...config,
    topology,
    project: config.project,
    lang,
    port_scope,
    openspec,
    facts,
  };
  if (isStore) {
    value.store = store;
    value.repositories = repositories;
  }

  return { ok: errors.length === 0, errors, value };
}

/**
 * Prove that the configured openspec invocation resolves to a supported version: it must
 * parse, it must fall inside SUPPORTED_MINORS (openspecversion.mjs), and if the config sets an
 * explicit `pinned_version` it must match the detected version exactly. Nothing is written by
 * a failed proof — the caller (stage0) stops before any stage that would.
 * @param {object} config - A (validated) nested config object.
 * @param {{run: Function}} deps - Injected `run` (never a real network call in tests).
 * @returns {Promise<{ok: boolean, exitCode?: number, error?: string, version?: object, minorKey?: string}>}
 */
export async function proveOpenspec(config, { run }) {
  const invocation = config?.openspec?.invocation ?? '';
  const pinned = config?.openspec?.pinned_version;
  const parts = invocation.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, exitCode: 3, error: 'openspec.invocation is empty' };
  }
  const [cmd, ...args] = parts;
  const result = await run(cmd, [...args, '--version']);
  if (result.code !== 0) {
    return {
      ok: false,
      exitCode: 3,
      error: `openspec invocation '${invocation}' exited ${result.code}: ${result.stderr || result.stdout}`,
    };
  }
  const actual = (result.stdout || '').trim();
  const classified = classifyOpenspecVersion(actual);
  if (!classified.ok && classified.reason === 'unparseable') {
    return {
      ok: false,
      exitCode: 3,
      error: `openspec version unparseable: '${actual}' from '${invocation}'; nothing was written`,
    };
  }
  if (!classified.ok && classified.reason === 'unsupported') {
    return {
      ok: false,
      exitCode: 3,
      error: `openspec version '${actual}' (minor ${classified.minorKey}) is not supported; `
        + `supported minors are ${classified.supported.join(', ')}; nothing was written`,
    };
  }
  if (isNonEmptyString(pinned) && actual !== pinned) {
    return {
      ok: false,
      exitCode: 3,
      error: `openspec version mismatch: expected pinned ${pinned}, got '${actual}'; nothing was written`,
    };
  }
  return { ok: true, version: classified.version, minorKey: classified.minorKey };
}
