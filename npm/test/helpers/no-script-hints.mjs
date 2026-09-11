import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

// A `/` immediately after one of these (the last non-whitespace character already emitted)
// starts a regex literal, not a division operator — the standard heuristic (division only
// follows a value: an identifier, number, `)`, `]`, or a closing quote). Checked against the
// last non-whitespace char of `out` so far.
const REGEX_CONTEXT_CHARS = new Set(['(', ',', '=', ':', ';', '!', '&', '|', '?', '{', '[', '\n', '+', '-', '*', '%', '^', '~', '<', '>']);

/**
 * Blank out JS comments (`//...` and `/*...*​/`) in `text`, preserving every newline and the
 * length of every non-newline character removed — so a caller doing a line-numbered scan of the
 * result still reports the right line. String/template literals are left completely untouched:
 * they are exactly the surface this check cares about (a user-facing message is always a string
 * literal argument to `console.log`/`console.error`/`throw new Error(...)`/etc, never a bare
 * comment), so blanking only comments is what mechanically separates "a source citation for a
 * reader" from "a message this program prints or throws." Regex literals are also left
 * completely alone (copied through verbatim, never blanked, never re-tokenized) — not because
 * they can carry a user-facing message (in valid JS they can't: any `/` a regex needs to MATCH
 * must be escaped or bracketed, which breaks a plain `tools/x.mjs` substring match against its
 * source anyway), but because a regex literal's own internal escaped slashes (`\/\/`, or an
 * escaped slash immediately before the closing delimiter) otherwise look exactly like a `//`
 * comment-start to a naive scanner, silently blanking whatever real code — including a genuine
 * bad string — follows it on the same line. Reproduced and fixed: without regex-literal
 * awareness, `const re = /https:\/\//; console.error('tools/gen-index.mjs')` blanked
 * everything from partway through the regex onward, hiding the console.error entirely.
 *
 * Handles `'...'`, `"..."` and `` `...` `` with backslash-escaped quotes; does not handle nested
 * `${...}` interpolation inside a template literal containing its own backtick (none of this
 * package's files do that around a `tools/*.sh`/`tools/*.mjs` string, so this is precise enough
 * for the files it runs against — if a future file needs it, extend this rather than loosen the
 * check it feeds). Regex-literal detection is the standard heuristic (previous non-whitespace
 * character implies "start of an expression", never "end of a value"), not a real parser — a
 * genuinely ambiguous case (e.g. immediately after `++`/`--`) is not attempted.
 * @param {string} text
 * @returns {string}
 */
export function stripJsComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  function lastSignificantChar() {
    for (let j = out.length - 1; j >= 0; j--) {
      if (!/\s/.test(out[j])) return out[j];
    }
    return '';
  }

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') { out += text[i] === '\n' ? '\n' : ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i];
        i++;
      }
      if (i < n) { out += text[i]; i++; }
      continue;
    }
    if (c === '/' && REGEX_CONTEXT_CHARS.has(lastSignificantChar())) {
      // A regex literal: copy verbatim (backslash-escapes and `[...]` character classes both
      // suspend the "this slash closes it" rule) up to and including the closing `/`, plus any
      // trailing flags.
      out += c;
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n' && !(text[i] === '/' && !inClass)) {
        if (text[i] === '\\' && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        out += text[i];
        i++;
      }
      if (i < n && text[i] === '/') { out += text[i]; i++; }
      while (i < n && /[a-z]/i.test(text[i])) { out += text[i]; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blank out `#` line comments in a POSIX-sh file, preserving newlines. Simple by design: none
 * of this package's `.sh` tools currently reference a `tools/*.sh`/`.mjs` path at all (verified
 * by the sweep this file backs), so no shell-quoting edge case has ever needed handling here —
 * if one shows up, extend this rather than loosen the check.
 * @param {string} text
 * @returns {string}
 */
export function stripShComments(text) {
  return text.split('\n').map((line) => line.replace(/#.*$/, (m) => ' '.repeat(m.length))).join('\n');
}

// Carried finding from edition 2026-08-26.9, closed by the 2026-09-09.1 rename: this used to
// be `/tools\/[a-zA-Z0-9_-]+\.(sh|mjs)\b/`, keyed on the LITERAL directory prefix `tools/`, so a
// hint naming a script under any OTHER directory — `scripts/gen-index.mjs`, `en/scripts/tools/
// repository-state.sh`, the pre-rename `corp-sdd-npm/tools/...` — walked straight past it, and
// a rename is exactly the change that produces such paths. The prefix is now ANY directory
// chain, which is what makes this a path hint rather than a name.
//
// Deliberately still requires a slash: a bare basename in the package's own code is an internal
// reference (`join(TOOLS, 'repository-state.sh')`), not something a user is told to run, and
// banning it would ban the dispatcher itself. Relative-import prefixes (`./`, `../`) are
// excluded for the same reason — `import('../cli/verify-docs.mjs')` is module wiring.
// The basename list is the eleven executables the package owns — the only files an agent could
// be wrongly told to run by path. Keeping it explicit is what stops the check from flagging a
// citation of the package's own source (`src/cli/tools.mjs` in kit-version.sh's usage text).
const BAD_PATH_RE = /(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+(?:repository-state|check-git-naming|check-openspec-root|serpens-lint|corp-lint|gen-index|check-contract-split-brain|aggregate-index|sync-submodules|index-all|kit-version|verify-docs)\.(sh|mjs)\b/g;

/** True for a match whose directory chain is a relative-import prefix, not a hint path. */
function isRelativeImport(text, index) {
  const before = text.slice(Math.max(0, index - 3), index);
  return /(^|[^A-Za-z0-9_.-])\.{1,2}\/$/.test(before) || before.endsWith('../') || before.endsWith('./');
}

/**
 * Find every `tools/<name>.sh` or `tools/<name>.mjs` mention OUTSIDE a comment in `text` — i.e.
 * a mention a running program could actually print or throw to a user or agent, not one that
 * only exists to help a reader of the source.
 * @param {string} text
 * @param {'.mjs'|'.sh'} ext
 * @returns {string[]} the matched substrings, in order
 */
export function findUserFacingScriptPaths(text, ext) {
  const stripped = ext === '.sh' ? stripShComments(text) : stripJsComments(text);
  return [...stripped.matchAll(BAD_PATH_RE)]
    .filter((m) => !isRelativeImport(stripped, m.index))
    .map((m) => m[0]);
}

/**
 * Every `.mjs`/`.sh` file under one of this package's production-code roots — `bin/`, `src/`,
 * `tools/` — never `test/`, `node_modules/`, or the vendored `kits/` (kits are covered by
 * `starter-contract-test.sh` against the vault kit trees themselves, the actual source; scanning
 * the vendored copy too would just be the same check run twice against the same content).
 * @param {string} pkgRoot - the package root (one level above bin/src/tools)
 * @returns {string[]} absolute file paths
 */
export function productionCodeFiles(pkgRoot) {
  const roots = ['bin', 'src', 'tools'];
  const out = [];
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (extname(e.name) === '.mjs' || extname(e.name) === '.sh') out.push(p);
    }
  }
  for (const root of roots) walk(join(pkgRoot, root));
  return out.sort();
}

/**
 * Scan every production-code file under `pkgRoot` for a user-facing `tools/*.sh`/`.mjs`
 * mention. Returns one `{file, matches}` entry per offending file, else `[]`.
 * @param {string} pkgRoot
 * @returns {Array<{file: string, matches: string[]}>}
 */
export function scanPackageForScriptPathHints(pkgRoot) {
  const offenders = [];
  for (const file of productionCodeFiles(pkgRoot)) {
    const ext = extname(file);
    const text = readFileSync(file, 'utf8');
    const matches = findUserFacingScriptPaths(text, ext);
    if (matches.length > 0) offenders.push({ file, matches });
  }
  return offenders;
}
