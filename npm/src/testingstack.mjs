// `docs/testing-stack.md` — the one per-repository facts file. Two commands and two skills read
// it (`spns-test-plan`, `spns-autotest`, `spns-tdd`, `spns-debugging`), so it is the layer that
// lets the kit ship without naming a single technology, protocol or query language a CUSTOMER
// chose.
//
// Why this module exists rather than the `UNFILLED` line count in portfacts.mjs: that count was
// a false gate. Reproduced — `unfilledCount()` on the untouched `templates/testing-stack.md`
// returned 0, because only the wrapper stage 6 renders ADDED a marker. A team that copied the
// template and filled in nothing was green. So the template itself now ships the markers, and
// the gate validates a schema instead of counting a string.
//
// THE INPUT GATE (docs/conventions.md §input-gate principle). A first version of this module
// tried to be tolerant: find the slot rows anywhere, read the LAST cell as the answer so a team
// could add a column of their own. `codex exec` broke it in one line — a table headed
// `| Slot | Answer | Owner |` with every row `| \`slot\` | UNFILLED | qa-lead |` VALIDATES,
// because `qa-lead` is the last cell. Tolerance at the boundary bought a silent false pass, and
// then a second one: the upgrade path spliced three-column rows into a two-column table.
//
// So the shape is now CONSTRAINED instead of guessed, and every deviation is a named problem
// rather than a lenient read:
//
//   1. every required SECTION is present — matched on a language-neutral anchor comment, never
//      on the heading text, because the RU kit localizes every heading and a team may reword
//      one; and its body must actually say something;
//   2. no `UNFILLED — ` line survives anywhere;
//   3. the two tier tables each hold at least one real row, none of it the template's `...`;
//   4. the slot table is EXACTLY three columns — slot, question, answer — and the answer is the
//      third cell, never "the last one";
//   5. every required slot appears exactly once and holds an answer, an explicit `none`, or
//      `inherit` (legal only when `estate-reference` names something).
//
// `none` is a legal answer to any slot: "this repository publishes no events" is complete, and
// it has to be distinguishable from "nobody has said yet", which is what `UNFILLED` means. A
// blank cell is the second, not the first.
//
// Fenced code blocks are invisible to every scan here. The section that explains this file to a
// human is allowed to SHOW an example table and an example anchor without those examples being
// read as content or being spliced into by the upgrade path.
import { readFileSync } from 'node:fs';

const ANCHOR_LINE = /^<!--\s*serpens:section\s+([a-z0-9-]+)\s*-->$/;
const SLOT_CELL = /^`([a-z0-9-]+)`$/;
const PLACEHOLDER = new Set(['...', '…']);

/** Required sections, in the order the template lays them out. `reads` names who breaks. */
export const REQUIRED_SECTIONS = [
  { key: 'fast-tier', reads: 'spns-tdd', kind: 'tier' },
  { key: 'slow-tier', reads: 'spns-tdd', kind: 'tier' },
  { key: 'wiring-bugs', reads: 'spns-tdd', kind: 'prose' },
  { key: 'debugging-order', reads: 'spns-debugging', kind: 'prose' },
  { key: 'manual-access', reads: 'spns-test-plan, spns-autotest', kind: 'slots' },
];

/**
 * The slots of the `manual-access` section — every assumption `spns-test-plan` used to make
 * about the customer's stack, turned into a question the repository answers. `replaces` records
 * the sentence each one retired, so a future edition can prove the command still names nothing
 * the repository did not supply.
 *
 * The two request slots are deliberately NOT called `http-*`. They were, and Codex's
 * counterexample was fair: an unauthenticated TCP `PING`/`PONG` service has no path, no headers
 * and no auth, so an `http-request-idiom` slot prescribed a protocol family the repository never
 * chose — the same class of leak as naming the broker, one level up.
 */
export const MANUAL_ACCESS_SLOTS = [
  { key: 'estate-reference', replaces: 'per-repository duplication of an estate-wide policy' },
  { key: 'request-client', replaces: 'the named HTTP client and the unconditional `curl` line' },
  { key: 'request-idiom', replaces: 'the assumption that one interaction is method + path + headers + body' },
  { key: 'event-transport', replaces: 'the named event broker' },
  { key: 'event-produce-path', replaces: '"there is NO house CLI for producing an event yet"' },
  { key: 'event-addressing', replaces: '"the topic, the message key if the topic is keyed"' },
  { key: 'event-payload-format', replaces: 'the assumption that an event body is JSON' },
  { key: 'data-stores', replaces: 'the two named stores in the expected-result shape' },
  { key: 'store-query-idiom', replaces: 'the unconditional `SELECT`' },
  { key: 'store-seed-idiom', replaces: 'the unconditional `INSERT`' },
  { key: 'error-routing', replaces: '"the dead-letter destination and what lands there"' },
  { key: 'observation-access', replaces: '"a log line the stand exposes"' },
];

/** Answers that are not answers. `none` and `inherit` are deliberately absent. */
const NOT_AN_ANSWER = new Set(['', '...', '…', 'unfilled', 'todo', '-', '—', 'n/a', 'tbd', '?']);

/** The minimum body a required section must carry to count as written, in characters. */
const MIN_SECTION_BODY = 40;

/**
 * Every line of a document, tagged with whether it is inside a fenced code block, plus its
 * 1-based number. Line endings are normalized here, once — a CRLF file used to defeat the anchor
 * match (`-->$` cannot match with a `\r` before the newline), which made every section look
 * missing and made the upgrade path append all five a second time.
 * @param {string} text
 * @returns {Array<{n: number, raw: string, line: string, fenced: boolean}>}
 */
function scan(text) {
  const out = [];
  let fence = null;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const trimmed = raw.trim();
    const open = /^(```+|~~~+)/.exec(trimmed);
    if (fence === null && open) {
      fence = open[1][0].repeat(3);
      out.push({ n: i + 1, raw, line: trimmed, fenced: true });
      return;
    }
    if (fence !== null) {
      const fenced = true;
      if (open && open[1][0].repeat(3) === fence) fence = null;
      out.push({ n: i + 1, raw, line: trimmed, fenced });
      return;
    }
    out.push({ n: i + 1, raw, line: trimmed, fenced: false });
  });
  return out;
}

/**
 * Split one markdown table row into trimmed cells. Returns null for a non-row. An escaped `\|`
 * is part of a cell, not a separator — Codex's `send \| decode` answer used to parse as the
 * cell `decode`, quietly losing half of what the team wrote.
 * @param {string} line - already trimmed
 * @returns {string[]|null}
 */
export function tableCells(line) {
  if (!line.startsWith('|') || !line.endsWith('|') || line.length < 3) return null;
  const inner = line.slice(1, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && inner[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (inner[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += inner[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Which language-neutral section anchors a document carries, in document order, ignoring any
 * inside a fenced code block.
 * @param {string} text
 * @returns {string[]}
 */
export function sectionAnchors(text) {
  return scan(text)
    .filter((l) => !l.fenced)
    .map((l) => ANCHOR_LINE.exec(l.line))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * Every slot row in the document, as found — including malformed ones, so validation can name
 * the deviation instead of silently taking a lenient reading.
 * @param {string} text
 * @returns {Array<{key: string, cells: string[], answer: string|null, n: number}>}
 */
export function slotRows(text) {
  const known = new Set(MANUAL_ACCESS_SLOTS.map((s) => s.key));
  const rows = [];
  for (const l of scan(text)) {
    if (l.fenced) continue;
    const cells = tableCells(l.line);
    if (!cells || isSeparatorRow(cells)) continue;
    const m = SLOT_CELL.exec(cells[0]);
    if (!m || !known.has(m[1])) continue;
    rows.push({ key: m[1], cells, answer: cells.length === 3 ? cells[2] : null, n: l.n });
  }
  return rows;
}

/**
 * The answered slot table as `{key: answer}`, for the well-formed rows only. Callers that need
 * to know about a malformed row use {@link slotRows}.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function readSlots(text) {
  const out = {};
  for (const row of slotRows(text)) {
    if (row.answer !== null && !(row.key in out)) out[row.key] = row.answer;
  }
  return out;
}

/**
 * The anchored blocks of a document: `anchor id -> lines from its anchor comment up to (not
 * including) the next one`. Anchors inside a fence are not anchors.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function splitSections(text) {
  const lines = scan(text);
  const starts = [];
  lines.forEach((l, i) => {
    if (!l.fenced && ANCHOR_LINE.test(l.line)) starts.push({ key: ANCHOR_LINE.exec(l.line)[1], i });
  });
  const out = new Map();
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].i : lines.length;
    out.set(s.key, lines.slice(s.i, end).map((l) => l.raw).join('\n'));
  });
  return out;
}

/**
 * Validate one `docs/testing-stack.md` body against the schema described at the top of this
 * file. Pure: takes text, returns problems. Every problem string is a complete remediation
 * sentence, because `verify-docs` prints it to somebody who has never read this module.
 * @param {string} text
 * @param {{path?: string}} [opts] - `path` only decorates the messages
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateTestingStack(text, { path = 'docs/testing-stack.md' } = {}) {
  const problems = [];
  const sections = splitSections(text);

  for (const section of REQUIRED_SECTIONS) {
    if (!sections.has(section.key)) {
      problems.push(
        `✗ ${path}: required section \`${section.key}\` is missing — ${section.reads} reads it. `
        + 'Re-run the installer (`serpens-sdd init --only 6`) to append the section unanswered '
        + '— it never overwrites an answer you already wrote — then fill it in.',
      );
      continue;
    }
    // An anchor and a heading with nothing under them is not a written section. Deleting the
    // body used to be a silent way past the gate.
    const body = sections.get(section.key).split('\n')
      .filter((l) => !ANCHOR_LINE.test(l.trim()) && !l.trim().startsWith('#'))
      .join('\n').trim();
    if (body.replace(/\s+/g, ' ').length < MIN_SECTION_BODY) {
      problems.push(
        `✗ ${path}: section \`${section.key}\` has an empty body — the heading is there and the `
        + `content is not, so ${section.reads} still has nothing to read.`,
      );
    }
  }

  for (const l of scan(text)) {
    if (l.fenced) continue;
    if (l.line.startsWith('UNFILLED — ')) {
      problems.push(`✗ ${path}:${l.n}: still unfilled — ${l.line.slice('UNFILLED — '.length).trim()}`);
    }
    const cells = tableCells(l.line);
    if (cells && !isSeparatorRow(cells) && cells.some((c) => PLACEHOLDER.has(c))) {
      problems.push(
        `✗ ${path}:${l.n}: this row still holds the template's placeholder (\`${l.line}\`) — `
        + 'replace it with a real row, or delete the row if the section does not apply here.',
      );
    }
  }

  // Each tier table must carry at least one real, complete row. Otherwise a team that deleted
  // the placeholder row without adding its own is green with no tiers at all.
  for (const key of ['fast-tier', 'slow-tier']) {
    if (!sections.has(key)) continue;
    const rows = scan(sections.get(key))
      .filter((l) => !l.fenced)
      .map((l) => tableCells(l.line))
      .filter((c) => c && !isSeparatorRow(c) && c.length === 3);
    // The header row is one of these; a data row is any that is neither header nor placeholder.
    const data = rows.slice(1).filter((c) => !c.some((cell) => PLACEHOLDER.has(cell) || cell === ''));
    if (data.length === 0) {
      problems.push(
        `✗ ${path}: section \`${key}\` has no test row — give at least one component, what counts `
        + 'as a test of that tier here, and the exact command that runs only those.',
      );
    }
  }

  if (sections.has('manual-access')) problems.push(...validateSlots(text, path));
  return { ok: problems.length === 0, problems };
}

/**
 * The slot-table rules, split out because they are where every false pass lived.
 * @param {string} text
 * @param {string} path
 * @returns {string[]}
 */
function validateSlots(text, path) {
  const problems = [];
  const rows = slotRows(text);

  const byKey = new Map();
  for (const row of rows) {
    if (row.cells.length !== 3) {
      problems.push(
        `✗ ${path}:${row.n}: the slot row for \`${row.key}\` has ${row.cells.length} columns, not 3. `
        + 'The slot table is exactly `| slot | what to answer | answer |` — a fourth column of '
        + 'your own would put the answer somewhere this gate cannot find it, and it would read '
        + 'your note as the answer. Keep the three columns and put notes under the table.',
      );
      continue;
    }
    if (byKey.has(row.key)) {
      problems.push(
        `✗ ${path}:${row.n}: slot \`${row.key}\` is answered twice (also at line ${byKey.get(row.key).n}) — `
        + 'delete one row, so there is no question about which answer holds.',
      );
      continue;
    }
    byKey.set(row.key, row);
  }

  const estate = byKey.get('estate-reference');
  const estateAnswered = Boolean(estate)
    && !NOT_AN_ANSWER.has(estate.answer.toLowerCase())
    && estate.answer.toLowerCase() !== 'none'
    && estate.answer.toLowerCase() !== 'inherit';

  for (const slot of MANUAL_ACCESS_SLOTS) {
    const row = byKey.get(slot.key);
    if (!row) {
      problems.push(
        `✗ ${path}: the Manual testing access table has no \`${slot.key}\` row — `
        + `spns-test-plan needs it in place of ${slot.replaces}. `
        + 'Re-run the installer (`serpens-sdd init --only 6`) to append the missing rows unanswered.',
      );
      continue;
    }
    const answer = row.answer;
    const lower = answer.toLowerCase();

    // `UNFILLED` ANYWHERE in the row means the row is not answered, whatever column it sits in.
    // Codex's break of the previous rule survived one round: with the answer pinned to the third
    // cell, a table headed `| Slot | Answer | Owner |` and rows `| slot | UNFILLED | qa-lead |`
    // still validated, because `qa-lead` is a perfectly good third cell. Reading a marker the
    // team deliberately left in place as "answered" is the exact false pass this gate exists to
    // prevent, so the marker wins over the column.
    //
    // Residual, stated rather than hidden: a team that reorders the columns AND fills both cells
    // with real prose will have the third one read as the answer. Nothing in the file
    // distinguishes their intent at that point; what matters is that no UNFILLED marker can be
    // parked in a row and still count as complete.
    const stray = row.cells.slice(1).find((c) => NOT_AN_ANSWER.has(c.toLowerCase()));
    if (stray !== undefined && !NOT_AN_ANSWER.has(lower)) {
      problems.push(
        `✗ ${path}:${row.n}: slot \`${slot.key}\` still carries \`${stray}\` in one of its cells — `
        + 'the row is not answered while that marker is in it. The table is '
        + '`| slot | what to answer | answer |`: put the answer in the third column and keep '
        + 'notes of your own under the table, not in it.',
      );
      continue;
    }

    if (NOT_AN_ANSWER.has(lower)) {
      problems.push(
        `✗ ${path}:${row.n}: slot \`${slot.key}\` is unanswered (${answer ? `\`${answer}\`` : 'empty'}) — `
        + 'answer it from this repository\'s real dev stand, or write `none` if this repository '
        + 'has no such surface at all. `none` is a complete answer; blank is not.',
      );
      continue;
    }
    // `inherit` makes the template's estate promise real and still checkable: the section says
    // an estate-wide answer may live in one file and be overridden per repository, so a slot
    // must be able to say "that file answers this" — but only when that file was actually named.
    if (lower === 'inherit' && slot.key !== 'estate-reference') {
      if (!estateAnswered) {
        problems.push(
          `✗ ${path}:${row.n}: slot \`${slot.key}\` says \`inherit\`, but \`estate-reference\` names `
          + 'no file to inherit from. Either name the estate-wide document in `estate-reference`, '
          + 'or answer this slot here.',
        );
      }
    }
  }
  return problems;
}

/**
 * How many facts a `docs/testing-stack.md` body still owes — the number the rendered STATUS
 * line reports and `init` prints, so "how far from green am I" is one number in three places.
 * @param {string} text
 * @returns {number}
 */
export function unansweredCount(text) {
  return validateTestingStack(text).problems.length;
}

/**
 * Render the file a freshly-onboarded spoke receives (docs/SETUP.md §5 step 6a). The template
 * already carries every `UNFILLED` marker and every unanswered slot, so this only prefixes the
 * count — unlike the previous edition, where the wrapper WAS the only thing making the file
 * fail the gate, and a hand-copied template was therefore green.
 * @param {string} templateText - raw contents of `kits/<lang>/templates/testing-stack.md`
 * @returns {string}
 */
export function renderTestingStack(templateText) {
  const body = `${templateText.replace(/\r\n?/g, '\n').trimEnd()}\n`;
  const n = unansweredCount(body);
  return `STATUS: PARTIAL — ${n} unanswered fact${n === 1 ? '' : 's'}\n\n${body}`;
}

/**
 * Upgrade an EXISTING `docs/testing-stack.md` to the current schema without touching one word
 * the team wrote.
 *
 * Why it is needed: `stage6-install.mjs` never overwrites a file that already exists — correct,
 * and it means a repository whose file was filled in under an older edition would never gain a
 * section added later. It would then fail the new gate with no path forward but hand-editing.
 * So: append each MISSING required section, verbatim from the current template and therefore
 * still carrying its `UNFILLED` markers, and leave every present section exactly as found.
 *
 * A missing slot ROW inside an already-present `manual-access` section is appended the same way
 * — but ONLY into a well-formed three-column slot table. Splicing a three-column row into a
 * table a team had rewritten to two columns produced markdown whose answer cell fell outside
 * the table; that case is now refused and reported instead, because a mangled file is worse
 * than a file the gate names a problem in.
 * @param {string} existingText
 * @param {string} templateText
 * @returns {{changed: boolean, text: string, appended: string[], refused: string[]}}
 */
export function upgradeTestingStack(existingText, templateText) {
  const normalized = existingText.replace(/\r\n?/g, '\n');
  const have = new Set(sectionAnchors(normalized));
  const appended = [];
  const refused = [];
  let text = normalized.trimEnd();

  const templateSections = splitSections(templateText);
  for (const section of REQUIRED_SECTIONS) {
    if (have.has(section.key)) continue;
    const block = templateSections.get(section.key);
    if (!block) continue; // the template no longer ships it; nothing honest to append
    text += `\n\n${block.trimEnd()}`;
    appended.push(section.key);
  }

  if (have.has('manual-access')) {
    const rows = slotRows(text);
    const malformed = rows.filter((r) => r.cells.length !== 3);
    const present = new Set(rows.map((r) => r.key));
    const missing = MANUAL_ACCESS_SLOTS.filter((s) => !present.has(s.key));
    if (missing.length > 0 && malformed.length > 0) {
      // Refusing beats mangling: the gate will already be naming the malformed rows.
      refused.push(...missing.map((s) => `slot:${s.key}`));
    } else if (missing.length > 0) {
      const newRows = [];
      for (const slot of missing) {
        const row = templateSlotRow(templateText, slot.key);
        if (row) { newRows.push(row); appended.push(`slot:${slot.key}`); }
      }
      if (newRows.length > 0) text = appendRowsToSlotTable(text, newRows);
    }
  }

  return { changed: appended.length > 0, text: `${text}\n`, appended, refused };
}

/**
 * One slot row exactly as the template ships it (localized prose included), so an upgrade
 * appends the same question a fresh install would have asked.
 * @param {string} templateText
 * @param {string} key
 * @returns {string|null}
 */
function templateSlotRow(templateText, key) {
  for (const l of scan(templateText)) {
    if (l.fenced) continue;
    const cells = tableCells(l.line);
    if (cells && cells.length === 3 && cells[0] === `\`${key}\``) return l.raw.trimEnd();
  }
  return null;
}

/**
 * Insert rows immediately after the LAST well-formed slot row outside any fence. Falls back to
 * appending a fresh three-column table when the section carries no slot row at all yet.
 * @param {string} text
 * @param {string[]} rows
 * @returns {string}
 */
function appendRowsToSlotTable(text, rows) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const existing = slotRows(text).filter((r) => r.cells.length === 3);
  if (existing.length === 0) {
    const header = templateHeaderFallback();
    return `${lines.join('\n').trimEnd()}\n\n${header}\n${rows.join('\n')}`;
  }
  const last = existing[existing.length - 1].n; // 1-based
  lines.splice(last, 0, ...rows);
  return lines.join('\n');
}

/** The three-column header used only when a file has no slot table left to append to. */
function templateHeaderFallback() {
  return '| Slot | What to answer | Answer |\n|---|---|---|';
}

/**
 * Read and validate the file at `path`. Convenience for `verify-docs`, which also needs the
 * absent case, so absence is reported here rather than being an exception the caller catches.
 * @param {string} path
 * @returns {{ok: boolean, problems: string[], present: boolean}}
 */
export function validateTestingStackFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, present: false, problems: [`✗ ${path}: missing`] };
  }
  return { ...validateTestingStack(text, { path }), present: true };
}
