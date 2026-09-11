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
 * Prove an edit only ADDED the given lines: delete the first occurrence of each added line from
 * the result and require what remains to equal the original.
 * @param {string} before
 * @param {string} after
 * @param {string[]} addedLines
 * @param {string} eol
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyOnlyAdded(before, after, addedLines, eol) {
  const norm = (s) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const remaining = after.replace(/\r\n?/g, '\n').split('\n');
  for (const line of addedLines) {
    const i = remaining.indexOf(line);
    if (i === -1) return { ok: false, reason: `the line "${line}" is not in the result` };
    remaining.splice(i, 1);
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
