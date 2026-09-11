// kit-source.mjs — the ONE place that answers "where is the en/ru starter kit tree?".
//
// The same two trees live under two different names depending on which checkout you are in:
//
//   this vault                 the public repository
//   ------------------------   ---------------------
//   serpens-sdd-starter/       en/
//   serpens-sdd-starter-ru/    ru/
//
// The published names cannot be changed — the released zips and every published link point at
// them — and the vault names are the ones every script and suite grew up with. So both are
// accepted, tried in that order, and a missing tree is a LOUD failure naming every path that
// was tried. Silently skipping is the one behaviour forbidden here: a kit gate that scans a
// directory that does not exist reports green while checking nothing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** The directory the kit trees sit in: the package's own parent, in either checkout. */
export const VAULT_ROOT = join(PKG_ROOT, '..');

/**
 * Candidate directory names per language, in priority order: the vault's spelling first, the
 * published spelling second. Order is part of the contract — a checkout holding both resolves
 * to the vault tree, which is the source of truth the published one is synced FROM.
 */
export const KIT_SOURCE_CANDIDATES = {
  en: ['serpens-sdd-starter', 'en'],
  ru: ['serpens-sdd-starter-ru', 'ru'],
};

/** The languages, in the order every caller wants them. */
export const KIT_LANGS = ['en', 'ru'];

/**
 * Absolute path to one language's kit tree.
 * @param {'en'|'ru'} lang
 * @param {string} [root] directory holding the kit trees (default: the package's parent)
 * @returns {string}
 * @throws if `lang` is unknown, or if no candidate directory exists — naming every candidate.
 */
export function resolveKitSource(lang, root = VAULT_ROOT) {
  const candidates = KIT_SOURCE_CANDIDATES[lang];
  if (!candidates) {
    throw new Error(
      `unknown kit language "${lang}" (expected one of: ${Object.keys(KIT_SOURCE_CANDIDATES).join(', ')})`,
    );
  }
  const tried = candidates.map((name) => join(root, name));
  for (const dir of tried) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    `cannot locate the ${lang} starter kit tree: none of these paths exists:\n`
    + tried.map((p) => `  ${p}`).join('\n')
    + `\n  (the vault names this tree "${candidates[0]}"; the published repository names it "${candidates[1]}")`,
  );
}

/**
 * Both kit trees, en first, as `{name, dir}` — the shape release.mjs and vendor-kits.mjs use.
 * Resolves BOTH before returning, so a half-present checkout fails on the missing one rather
 * than processing the half that happens to be there.
 * @param {string} [root]
 * @returns {Array<{name: 'en'|'ru', dir: string}>}
 */
export function resolveKitSources(root = VAULT_ROOT) {
  return KIT_LANGS.map((name) => ({ name, dir: resolveKitSource(name, root) }));
}

