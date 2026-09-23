// The gate on `serpens/testing-stack.md` itself. Three defects are pinned here, all reproduced
// before they were fixed:
//
//  1. an ABSENT file passed verify-docs everywhere — so a repository whose two tester-facing
//     commands had nothing to read reported green;
//  2. the UNTOUCHED template passed — `unfilledCount()` on the raw template returned 0, because
//     only stage 6's rendered wrapper added a marker, so copy-the-template-and-fill-in-nothing
//     was green;
//  3. enforcement could not be unconditional — stage 5 runs verify-docs BEFORE stage 6 writes
//     the file, so a naive "absence is an error" rule breaks every first install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { kitPath } from '../src/integrity.mjs';
import {
  validateTestingStack, renderTestingStack, upgradeTestingStack, sectionAnchors, readSlots,
  slotRows, unansweredCount, splitSections, REQUIRED_SECTIONS, MANUAL_ACCESS_SLOTS,
} from '../src/testingstack.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';
import { fillTestingStackText } from './helpers/testing-stack.mjs';

const LANGS = ['en', 'ru'];
const templateOf = (lang) => readFileSync(join(kitPath(lang), 'templates', 'testing-stack.md'), 'utf8');

for (const lang of LANGS) {
  test(`[${lang}] the shipped template carries every required section anchor`, () => {
    const anchors = sectionAnchors(templateOf(lang));
    assert.deepEqual(anchors, REQUIRED_SECTIONS.map((s) => s.key),
      'anchors must be present, in the template order the upgrade path appends from');
  });

  test(`[${lang}] the shipped template asks every Manual testing access slot`, () => {
    const slots = readSlots(templateOf(lang));
    assert.deepEqual(Object.keys(slots).sort(), MANUAL_ACCESS_SLOTS.map((s) => s.key).sort());
  });

  test(`[${lang}] DEFECT 2: the UNTOUCHED template FAILS the gate`, () => {
    const { ok, problems } = validateTestingStack(templateOf(lang));
    assert.equal(ok, false, 'a team that copies the template and answers nothing must not be green');
    // Every slot and every prose section is accounted for, not just one of them.
    for (const slot of MANUAL_ACCESS_SLOTS) {
      assert.ok(problems.some((p) => p.includes(`\`${slot.key}\``)), `no problem names slot ${slot.key}`);
    }
    assert.ok(problems.filter((p) => /still unfilled/.test(p)).length >= 4,
      'each prose/table section ships its own UNFILLED marker');
  });

  test(`[${lang}] a fully answered file PASSES, and \`none\` is a complete answer`, () => {
    const filled = fillTestingStackText(templateOf(lang));
    assert.equal(validateTestingStack(filled).ok, true, validateTestingStack(filled).problems.join('\n'));

    const allNone = filled.split('\n').map((line) => {
      const t = line.trim();
      if (!t.startsWith('|') || !t.endsWith('|')) return line;
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      if (!/^`[a-z0-9-]+`$/.test(cells[0])) return line;
      cells[cells.length - 1] = 'none';
      return `| ${cells.join(' | ')} |`;
    }).join('\n');
    assert.equal(validateTestingStack(allNone).ok, true,
      '`none` everywhere is a repository with no external surface — a complete answer, not a gap');
  });

  test(`[${lang}] a BLANK slot answer is NOT the same as \`none\``, () => {
    const filled = fillTestingStackText(templateOf(lang));
    const blanked = filled.replace(/^(\| `request-client` \|[^|]*\|)[^|]*\|$/m, '$1  |');
    assert.notEqual(blanked, filled, 'the fixture edit must actually have applied');
    const { ok, problems } = validateTestingStack(blanked);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('`request-client`') && p.includes('`none`')),
      'the message must tell the team that `none` is available and blank is not');
  });

  test(`[${lang}] a DELETED section is caught by its anchor, not by its heading text`, () => {
    const filled = fillTestingStackText(templateOf(lang));
    const sections = splitSections(filled);
    const without = filled.replace(sections.get('manual-access'), '');
    const { ok, problems } = validateTestingStack(without);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('`manual-access`')));
  });

  test(`[${lang}] a REWORDED heading still validates — the anchor is what the gate reads`, () => {
    const filled = fillTestingStackText(templateOf(lang))
      .replace(/^## .*$/gm, '## our own name for this section');
    assert.equal(validateTestingStack(filled).ok, true,
      'a team may reword every heading; the machine anchor is the contract');
  });

  test(`[${lang}] renderTestingStack reports the count it actually owes`, () => {
    const rendered = renderTestingStack(templateOf(lang));
    const n = unansweredCount(templateOf(lang));
    assert.match(rendered.split('\n')[0], new RegExp(`^STATUS: PARTIAL — ${n} unanswered facts$`));
    assert.equal(unansweredCount(rendered), n, 'the STATUS line must not itself count as a problem');
  });

  test(`[${lang}] UPGRADE: a file filled under an older edition gains only what it lacks`, () => {
    const template = templateOf(lang);
    const sections = splitSections(template);
    const older = fillTestingStackText(['# Testing stack — svc-a', '',
      ...['fast-tier', 'slow-tier', 'wiring-bugs', 'debugging-order'].map((k) => sections.get(k))].join('\n'));

    const { changed, text, appended } = upgradeTestingStack(older, template);
    assert.equal(changed, true);
    assert.deepEqual(appended, ['manual-access']);
    for (const line of older.split('\n').filter((l) => l.trim())) {
      assert.ok(text.includes(line), `the upgrade dropped a line the team wrote: ${line}`);
    }
    assert.equal(validateTestingStack(text).ok, false,
      'the appended section must arrive UNANSWERED — an upgrade that closes the gate by itself answered nothing');

    // Idempotent: a second pass over the upgraded file changes nothing.
    assert.equal(upgradeTestingStack(text, template).changed, false);
  });

  test(`[${lang}] UPGRADE: a missing SLOT ROW is appended to the existing table`, () => {
    const template = templateOf(lang);
    const filled = fillTestingStackText(template);
    // Drop one slot row entirely, the way an older edition's table would not have had it.
    const dropped = filled.split('\n').filter((l) => !/^\| `error-routing` \|/.test(l)).join('\n');
    assert.equal('error-routing' in readSlots(dropped), false);

    const { changed, text, appended } = upgradeTestingStack(dropped, template);
    assert.equal(changed, true);
    assert.deepEqual(appended, ['slot:error-routing']);
    assert.equal(readSlots(text)['error-routing'], 'UNFILLED', 'it must arrive unanswered');
    assert.equal(validateTestingStack(text).ok, false);
    // And the neighbours are untouched, so the row went into the table, not the end of the file.
    assert.match(text, /^\| `error-routing` \|.*\|$/m);
    assert.equal(Object.keys(readSlots(text)).length, MANUAL_ACCESS_SLOTS.length);
  });
}

// Codex's one-line break of the first, tolerant version of this schema. It read the LAST cell
// as the answer so a team could add a column of their own; a table headed
// `| Slot | Answer | Owner |` with every row `| \`slot\` | UNFILLED | qa-lead |` therefore
// VALIDATED, because `qa-lead` is the last cell. The shape is now constrained instead of
// guessed: exactly three columns, answer third, and a fourth column is a named problem.
test('the four-column table that used to pass by putting UNFILLED in the middle now FAILS', () => {
  const anchored = REQUIRED_SECTIONS.map((s) =>
    `<!-- serpens:section ${s.key} -->\n## ${s.key}\nEnough body text here to satisfy the minimum-content rule for a section.`).join('\n\n');
  const gamed = [anchored, '', '| Slot | Answer | Owner |', '|---|---|---|',
    ...MANUAL_ACCESS_SLOTS.map((s) => `| \`${s.key}\` | UNFILLED | qa-lead |`)].join('\n');

  // Guard the guard: the row really is three cells with UNFILLED in the middle, which is what
  // the old last-cell read let through.
  const rows = slotRows(gamed);
  assert.equal(rows.length, MANUAL_ACCESS_SLOTS.length);
  assert.deepEqual(rows[0].cells, ['`estate-reference`', 'UNFILLED', 'qa-lead']);

  const { ok, problems } = validateTestingStack(gamed);
  assert.equal(ok, false, 'an UNFILLED answer must fail wherever the team put it');
  assert.ok(problems.some((p) => p.includes('`estate-reference`') && /unanswered|still carries/.test(p)),
    'the marker must beat the column: leaving UNFILLED in the row cannot read as answered');
});

test('a FOUR-column slot row is a named problem, not a lenient read', () => {
  const row = '| `request-client` | ask the team | qa-lead | answered |';
  const { problems } = validateTestingStack(
    `<!-- serpens:section manual-access -->\n## m\nbody text long enough for the minimum-content rule to be satisfied here.\n\n${row}`,
  );
  assert.ok(problems.some((p) => /has 4 columns, not 3/.test(p)),
    'the deviation must be reported, so nobody discovers it as a silent false pass');
});

test('an anchor and a table inside a FENCED block are examples, not content', () => {
  const filled = fillTestingStackText(readFileSync(join(kitPath('en'), 'templates', 'testing-stack.md'), 'utf8'));
  const withExample = `${filled}\n\n\`\`\`markdown\n<!-- serpens:section manual-access -->\n| \`request-client\` | example | UNFILLED |\n\`\`\`\n`;
  assert.equal(validateTestingStack(withExample).ok, true,
    'a documentation example must not be read as a duplicate section or an unanswered slot');
});

test('a slot answer containing an escaped pipe survives intact', () => {
  const filled = fillTestingStackText(readFileSync(join(kitPath('en'), 'templates', 'testing-stack.md'), 'utf8'))
    .replace(/^(\| `request-client` \|[^|]*\|)[^|]*\|$/m, '$1 send \\| decode |');
  assert.equal(readSlots(filled)['request-client'], 'send | decode',
    'an escaped pipe is part of the cell — reading only `decode` loses half of what the team wrote');
  assert.equal(validateTestingStack(filled).ok, true);
});

test('the same slot answered twice is a named problem', () => {
  const filled = fillTestingStackText(readFileSync(join(kitPath('en'), 'templates', 'testing-stack.md'), 'utf8'));
  const doubled = filled.replace(/^\| `request-client` \|.*$/m, (m) => `${m}\n${m.replace(/\|([^|]*)\|$/, '| a different answer |')}`);
  const { ok, problems } = validateTestingStack(doubled);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /answered twice/.test(p)));
});

test('`inherit` is a complete answer ONLY while estate-reference names a document', () => {
  const template = readFileSync(join(kitPath('en'), 'templates', 'testing-stack.md'), 'utf8');
  const base = fillTestingStackText(template);
  const setSlot = (text, key, value) =>
    text.replace(new RegExp(`^(\\| \`${key}\` \\|[^|]*\\|)[^|]*\\|$`, 'm'), `$1 ${value} |`);

  // Every slot inherited, with a real estate document named: the template promises this works.
  let inherited = setSlot(base, 'estate-reference', 'docs/estate/testing-access.md');
  for (const slot of MANUAL_ACCESS_SLOTS) {
    if (slot.key !== 'estate-reference') inherited = setSlot(inherited, slot.key, 'inherit');
  }
  assert.equal(validateTestingStack(inherited).ok, true,
    'the estate-reference promise must be real, or the template is lying to the team');

  // The same file with no estate document named: `inherit` points nowhere and must fail.
  const dangling = setSlot(inherited, 'estate-reference', 'none');
  const { ok, problems } = validateTestingStack(dangling);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /names\s*\n?\s*no file to inherit from|no file to inherit from/.test(p)));
});

test('a section whose BODY was deleted fails, even with the anchor kept', () => {
  const filled = fillTestingStackText(readFileSync(join(kitPath('en'), 'templates', 'testing-stack.md'), 'utf8'));
  const sections = splitSections(filled);
  const gutted = filled.replace(sections.get('wiring-bugs'),
    '<!-- serpens:section wiring-bugs -->\n## Wiring bugs\n');
  const { ok, problems } = validateTestingStack(gutted);
  assert.equal(ok, false, 'an anchor with nothing under it is not a written section');
  assert.ok(problems.some((p) => /`wiring-bugs` has an empty body/.test(p)));
});

// --- verify-docs' three rules ------------------------------------------------

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-ts-gate-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  return dir;
}

/** A repository shaped like an onboarded spoke: the kit's serpens/templates/ marks it one. */
function onboardedSpoke({ withDoc }) {
  const dir = gitRepo();
  mkdirSync(join(dir, 'serpens', 'templates'), { recursive: true });
  const template = templateOf('en');
  writeFileSync(join(dir, 'serpens', 'templates', 'testing-stack.md'), template, 'utf8');
  if (withDoc) {
    mkdirSync(join(dir, 'serpens'), { recursive: true });
    writeFileSync(join(dir, 'serpens', 'testing-stack.md'), withDoc === 'filled'
      ? fillTestingStackText(renderTestingStack(template))
      : renderTestingStack(template), 'utf8');
  }
  return dir;
}

/** Only the testing-stack rules; the other three gates are stubbed green. */
async function testingStackVerdict(repoRoot, opts = {}) {
  const okRun = async () => ({ code: 0, stdout: '', stderr: '' });
  const result = await runVerifyDocs({
    repoRoot, run: okRun, checkGitTracking: false, ...opts,
  });
  return { ok: result.ok, text: `${result.evidence.join('\n')}\n${result.output}` };
}

test('DEFECT 1: an ABSENT serpens/testing-stack.md now FAILS in an onboarded repository', async () => {
  const dir = onboardedSpoke({ withDoc: null });
  const { ok, text } = await testingStackVerdict(dir);
  assert.equal(ok, false, 'two commands with nothing to read is not "unaffected"');
  assert.match(text, /testing-stack\.md: missing/);
  assert.match(text, /serpens-sdd init --only 6/, 'the message must state its own remediation');
  assert.doesNotMatch(text, /<serpens-sdd>/,
    'the CLI prints this to a human — an unsubstituted install-time token would be a dead string');
  rmSync(dir, { recursive: true, force: true });
});

test('a repository the kit was never onboarded into is untouched by the rule', async () => {
  const dir = gitRepo();
  mkdirSync(join(dir, 'openspec'), { recursive: true });
  const { ok, text } = await testingStackVerdict(dir);
  assert.equal(ok, true, 'an OpenSpec repository with no kit installed must not be failed by this gate');
  assert.match(text, /absent, and not required here/);
  rmSync(dir, { recursive: true, force: true });
});

test('the STORE is exempt — testing-stack.md is spoke-only', async () => {
  const dir = onboardedSpoke({ withDoc: null });
  writeFileSync(join(dir, 'project-repositories.json'), '{}\n', 'utf8');
  mkdirSync(join(dir, 'serpens'), { recursive: true });
  writeFileSync(join(dir, 'serpens', 'port-facts.md'), 'STATUS: DONE\n', 'utf8');
  const { ok } = await testingStackVerdict(dir);
  assert.equal(ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('DEFECT 3: onboarding: true relaxes ONLY the absence check, never the schema', async () => {
  const absent = onboardedSpoke({ withDoc: null });
  assert.equal((await testingStackVerdict(absent, { onboarding: true })).ok, true,
    'stage 5 runs before stage 6 writes the file — an unconditional rule breaks every first install');

  const present = onboardedSpoke({ withDoc: 'rendered' });
  const { ok, text } = await testingStackVerdict(present, { onboarding: true });
  assert.equal(ok, false, 'a file that IS on disk during onboarding is still validated in full');
  assert.match(text, /still unfilled|unanswered/);
  rmSync(absent, { recursive: true, force: true });
  rmSync(present, { recursive: true, force: true });
});

test('an unanswered file FAILS and a fully answered one PASSES, naming the open slots in between', async () => {
  const dir = onboardedSpoke({ withDoc: 'rendered' });
  const gated = await testingStackVerdict(dir);
  assert.equal(gated.ok, false);
  assert.match(gated.text, /`request-client`/);

  writeFileSync(join(dir, 'serpens', 'testing-stack.md'),
    fillTestingStackText(readFileSync(join(dir, 'serpens', 'testing-stack.md'), 'utf8')), 'utf8');
  const ungated = await testingStackVerdict(dir);
  assert.equal(ungated.ok, true, ungated.text);
  assert.match(ungated.text, /every required section present, every slot answered/);
  rmSync(dir, { recursive: true, force: true });
});
