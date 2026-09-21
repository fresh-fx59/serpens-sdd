// preserved-public-docs.mjs — Node-side reader for tests/preserved-public-docs.sh.
//
// spec-npm-oidc-publishing-2026-09-11.md §10 lists the eight per-kit docs/ files (four per
// language) plus three repo-root files that exist ONLY in the public repository (fresh-fx59/serpens-sdd) and
// must never be synced from, or deleted by, the vault. That list is declared exactly ONCE, in
// tests/preserved-public-docs.sh (a bash-sourceable file so starter-contract-test.sh can
// `source` it directly). This module parses the SAME file rather than restating the list, so a
// future edit to the preserve set can never update one consumer and miss the other.
//
// Deliberately a tiny line-oriented parser, not a `bash -c source` subprocess: the file's
// format is fixed and simple (three `NAME='space separated values'` assignments), and avoiding
// a shell-out keeps this importable from a pure-Node test with no bash on PATH.
import { readFileSync } from 'node:fs';

const ASSIGNMENT = /^([A-Z_]+)='([^']*)'$/;

/**
 * Parse tests/preserved-public-docs.sh into its three declared lists.
 * @param {string} path absolute path to tests/preserved-public-docs.sh
 * @returns {{docNames: string[], docGlobs: string[], rootFiles: string[]}}
 * @throws if any of the three expected assignments is missing — fail loudly rather than
 *   silently treating an edited-out-of-shape file as "nothing preserved".
 */
export function loadPreservedPublicDocs(path) {
  const text = readFileSync(path, 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const m = ASSIGNMENT.exec(line.trim());
    if (m) values[m[1]] = m[2].split(/\s+/).filter(Boolean);
  }
  const required = ['PRESERVED_PUBLIC_DOC_NAMES', 'PRESERVED_PUBLIC_DOC_GLOBS', 'PRESERVED_PUBLIC_ROOT_FILES'];
  const missing = required.filter((k) => !(k in values));
  if (missing.length > 0) {
    throw new Error(
      `${path}: could not parse ${missing.join(', ')} — expected lines like NAME='a b c'; `
      + 'refusing to guess an empty preserve list',
    );
  }
  return {
    docNames: values.PRESERVED_PUBLIC_DOC_NAMES,
    docGlobs: values.PRESERVED_PUBLIC_DOC_GLOBS,
    rootFiles: values.PRESERVED_PUBLIC_ROOT_FILES,
  };
}

/**
 * Turn a glob of the shape `PREFIX-*-SUFFIX.ext` (the only shape this file's globs use) into a
 * RegExp. Throws on any glob syntax this simple translator does not understand, rather than
 * matching too much or too little.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  if (!/^[A-Za-z0-9_.-]*\*[A-Za-z0-9_.-]*$/.test(glob) || (glob.match(/\*/g) || []).length !== 1) {
    throw new Error(`globToRegExp: unsupported glob shape "${glob}" (expected exactly one '*' among literal characters)`);
  }
  const [prefix, suffix] = glob.split('*');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc(prefix)}.*${esc(suffix)}$`);
}

/**
 * True if `basename` (a docs/ file's name, no directory component) is one of the preserved
 * per-kit doc names or matches a preserved glob.
 * @param {string} basename
 * @param {{docNames: string[], docGlobs: string[]}} preserved
 * @returns {boolean}
 */
export function isPreservedDocBasename(basename, preserved) {
  if (preserved.docNames.includes(basename)) return true;
  return preserved.docGlobs.some((g) => globToRegExp(g).test(basename));
}
