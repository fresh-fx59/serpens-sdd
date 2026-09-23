import { join } from 'node:path';
// Editing `openspec/config.yaml` — a file OpenSpec owns and the user fills in.
//
// WHY THIS MODULE EXISTS. `openspec/config.yaml` is OpenSpec's per-project config. Verified
// against `@fission-ai/openspec@1.12.0`: its top-level keys are `schema` (required), `context`
// (free prose, ≤50KB, injected into every artifact instruction — what a user thinks of as their
// project context), `rules` (per-artifact), `operations`, `store`, an
// integration block for one hosted agent, and `references` (store ids whose specs this root draws on; `dist/core/references.js`). We need
// exactly one of those: `references`, so cross-repo fetch resolves and
// `check-contract-split-brain.mjs` has something to check.
//
// The previous implementation spliced strings, and it DESTROYED user data. Reproduced on a real
// repository whose `context:` prose merely contained the words "Cross-team references: see the
// platform handbook":
//
//     includes('references:')            -> true   (matched inside the prose)
//     findIndex(l => l.trim() === 'references:') -> -1  (no line IS that key)
//     lines.splice(-1 + 1, 0, ...)       -> inserted at index 0, the TOP of the file
//
// The result began with a sequence entry followed by a root mapping key, which is invalid YAML.
// The user's `schema`, their whole `context:` and their `rules:` became unreadable — and
// `openspec list` reported "No specs found" rather than an error, so the loss was SILENT.
//
// THE APPROACH. The package ships zero npm dependencies on purpose (restricted networks), so
// there is no YAML library to reach for. Writing a YAML parser to edit one key would be worse.
// Instead this scans BLOCK STRUCTURE only — enough to answer "which lines are top-level keys?"
// correctly — and it is built to REFUSE rather than guess:
//
//   * a line is only a top-level key if it starts at column 0 and is not inside a block scalar
//     (`|`, `|-`, `|+`, `>`, `>-`, `>+`), not a comment, and not a continuation;
//   * anything the scanner cannot classify confidently — tabs in indentation, more than one YAML
//     document, a top-level flow mapping, `references` in flow style — returns a refusal with a
//     reason, and the caller leaves the file alone;
//   * after writing, the result is CHECKED: removing exactly the lines we added must reproduce
//     the original text byte for byte. If it does not, the edit is discarded.
//
// A refusal is a good outcome. A mangled `openspec/config.yaml` costs a user their context pack
// silently; being told to add two lines by hand costs them a minute.

/**
 * Render a scalar so YAML reads back exactly what was passed in.
 *
 * Two real corruptions, both reproduced against OpenSpec 1.12's own parser, made this necessary:
 *   `remote: git@f:o/r.git #frag`  -> parsed as `git@f:o/r.git`. The fragment became a COMMENT
 *                                    and vanished. Silent.
 *   `remote: ssh://h: 22/r.git`    -> "Nested mappings are not allowed in compact mappings",
 *                                    so OpenSpec warned and IGNORED THE WHOLE CONFIG. A bad
 *                                    remote costs the user their `context:` and `rules:`.
 * Single-quoting is the safest YAML form: nothing inside it is an escape except `''` for a
 * literal quote, so there are no backslash rules to get wrong.
 * @param {string} v
 * @returns {string}
 */
function yamlScalar(v) {
  // Structural risk: an indicator that changes how the parser reads the line.
  const structural = /\s#|:\s|^\s|\s$|^[-?:,[\]{}&*!|>'"%`@]|\n|^$/.test(v);
  // Type risk: a plain scalar that YAML would COERCE to something other than a string. Caught by
  // the round-trip test, which is the whole reason it asserts the parsed value rather than the
  // bytes we wrote: a remote of `yes` came back as the boolean `true`. YAML 1.1's booleans are
  // generous, and a bare number or `null`/`~` has the same problem.
  const coerced = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/.test(v)
    || /^[+-]?(\d[\d_]*)(\.\d*)?([eE][+-]?\d+)?$/.test(v)
    || /^0[xXbBoO][0-9a-fA-F_]+$/.test(v)
    || /^[+-]?\.(inf|Inf|INF)$/.test(v) || /^\.(nan|NaN|NAN)$/.test(v);
  return structural || coerced ? `'${v.replace(/'/g, "''")}'` : v;
}

/** Strip one layer of matching YAML quotes from a scalar. */
function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  // Single quotes are the form `yamlScalar` writes, and inside them the only escape is `''`.
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Block-scalar openers: `key: |`, `key: >-`, `- |+`, with an optional indentation indicator. */
const BLOCK_SCALAR = /(^|[\s:-])[|>][+-]?[0-9]?\s*(#.*)?$/;
/** A top-level mapping key at column 0. YAML allows quoted keys; we only need plain ones. */
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(\s|$)/;

/**
 * Classify every line of a YAML document: its number, its text, and whether it is inside a
 * block scalar (and therefore opaque — user prose, not structure).
 * @param {string} text - already newline-normalized
 * @returns {Array<{n: number, raw: string, inScalar: boolean}>}
 */
function scanLines(text) {
  const out = [];
  let scalarIndent = null; // indentation of the key that opened the current block scalar
  text.split('\n').forEach((raw, i) => {
    const indent = raw.length - raw.replace(/^[ ]*/, '').length;
    const blank = raw.trim() === '';

    if (scalarIndent !== null) {
      // A block scalar continues through blank lines and any line indented MORE than its key.
      if (blank || indent > scalarIndent) {
        out.push({ n: i + 1, raw, inScalar: true });
        return;
      }
      scalarIndent = null; // dedent ends it; fall through and classify this line normally
    }

    out.push({ n: i + 1, raw, inScalar: false });
    if (!blank && !raw.trim().startsWith('#') && BLOCK_SCALAR.test(raw)) scalarIndent = indent;
  });
  return out;
}

/**
 * Everything the caller needs to know about a config before touching it, or a refusal.
 * @param {string} text
 * @returns {{ok: true, lines: Array, topLevelKeys: Array<{key: string, i: number}>, eol: string}
 *   | {ok: false, reason: string}}
 */
export function inspectConfig(text) {
  const crlf = /\r\n/.test(text);
  const normalized = text.replace(/\r\n?/g, '\n');

  if (/^\t| \t/m.test(normalized)) {
    return { ok: false, reason: 'the file indents with tabs, which YAML forbids — this tool will not guess at its structure' };
  }
  const docMarkers = normalized.split('\n').filter((l) => /^(---|\.\.\.)\s*$/.test(l)).length;
  if (docMarkers > 1) {
    return { ok: false, reason: `the file contains ${docMarkers} YAML document markers (--- / ...); this tool edits single-document configs only` };
  }
  const lines = scanLines(normalized);
  const firstReal = lines.find((l) => !l.inScalar && l.raw.trim() !== '' && !l.raw.trim().startsWith('#') && !/^---\s*$/.test(l.raw.trim()));
  if (firstReal && firstReal.raw.trim().startsWith('{')) {
    return { ok: false, reason: 'the document is a top-level flow mapping ({...}); this tool edits block-style configs only' };
  }

  const topLevelKeys = [];
  lines.forEach((l, i) => {
    if (l.inScalar) return;
    const m = TOP_LEVEL_KEY.exec(l.raw);
    if (m) topLevelKeys.push({ key: m[1], i });
  });
  return { ok: true, lines, topLevelKeys, eol: crlf ? '\r\n' : '\n' };
}

/**
 * The top-level keys a config declares — the honest answer to "what has the user already set?",
 * with `references:` inside a `context: |` block correctly NOT counted.
 * @param {string} text
 * @returns {string[]}
 */
export function topLevelKeys(text) {
  const r = inspectConfig(text);
  return r.ok ? r.topLevelKeys.map((k) => k.key) : [];
}

/**
 * The store ids already listed under a top-level `references:` key.
 *
 * BOTH entry shapes OpenSpec accepts are read, because a user's existing config may use either
 * and a missed entry means we append a duplicate. Verbatim from `dist/core/project-config.js`:
 * *"the `references` field (id strings or {id, remote} maps) is deliberately absent here —
 * readProjectConfig parses and normalizes it by hand"*. So:
 *
 *     references:
 *       - mystore                  <- plain string
 *       - id: other                <- mapping
 *         remote: git@forge:o/r.git
 * @param {string} text
 * @returns {string[]}
 */
export function declaredReferenceIds(text) {
  return declaredReferences(text).map((e) => e.id);
}

/** The indentation of a line, in spaces (tabs are already refused by `inspectConfig`). */
function indentOf(raw) {
  return raw.length - raw.replace(/^[ ]*/, '').length;
}

/**
 * The lines that are ENTRIES of the top-level `references:` block, and where that block ends.
 *
 * ANCHORED TO THE BLOCK'S OWN INDENTATION, which is the whole point. An earlier version simply
 * walked forward accepting any line that began with whitespace, so a nested sequence living
 * INSIDE an entry —
 *
 *     references:
 *       - id: alpha
 *         remote: ssh://git@forge/o/r.git
 *         notes:
 *           - old-store        <- not a reference; a note
 *
 * — was read as a reference entry, and `renameStoreReference` rewrote it. That is the same class
 * of bug as the string splicing this module was written to end: it changed a line it had no
 * business touching. Entries are the lines at the block's own indentation that open a sequence
 * item; anything deeper belongs to an entry, and the first line that dedents out of the block
 * ends it.
 * @param {Array<{n: number, raw: string, inScalar: boolean}>} lines
 * @param {{key: string, i: number}} at - the `references:` key
 * @returns {{entries: number[], end: number}} indices of entry lines; `end` is exclusive
 */
function referenceBlock(lines, at) {
  const entries = [];
  let blockIndent = null;
  let end = lines.length;
  for (let i = at.i + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.inScalar) continue;
    const t = l.raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (!/^\s/.test(l.raw)) { end = i; break; } // dedented to column 0: the block ended
    const indent = indentOf(l.raw);
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) { end = i; break; } // dedented out of the references block
    if (indent > blockIndent) continue; // content that belongs to the entry above it
    if (/^-(\s|$)/.test(t)) entries.push(i);
  }
  return { entries, end };
}

/**
 * Every entry under the top-level `references:` key, as `{id, remote}`.
 *
 * `remote` is the one fact that says an entry is OURS rather than a store the user declared by
 * hand, which is what lets a re-run finish an adoption it can no longer name (see
 * `src/storeregistry.mjs`). It is `undefined` for the plain-string form, which carries no remote.
 * @param {string} text
 * @returns {Array<{id: string, remote?: string}>}
 */
export function declaredReferences(text) {
  const r = inspectConfig(text);
  if (!r.ok) return [];
  const at = r.topLevelKeys.find((k) => k.key === 'references');
  if (!at) return [];
  const { entries, end } = referenceBlock(r.lines, at);
  const out = [];
  entries.forEach((i, k) => {
    const id = entryId(r.lines[i].raw);
    if (id === null) return;
    const stop = k + 1 < entries.length ? entries[k + 1] : end;
    let remote;
    for (let j = i + 1; j < stop; j += 1) {
      if (r.lines[j].inScalar) continue;
      const m = /^\s*remote:\s*(.+?)\s*$/.exec(r.lines[j].raw);
      if (m) remote = unquote(m[1].replace(/\s+#.*$/, ''));
    }
    out.push(remote === undefined ? { id } : { id, remote });
  });
  return out;
}

/**
 * The store id an entry line declares, in either shape OpenSpec accepts, or `null`.
 * @param {string} raw
 * @returns {string|null}
 */
function entryId(raw) {
  const mapping = /^\s*-\s*id:\s*(\S+)/.exec(raw);
  if (mapping) return unquote(mapping[1]);
  // The plain-string form: `- mystore`, but not `- key: value` (a mapping entry whose first key
  // happens not to be `id`) and not a comment.
  const plain = /^\s*-\s+(?!#)([^:#]+?)\s*$/.exec(raw);
  return plain ? unquote(plain[1].trim()) : null;
}

/**
 * Declare a store in a spoke's `openspec/config.yaml` under the top-level `references:` key,
 * without disturbing one byte the user wrote.
 *
 * Returns a discriminated result rather than throwing, because "refused, and here is why" is a
 * legitimate and frequently-correct outcome the installer must be able to report:
 *   { action: 'unchanged' }  the exact id is already declared
 *   { action: 'appended' }   a `references:` block was added at the end
 *   { action: 'inserted' }   an entry was added under the existing `references:` key
 *   { action: 'refused', reason, manual }  nothing was written; `manual` is what to add by hand
 * @param {string} existingText
 * @param {string} storeId
 * @param {string} storeRemote
 * @returns {{action: string, text?: string, reason?: string, manual?: string}}
 */
export function declareStoreReference(existingText, storeId, storeRemote) {
  const manual = `references:\n  - id: ${yamlScalar(storeId)}\n    remote: ${yamlScalar(storeRemote)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(storeId)) {
    return { action: 'refused', reason: `store id "${storeId}" is not a plain scalar; it would need YAML quoting this tool does not do`, manual };
  }
  if (/[\n\r]/.test(storeRemote)) {
    return { action: 'refused', reason: 'the store remote contains a newline', manual };
  }
  const remoteScalar = yamlScalar(storeRemote);

  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'refused', reason: r.reason, manual };

  const { lines, eol } = r;
  const at = r.topLevelKeys.find((k) => k.key === 'references');

  // Already declared? Idempotent, and decided on the PARSED ids — never on a substring match,
  // which is the mistake that started all this.
  if (at && declaredReferenceIds(existingText).includes(storeId)) {
    return { action: 'unchanged', text: existingText };
  }

  // The id goes through `yamlScalar` for the same reason the remote does: a plain-looking id
  // like `no` or `null` is a YAML 1.1 boolean/null, and upstream drops the entry.
  const added = [`  - id: ${yamlScalar(storeId)}`, `    remote: ${remoteScalar}`];
  let outLines;
  let action;

  if (!at) {
    // No `references:` key: add one at the end. Appending at column 0 also correctly terminates
    // a block scalar the file may end inside, so a `context: |` that runs to EOF stays intact.
    const body = lines.map((l) => l.raw);
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    outLines = [...body, 'references:', ...added];
    action = 'appended';
  } else {
    if (/^references:\s*[[{]/.test(lines[at.i].raw.trim())) {
      return { action: 'refused', reason: 'the existing `references:` is in flow style ([...]); this tool edits block sequences only', manual };
    }
    // Insert after the last line that belongs to the references block, so entries keep their
    // order and any trailing comment inside the block stays inside it.
    let last = at.i;
    for (let i = at.i + 1; i < lines.length; i += 1) {
      const l = lines[i];
      if (l.raw.trim() === '') continue;
      if (!l.inScalar && !/^\s/.test(l.raw)) break;
      last = i;
    }
    outLines = lines.map((l) => l.raw);
    outLines.splice(last + 1, 0, ...added);
    action = 'inserted';
  }

  const text = outLines.join(eol) + (outLines[outLines.length - 1] === '' ? '' : eol);

  // THE SELF-CHECK. Remove exactly the lines we claim to have added; what remains must be the
  // original, byte for byte (modulo the trailing newline we may have added). Anything else means
  // the edit moved something it had no business moving — so discard it and refuse.
  const check = verifyOnlyAdded(existingText, text, action === 'appended' ? ['references:', ...added] : added, eol);
  if (!check.ok) {
    return { action: 'refused', reason: `the edit did not verify (${check.reason}) — the file was left untouched`, manual };
  }
  return { action, text };
}

/**
 * Prove an edit only ADDED the given lines: delete the added lines from the result and require
 * what remains to equal the original, byte for byte.
 *
 * Two modes. Without `atIndex`, each added line is found by its first occurrence anywhere in the
 * result and removed — the mode every append (end-of-file) call site uses, where "somewhere in
 * the result" is unambiguous because nothing else in the file could produce that exact line.
 * With `atIndex`, the added lines must appear CONTIGUOUSLY at that exact position — required for
 * a MID-FILE insertion (gap 5's per-artifact `rules:` entries), where an append-anywhere check
 * would wrongly accept an edit that inserted the right lines in the wrong place, or that matched
 * one of them against an unrelated line the user already had.
 * @param {string} before
 * @param {string} after
 * @param {string[]} addedLines
 * @param {string} eol
 * @param {number} [atIndex] - 0-based line index the added lines must occupy in `after`
 * @returns {{ok: boolean, reason?: string}}
 */
/**
 * The inverse check for a removal (step 7, gap 6 — `serpens-sdd uninstall`): prove an edit only
 * REMOVED the given lines, at a known position. It is literally `verifyOnlyAdded` with `before`
 * and `after` swapped — "removing `removedLines` from `before` yields `after`" is the same claim
 * as "adding `removedLines` to `after` yields `before`" — so this reuses that (already tested)
 * logic rather than re-implementing it.
 * @param {string} before - the text as it stood before the removal
 * @param {string} after - the text uninstall is about to write
 * @param {string[]} removedLines
 * @param {string} eol
 * @param {number} [atIndex] - 0-based line index the removed lines occupied in `before`
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyOnlyRemoved(before, after, removedLines, eol, atIndex) {
  return verifyOnlyAdded(after, before, removedLines, eol, atIndex);
}

export function verifyOnlyAdded(before, after, addedLines, eol, atIndex) {
  const norm = (s) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const remaining = after.replace(/\r\n?/g, '\n').split('\n');
  if (atIndex !== undefined) {
    for (let k = 0; k < addedLines.length; k += 1) {
      if (remaining[atIndex + k] !== addedLines[k]) {
        return { ok: false, reason: `expected "${addedLines[k]}" at line ${atIndex + k + 1}, found something else` };
      }
    }
    remaining.splice(atIndex, addedLines.length);
  } else {
    for (const line of addedLines) {
      const i = remaining.indexOf(line);
      if (i === -1) return { ok: false, reason: `the line "${line}" is not in the result` };
      remaining.splice(i, 1);
    }
  }
  if (norm(remaining.join('\n')) !== norm(before)) {
    return { ok: false, reason: 'the surrounding content changed' };
  }
  void eol;
  return { ok: true };
}

/**
 * The config file OpenSpec would actually READ in this repository, and therefore the one we must
 * edit. Mirrors `resolveConfigFilePath` in OpenSpec 1.12's `dist/core/project-config.js`:
 * `openspec/config.yaml` wins if it exists, otherwise `openspec/config.yml`.
 *
 * This is not a detail. We only ever looked at `config.yaml`, so a repository whose real config
 * is `openspec/config.yml` — a perfectly legal OpenSpec setup — got a BRAND NEW `config.yaml`
 * from us containing nothing but `references:`. Because `.yaml` takes precedence, that shadowed
 * their entire config: their `schema`, their `context:` pack and their `rules:` all became
 * invisible to OpenSpec, with no error anywhere. The same silent loss as the splicing bug, by a
 * different route.
 * @param {string} repoRoot
 * @param {(p: string) => boolean} exists - injected so this is testable without a filesystem
 * @returns {{path: string, existed: boolean}}
 */
export function resolveConfigPath(repoRoot, exists) {
  const yamlPath = join(repoRoot, 'openspec', 'config.yaml');
  const ymlPath = join(repoRoot, 'openspec', 'config.yml');
  if (exists(yamlPath)) return { path: yamlPath, existed: true };
  if (exists(ymlPath)) return { path: ymlPath, existed: true };
  return { path: yamlPath, existed: false };
}

/**
 * Rewrite an already-declared store id under the top-level `references:` key — the other half of
 * id adoption.
 *
 * WHY THIS EXISTS. When the store's committed `.openspec-store/store.yaml` names an id our
 * config does not, upstream (`dist/core/store/operations.js:487-497`) refuses the registration
 * outright rather than letting the committed id win, so we adopt the committed id BEFORE
 * registering. Adoption that stops at our own config is worse than no adoption: a spoke whose
 * `references:` entry still names the old id resolves to `unknown_store` — or, worse, to a
 * DIFFERENT registered store that happens to hold that id (`dist/core/root-selection.js`). So
 * every entry naming the old id is rewritten in the same pass, or the run fails.
 *
 * Both entry shapes `declaredReferenceIds` reads are rewritten: `- id: <old>` and the plain
 * `- <old>`. Only the id token on those lines changes; the self-check below proves it.
 *
 *   { action: 'unchanged' }              the old id is not declared here — nothing to do
 *   { action: 'renamed', text, count }   `count` entries now name `newId`
 *   { action: 'refused', reason, manual } nothing was written
 * @param {string} existingText
 * @param {string} oldId
 * @param {string} newId
 * @returns {{action: string, text?: string, count?: number, reason?: string, manual?: string}}
 */
export function renameStoreReference(existingText, oldId, newId) {
  const manual = `change the references: entry "${oldId}" to "${newId}" by hand`;
  if (!/^[A-Za-z0-9._-]+$/.test(newId)) {
    return { action: 'refused', reason: `store id "${newId}" is not a plain scalar; it would need YAML quoting this tool does not do`, manual };
  }
  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'refused', reason: r.reason, manual };

  const at = r.topLevelKeys.find((k) => k.key === 'references');
  if (!at) return { action: 'unchanged', text: existingText };
  if (/^references:\s*[[{]/.test(r.lines[at.i].raw.trim())) {
    return { action: 'refused', reason: 'the existing `references:` is in flow style ([...]); this tool edits block sequences only', manual };
  }

  const outLines = r.lines.map((l) => l.raw);
  const rewritten = [];
  // The replacement token goes through the SAME quoting rule every other value this module
  // writes goes through. An id is a plain scalar by the guard above, but plain is not safe: YAML
  // 1.1 reads `no`, `off`, `null` and friends as booleans/null, so an unquoted rewrite to one of
  // those silently turns the reference into `false` and the entry is dropped upstream — the
  // exact failure `yamlScalar` already exists to prevent for remotes.
  const newToken = yamlScalar(newId);
  const { entries } = referenceBlock(r.lines, at);
  for (const i of entries) {
    const raw = r.lines[i].raw;
    const mapping = /^(\s*-\s*id:\s*)(\S+)(\s*)$/.exec(raw);
    if (mapping && unquote(mapping[2]) === oldId) {
      outLines[i] = `${mapping[1]}${newToken}${mapping[3]}`;
      rewritten.push({ i, prefix: mapping[1], token: mapping[2], suffix: mapping[3] });
      continue;
    }
    const plain = /^(\s*-\s+)(?!#)([^:#]+?)(\s*)$/.exec(raw);
    if (plain && unquote(plain[2].trim()) === oldId) {
      outLines[i] = `${plain[1]}${newToken}${plain[3]}`;
      rewritten.push({ i, prefix: plain[1], token: plain[2], suffix: plain[3] });
    }
  }
  if (rewritten.length === 0) return { action: 'unchanged', text: existingText };

  // THE SELF-CHECK. Every line except the ones we claim to have rewritten must be byte-identical
  // to the original, and each rewritten line must be its original with ONLY the id token
  // replaced — proven by rebuilding the original from the same three pieces the new line was
  // built from, so a regex that failed to cover the whole line is caught here.
  const before = r.lines.map((l) => l.raw);
  const changedAt = new Map(rewritten.map((w) => [w.i, w]));
  for (let i = 0; i < before.length; i += 1) {
    const w = changedAt.get(i);
    if (!w && outLines[i] !== before[i]) {
      return { action: 'refused', reason: `the edit changed line ${i + 1}, which it had no business touching — the file was left untouched`, manual };
    }
    if (w && (`${w.prefix}${w.token}${w.suffix}` !== before[i] || outLines[i] !== `${w.prefix}${newToken}${w.suffix}`)) {
      return { action: 'refused', reason: `the rewrite of line ${i + 1} changed more than the store id — the file was left untouched`, manual };
    }
  }
  if (outLines.length !== before.length) {
    return { action: 'refused', reason: 'the edit changed the line count — the file was left untouched', manual };
  }

  const text = outLines.join(r.eol) + (outLines[outLines.length - 1] === '' ? '' : r.eol);
  return { action: 'renamed', text, count: rewritten.length };
}

// ---------------------------------------------------------------------------
// The context catalog and the per-artifact rules.
//
// WHY. `references:` is not the only slot OpenSpec injects. `openspec instructions <artifact>`
// pastes `context:` into EVERY artifact instruction, and `rules[<artifactId>]` into that one
// artifact's instruction (verified against 1.13.1: dist/core/artifact-graph/instruction-loader.js
// :148-152, printed by dist/commands/workflow/instructions.js:136-156 inside <project_context>
// and <rules>). Until now we wrote neither, so every instructions call we made came back with
// `context: undefined, rules: undefined` — a slot upstream hands us for free, left empty.
//
// WHAT GOES IN, AND WHAT DOES NOT. This kit's facts live in files, and they stay there. What
// `context:` gets is a CATALOG: one line per fact file saying what question that file answers,
// so the agent can choose. It is deliberately NOT an instruction to read them all — the file
// count grows as a shop adds facts, and "read these files" would make every artifact pay for
// every file. The catalog costs about one line per file, forever.
//
// The ORDER to read something lives in `rules:`, keyed by artifact, because the stages need
// different facts: `tasks` cannot list a test step without the testing stack, `proposal` needs
// none of it. That split is the whole point — the catalog lets the agent choose, the rules make
// the choice mandatory exactly where getting it wrong is expensive.
//
// WE NEVER OVERWRITE EITHER KEY. In a brownfield repository `context:` holds the user's own
// prose (up to 50KB, their whole project pack) and `rules:` their own per-artifact constraints.
// Both are theirs. If the key exists we report `unchanged` with the text to merge by hand —
// the same stance the rest of this module takes, and the same one upstream's own init takes
// (dist/core/init.js:806-809 does not clobber an existing config).

/**
 * Render the catalog block body — the lines that go under `context: |`.
 *
 * `entries` is data, not prose, so adding a fact file to the kit is one array element and the
 * wording stays identical across every installed repository (and, once localized, across
 * languages).
 * @param {Array<{path: string, answers: string}>} entries
 * @param {{preamble?: string, closing?: string}} [words] - overridable for localization
 * @returns {string[]} body lines, unindented
 */
export function renderContextCatalog(entries, words = {}) {
  const preamble = words.preamble
    ?? "This repository's facts live in files, not in your memory. Never guess a framework, transport, store or branch name — look it up.";
  const closing = words.closing
    ?? 'Open only what the current step needs.';
  const width = entries.reduce((w, e) => Math.max(w, e.path.length), 0);
  return [
    preamble,
    ...entries.map((e) => `  ${e.path.padEnd(width)}  — ${e.answers}`),
    closing,
  ];
}

/**
 * Add a `context:` block scalar holding the catalog, or leave a user's `context:` alone.
 *
 * Returns the same discriminated shape as `declareStoreReference`:
 *   { action: 'appended', text }            a `context: |` block was added at the end
 *   { action: 'unchanged', text, reason }   the user already has a `context:` — theirs wins
 *   { action: 'refused', reason, manual }   nothing was written
 * @param {string} existingText
 * @param {Array<{path: string, answers: string}>} entries
 * @param {{preamble?: string, closing?: string}} [words]
 * @returns {{action: string, text?: string, reason?: string, manual?: string}}
 */
export function declareContextCatalog(existingText, entries, words = {}) {
  const body = renderContextCatalog(entries, words);
  const manual = ['context: |', ...body.map((l) => `  ${l}`)].join('\n');

  if (!entries.length) {
    return { action: 'refused', reason: 'the catalog is empty; there is nothing to declare', manual };
  }
  const bad = entries.find((e) => /[\n\r]/.test(e.path) || /[\n\r]/.test(e.answers));
  if (bad) {
    return { action: 'refused', reason: `the catalog entry for "${bad.path}" contains a newline`, manual };
  }

  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'refused', reason: r.reason, manual };

  if (r.topLevelKeys.some((k) => k.key === 'context')) {
    return {
      action: 'unchanged',
      text: existingText,
      reason: 'this config already has a `context:` — it belongs to the user and is never rewritten',
      manual,
    };
  }

  const { lines, eol } = r;
  // Column 0 terminates any block scalar the file may end inside, exactly as the `references:`
  // path relies on — a `context: |`-shaped trap cannot exist here (we just proved there is no
  // `context:`), but a `rules:` or `operations:` block scalar can.
  const added = ['context: |', ...body.map((l) => `  ${l}`)];
  const kept = lines.map((l) => l.raw);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const outLines = [...kept, ...added];
  const text = outLines.join(eol) + eol;

  const check = verifyOnlyAdded(existingText, text, added, eol);
  if (!check.ok) {
    return { action: 'refused', reason: `the edit did not verify (${check.reason}) — the file was left untouched`, manual };
  }
  return { action: 'appended', text };
}

/**
 * The artifact-id entries of a top-level `rules:` block, and where the block ends.
 *
 * Mirrors `referenceBlock` exactly: entries are the lines at the block's OWN indentation that
 * open a mapping key (`  <id>:`), anchored to that indentation rather than "any indented line",
 * so a nested list under one id's rules (`  tasks:\n    - a rule`) is never mistaken for a
 * sibling id. The first entry line's indent becomes `blockIndent`, reported back so the caller
 * can refuse a block that does not use two spaces — inserting a two-space entry into a
 * four-space block would parse, but it would look like a mistake to the next human who reads it,
 * and disagreeing with the block's own convention is a footgun this tool does not need to add.
 * @param {Array<{n: number, raw: string, inScalar: boolean}>} lines
 * @param {{key: string, i: number}} at - the `rules:` key
 * @returns {{ids: string[], end: number, blockIndent: number|null}}
 */
function rulesBlock(lines, at) {
  const ids = [];
  let blockIndent = null;
  let end = lines.length;
  // Trailing blank/comment lines inside the block must NOT push `end` past the block's last
  // real content — an insertion at literal `lines.length` would land after a trailing blank
  // line at EOF (every file this tool reads ends in one), visibly separated from the block by
  // an extra empty line. `lastContent` tracks the last line that belongs to the block; `end`
  // resolves to one past it unless a dedent (to a sibling key or column 0) is found first.
  let lastContent = at.i;
  for (let i = at.i + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.inScalar) { lastContent = i; continue; }
    const t = l.raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (!/^\s/.test(l.raw)) { end = i; break; } // dedented to column 0: the block ended
    const indent = indentOf(l.raw);
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) { end = i; break; } // dedented out of the rules block
    lastContent = i;
    if (indent > blockIndent) continue; // content that belongs to the id above it (its rule list)
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(\s|$)/.exec(t);
    if (m) ids.push(m[1]);
  }
  if (end === lines.length) end = lastContent + 1;
  return { ids, end, blockIndent };
}

/**
 * Add a `rules:` mapping of artifact id → constraint strings, or, when a `rules:` already
 * exists, insert only the ids the user has NOT declared — gap 5. Upstream looks rules up per
 * artifact id (`instruction-loader.ts:382`: `Object.hasOwn(projectConfig.rules, artifactId)`), so
 * an id we add cannot override anything of the user's: it is either absent (safe to add) or
 * already theirs (left alone).
 *
 * The value shape is upstream's: `Record<artifactId, string[]>` (dist/core/project-config.js
 * :35-41). Artifact ids are whatever the resolved schema declares — `spec-driven` ships
 * `proposal`, `specs`, `design`, `tasks` — so the caller passes them; this module does not
 * assume a schema, because a project-local schema may name them differently.
 *
 * Returns the same discriminated shape as `declareStoreReference`, plus `perId` — the caller's
 * only way to report which ids were added and which were the user's already, since a single
 * `action` can no longer say that for a mixed request:
 *   { action: 'appended', text, perId }    no `rules:` existed; the whole block was added
 *   { action: 'inserted', text, perId }    `rules:` existed; ids missing from it were inserted
 *   { action: 'unchanged', text, perId? }  every requested id was already declared, or (no
 *                                          `rules:` case is impossible to reach unchanged)
 *   { action: 'refused', reason, manual }  nothing was written
 * @param {string} existingText
 * @param {Record<string, string[]>} rulesByArtifact
 * @returns {{action: string, text?: string, reason?: string, manual?: string, perId?: Record<string, string>}}
 */
export function declareArtifactRules(existingText, rulesByArtifact) {
  const ids = Object.keys(rulesByArtifact);
  const added = ['rules:'];
  for (const id of ids) {
    added.push(`  ${id}:`);
    for (const rule of rulesByArtifact[id]) added.push(`    - ${yamlScalar(rule)}`);
  }
  const manual = added.join('\n');

  if (!ids.length) {
    return { action: 'refused', reason: 'no rules were given; there is nothing to declare', manual };
  }
  const badId = ids.find((id) => !/^[A-Za-z0-9._-]+$/.test(id));
  if (badId) {
    return { action: 'refused', reason: `artifact id "${badId}" is not a plain scalar; it would need YAML quoting this tool does not do`, manual };
  }
  const emptyId = ids.find((id) => !Array.isArray(rulesByArtifact[id]) || rulesByArtifact[id].length === 0);
  if (emptyId) {
    return { action: 'refused', reason: `artifact "${emptyId}" has no rules; an empty list would say nothing`, manual };
  }

  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'refused', reason: r.reason, manual };

  const at = r.topLevelKeys.find((k) => k.key === 'rules');

  if (at) {
    const opener = r.lines[at.i].raw.trim();
    if (/^rules:\s*[[{]/.test(opener)) {
      return { action: 'refused', reason: 'the existing `rules:` is in flow style ({...}); this tool edits block mappings only', manual };
    }
    if (BLOCK_SCALAR.test(r.lines[at.i].raw)) {
      return { action: 'refused', reason: 'the existing `rules:` opens a block scalar (|, >, …); this tool edits block mappings only', manual };
    }
    if (/^rules:\s+\S/.test(opener)) {
      return { action: 'refused', reason: 'the existing `rules:` is a plain scalar; this tool edits block mappings only', manual };
    }

    const block = rulesBlock(r.lines, at);
    if (block.blockIndent !== null && block.blockIndent !== 2) {
      return { action: 'refused', reason: `the existing rules: block indents its ids ${block.blockIndent} spaces, not two; this tool inserts at two spaces only`, manual };
    }

    const existingIds = new Set(block.ids);
    const perId = {};
    const insertLines = [];
    for (const id of ids) {
      if (existingIds.has(id)) { perId[id] = 'unchanged'; continue; }
      insertLines.push(`  ${id}:`);
      for (const rule of rulesByArtifact[id]) insertLines.push(`    - ${yamlScalar(rule)}`);
      perId[id] = 'inserted';
    }

    if (!insertLines.length) {
      return {
        action: 'unchanged',
        text: existingText,
        reason: 'this config already declares every requested artifact id under `rules:` — not rewritten',
        manual,
        perId,
      };
    }

    const outLines = r.lines.map((l) => l.raw);
    outLines.splice(block.end, 0, ...insertLines);
    const text = outLines.join(r.eol) + (outLines[outLines.length - 1] === '' ? '' : r.eol);

    const check = verifyOnlyAdded(existingText, text, insertLines, r.eol, block.end);
    if (!check.ok) {
      return { action: 'refused', reason: `the edit did not verify (${check.reason}) — the file was left untouched`, manual };
    }
    return { action: 'inserted', text, perId };
  }

  const { lines, eol } = r;
  const kept = lines.map((l) => l.raw);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const outLines = [...kept, ...added];
  const text = outLines.join(eol) + eol;

  const check = verifyOnlyAdded(existingText, text, added, eol);
  if (!check.ok) {
    return { action: 'refused', reason: `the edit did not verify (${check.reason}) — the file was left untouched`, manual };
  }
  return { action: 'appended', text, perId: Object.fromEntries(ids.map((id) => [id, 'appended'])) };
}

// ---------------------------------------------------------------------------
// step 7 (gap 6, spec-openspec-coexistence-2026-09-22.md) — `serpens-sdd uninstall`'s reverses of
// the three edits above. Each removal is an OWNER CHECK first: the exact bytes we would have
// written must still be there, at the position we would have written them, or nothing is
// touched and the caller is told to edit the file by hand.

/**
 * Remove our `references:` entry (id + remote), added by `declareStoreReference`, if — and only
 * if — an entry naming exactly this id and remote is present. The `references:` key itself is
 * left in place even if this was its only entry: whether the key existed before us is not
 * something this module can prove, so removing it could delete a user's own (now-empty) key.
 * @param {string} existingText
 * @param {string} storeId
 * @param {string} storeRemote
 * @returns {{action: 'removed'|'unchanged', text: string}}
 */
export function removeStoreReference(existingText, storeId, storeRemote) {
  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'unchanged', text: existingText };
  const at = r.topLevelKeys.find((k) => k.key === 'references');
  if (!at) return { action: 'unchanged', text: existingText };
  const { entries, end } = referenceBlock(r.lines, at);
  for (const i of entries) {
    if (entryId(r.lines[i].raw) !== storeId) continue;
    // Find this entry's own extent (up to the next entry or the block end) and require it to
    // be EXACTLY `- id: <id>` followed by `remote: <remote>` and nothing else — the shape
    // `declareStoreReference` writes. Anything richer (a user's own entry that happens to share
    // our id) is left untouched.
    const idxInEntries = entries.indexOf(i);
    const stop = idxInEntries + 1 < entries.length ? entries[idxInEntries + 1] : end;
    const body = [];
    for (let j = i; j < stop; j += 1) {
      if (r.lines[j].inScalar) { body.push(r.lines[j]); continue; }
      const t = r.lines[j].raw.trim();
      if (t === '' || t.startsWith('#')) continue;
      body.push(r.lines[j]);
    }
    if (body.length !== 2) continue;
    const idLine = /^\s*-\s*id:\s*(\S+)\s*$/.exec(body[0].raw);
    const remoteLine = /^\s*remote:\s*(.+?)\s*$/.exec(body[1].raw);
    if (!idLine || !remoteLine || unquote(idLine[1]) !== storeId || unquote(remoteLine[1]) !== storeRemote) continue;

    const outLines = r.lines.map((l) => l.raw);
    outLines.splice(i, stop - i);
    const text = outLines.join(r.eol) + (outLines[outLines.length - 1] === '' ? '' : r.eol);
    const removed = [body[0].raw, body[1].raw];
    const check = verifyOnlyRemoved(existingText, text, removed, r.eol, i);
    if (!check.ok) return { action: 'unchanged', text: existingText };
    return { action: 'removed', text };
  }
  return { action: 'unchanged', text: existingText };
}

/**
 * Remove the `context: |` catalog block `declareContextCatalog` appended — only when the whole
 * block, verbatim, is still at the position it was written (the file's own end, since that
 * function only ever appends). A user's own `context:` (the `unchanged` case at install time)
 * was never touched by us and is never touched here either.
 * @param {string} existingText
 * @param {Array<{path: string, answers: string}>} entries
 * @param {{preamble?: string, closing?: string}} [words]
 * @returns {{action: 'removed'|'unchanged', text: string}}
 */
export function removeContextCatalog(existingText, entries, words = {}) {
  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'unchanged', text: existingText };
  const at = r.topLevelKeys.find((k) => k.key === 'context');
  if (!at) return { action: 'unchanged', text: existingText };

  const body = renderContextCatalog(entries, words);
  const added = ['context: |', ...body.map((l) => `  ${l}`)];

  // The block's own extent: `context: |` opens a block scalar, and `scanLines` already marks
  // every line that belongs to it (`inScalar: true`) — that run, not "the rest of the file", is
  // what `declareContextCatalog` wrote and what must be removed. This was a real bug: when
  // `rules:` is appended AFTER `context:` (the normal onboarding order), the catalog is no
  // longer the file's tail, and a tail-anchored check silently found nothing to remove.
  let blockEnd = at.i + 1;
  while (blockEnd < r.lines.length && r.lines[blockEnd].inScalar) blockEnd += 1;
  const span = r.lines.slice(at.i, blockEnd).map((l) => l.raw);
  if (span.length !== added.length || !span.every((line, k) => line === added[k])) {
    return { action: 'unchanged', text: existingText };
  }

  const outLines = r.lines.map((l) => l.raw);
  outLines.splice(at.i, blockEnd - at.i);
  const text = outLines.join(r.eol) + (outLines[outLines.length - 1] === '' ? '' : r.eol);

  const check = verifyOnlyRemoved(existingText, text, added, r.eol, at.i);
  if (!check.ok) return { action: 'unchanged', text: existingText };
  return { action: 'removed', text };
}

/**
 * Remove exactly the artifact ids `declareArtifactRules` inserted or appended, leaving every id
 * the user declared themselves untouched — the inverse of gap 5's insertion. Per id: the id's
 * whole mapping value (its `  <id>:` line and every `    - rule` line under it) must equal, byte
 * for byte, what `declareArtifactRules` would have rendered for that id, or it is left alone
 * (the id is the user's, or was hand-edited since). If every id we recognise as ours is removed
 * and no id is left in the block, the `rules:` key itself is removed too — that is only correct
 * when the whole key was ours (the `appended` case at install time), so it is additionally
 * gated on the key having contained NOTHING but our own ids.
 * @param {string} existingText
 * @param {Record<string, string[]>} rulesByArtifact
 * @returns {{action: 'removed'|'unchanged', text: string, removedIds: string[]}}
 */
export function removeArtifactRules(existingText, rulesByArtifact) {
  const r = inspectConfig(existingText);
  if (!r.ok) return { action: 'unchanged', text: existingText, removedIds: [] };
  const at = r.topLevelKeys.find((k) => k.key === 'rules');
  if (!at) return { action: 'unchanged', text: existingText, removedIds: [] };

  // Per-id ranges within the block, anchored to the block's own indentation exactly like
  // `rulesBlock`, but this time capturing where each id's OWN mapping value starts and ends.
  const ranges = []; // {id, start, end}
  let blockIndent = null;
  let blockEnd = r.lines.length;
  let cur = null;
  for (let i = at.i + 1; i < r.lines.length; i += 1) {
    const l = r.lines[i];
    if (l.inScalar) continue;
    const t = l.raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (!/^\s/.test(l.raw)) { blockEnd = i; break; }
    const indent = indentOf(l.raw);
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) { blockEnd = i; break; }
    if (indent === blockIndent) {
      const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(\s|$)/.exec(t);
      if (m) {
        if (cur) cur.end = i;
        cur = { id: m[1], start: i, end: r.lines.length };
        ranges.push(cur);
      }
    }
  }
  if (cur) cur.end = blockEnd;

  const idsPresent = new Set(ranges.map((rg) => rg.id));
  const removable = [];
  for (const [id, rules] of Object.entries(rulesByArtifact)) {
    if (!idsPresent.has(id)) continue;
    const rg = ranges.find((x) => x.id === id);
    const expected = [`  ${id}:`, ...rules.map((rule) => `    - ${yamlScalar(rule)}`)];
    const actual = [];
    for (let i = rg.start; i < rg.end; i += 1) {
      if (r.lines[i].inScalar) { actual.push(r.lines[i].raw); continue; }
      const t = r.lines[i].raw.trim();
      if (t === '' || t.startsWith('#')) continue;
      actual.push(r.lines[i].raw);
    }
    if (actual.length === expected.length && actual.every((line, k) => line === expected[k])) {
      removable.push({ id, start: rg.start, end: rg.end, lines: expected });
    }
  }
  if (removable.length === 0) return { action: 'unchanged', text: existingText, removedIds: [] };

  // Whole-key removal only when EVERY id in the block is one we are removing.
  const wholeKey = removable.length === ranges.length;

  const outLines = r.lines.map((l) => l.raw);
  let removedFlat = [];
  // Splice from the end so earlier indices stay valid.
  for (const rg of [...removable].sort((a, b) => b.start - a.start)) {
    outLines.splice(rg.start, rg.end - rg.start);
  }
  removedFlat = removable.flatMap((rg) => rg.lines);
  let atIndexForCheck = removable[0].start;
  if (wholeKey) {
    outLines.splice(at.i, 1); // the `rules:` line itself
    removedFlat = ['rules:', ...removedFlat];
    atIndexForCheck = at.i;
  }
  const text = outLines.length ? outLines.join(r.eol) + (outLines[outLines.length - 1] === '' ? '' : r.eol) : '';

  const check = verifyOnlyRemoved(existingText, text, removedFlat, r.eol, atIndexForCheck);
  if (!check.ok) return { action: 'unchanged', text: existingText, removedIds: [] };
  return { action: 'removed', text, removedIds: removable.map((rg) => rg.id) };
}
