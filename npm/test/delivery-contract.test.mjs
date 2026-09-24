// spec-org-facts-slice-delivery-2026-09-23.md — the executable half: ONE delivery-convention
// contract (tools/lib/delivery-contract.sh), read by `delivery --print-contract`,
// `delivery --handoff`, and by `repository-state.sh`'s expected_base(). Same shape as
// tools/lib/branch-contract.sh / test/branch-contract.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/run.mjs';
import { resolveTool } from '../src/cli/tools.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-contract-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function writeDelivery(repoRoot, body) {
  const dir = join(repoRoot, 'serpens');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'delivery.md'), body, 'utf8');
}

const FULL_CONTRACT = [
  '<!-- serpens:section delivery-contract -->',
  '| Field | Value |',
  '|---|---|',
  '| `forge-word` | MR |',
  '| `pr-opened-by` | agent |',
  '| `merge-order` | store-contract,producer,consumers |',
  '| `integration-branch` | trunk |',
  '| `merge-style` | squash |',
  '',
].join('\n');

async function delivery(argv, cwd, extraEnv) {
  const { cmd, args } = resolveTool('delivery', argv);
  const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
  return run(cmd, args, { cwd, env });
}

const DEFAULT_LINES = [
  'forge-word=PR',
  'pr-opened-by=human',
  'ticket-topology=parent-story+child-per-repo',
  'child-created-by=ask',
  'proposal-approval=analyst-in-story',
  'test-plan-posted-to=same-ticket-comment',
  'merge-order=producer,consumers,store-contract',
  'review-may-merge=no',
  'release-branch=master',
  'archive-when=after-qa-accepted',
  'handoff-to=chat',
];

test('no conventions file: --print-contract prints exactly the §4 defaults, source=defaults', async () => {
  const repo = makeRepo();
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 0);
  for (const line of DEFAULT_LINES) {
    assert.match(result.stdout, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.match(result.stdout, /^merge-style=UNSET$/m);
  assert.match(result.stdout, /^source=defaults$/m);
});

test('a delivery.md present but with NO anchor (the shipped, unfilled prose template) behaves exactly like no file at all', async () => {
  const repo = makeRepo();
  writeDelivery(repo, '# Delivery conventions\n\nJust prose, no anchor here.\n');
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^source=defaults$/m);
});

test('a fenced example anchor is invisible to the parser: defaults still apply', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '# prose',
    '',
    '```markdown',
    '<!-- serpens:section delivery-contract -->',
    '| `forge-word` | MR |',
    '```',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^forge-word=PR$/m);
  assert.match(result.stdout, /^source=defaults$/m);
});

test('anchored contract overrides fields; unset fields keep their defaults', async () => {
  const repo = makeRepo();
  writeDelivery(repo, FULL_CONTRACT);
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^forge-word=MR$/m);
  assert.match(result.stdout, /^pr-opened-by=agent$/m);
  assert.match(result.stdout, /^merge-order=store-contract,producer,consumers$/m);
  assert.match(result.stdout, /^integration-branch=trunk$/m);
  assert.match(result.stdout, /^merge-style=squash$/m);
  // unset field keeps its default
  assert.match(result.stdout, /^handoff-to=chat$/m);
  assert.match(result.stdout, /serpens[/\\]delivery\.md$/m);
});

test('`## Team notes` free text below the anchor is inert: garbage prose there does not break parsing or change any value', async () => {
  const repo = makeRepo();
  writeDelivery(repo, `${FULL_CONTRACT}\n## Team notes\n\n<!-- this is not --> | not a | table row |\nrandom garbage %%% unparseable\n`);
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^forge-word=MR$/m);
});

test('unknown field is a fatal error naming the file and line', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `not-a-real-field` | x |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /serpens[/\\]delivery\.md:2:/);
  assert.match(result.stderr, /unknown field `not-a-real-field`/);
});

test('duplicate field is a fatal error naming both lines', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `forge-word` | PR |',
    '| `forge-word` | MR |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /field `forge-word` is set twice \(also at line 2\)/);
});

test('bad enum value pr-opened-by=bot is a fatal, named error', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `pr-opened-by` | bot |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /`pr-opened-by` must be human or agent, got: bot/);
});

test('merge-order=producer,producer,x is rejected (not a permutation of the three tokens)', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `merge-order` | producer,producer,x |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /`merge-order` must be a permutation of producer,consumers,store-contract/);
});

test('review-may-merge=yes is rejected — the only allowed value is no', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `review-may-merge` | yes |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /`review-may-merge` accepts only 'no'/);
});

test('ticket-topology=single-ticket is rejected — deferred, not a shipped value', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `ticket-topology` | single-ticket |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /single-ticket is deferred, not shipped/);
});

test('3-column row is a fatal error naming the line', async () => {
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| Field | Value | Extra |',
    '|---|---|---|',
    '| `forge-word` | PR | z |',
    '',
  ].join('\n'));
  const result = await delivery(['--print-contract'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /row has 3 column\(s\), expected 2/);
});

test('provenance: --conventions pointing at an unanchored file errors, never silently defaults', async () => {
  const repo = makeRepo();
  const p = join(repo, 'custom-delivery.md');
  writeFileSync(p, '# just prose\n', 'utf8');
  const result = await delivery(['--print-contract', '--conventions', p], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no <!-- serpens:section delivery-contract --> anchor found in this explicitly-configured conventions file/);
});

test('--handoff on a pushed branch prints branch, base and title with pr-opened-by=human wording', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });

  const repo = makeRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-142']);
  writeFileSync(join(repo, 'x.txt'), 'x\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'x.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'feat(SVC-142): add field']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'feature/SVC-142']);

  const result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^PR is opened by a human in this shop\. Do not create it\.$/m);
  assert.match(result.stdout, /^Pushed branch: feature\/SVC-142$/m);
  assert.match(result.stdout, /^Target branch: develop$/m);
  assert.match(result.stdout, /^Suggested title: feat\(SVC-142\): add field$/m);
});

test('--handoff on an unpushed branch fails naming the fix', async () => {
  const repo = makeRepo();
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-1']);
  const result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /has no upstream — push it first/);
});

// Eval 2026-09-24 (scenario b): an agent handed off a freshly cut branch with NO commits of its
// own; the recorded tip was origin/develop's own tip, so `state assert-archivable` then reported
// that branch "merged" — a false positive. A branch with nothing beyond the base has nothing to
// hand off, and no tip may be recorded for it.
test('--handoff on a pushed branch with no commits beyond the base refuses and records no tip', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-7', 'origin/develop']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'feature/SVC-7']);

  const result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /feature\/SVC-7 has no commits beyond origin\/develop — nothing to hand off/);
  assert.doesNotMatch(result.stdout, /Pushed branch:/);
  assert.equal(existsSync(join(repo, '.serpens.yaml')), false, 'no handoff tip may be recorded');
});

test('--handoff with pr-opened-by=agent prints the agent-may-open wording', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `pr-opened-by` | agent |',
    '',
  ].join('\n'));
  execFileSync('git', ['-C', repo, 'add', 'serpens/delivery.md']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'chore: add delivery contract']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-2']);
  writeFileSync(join(repo, 'y.txt'), 'y\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'y.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'feat(SVC-2): work']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'feature/SVC-2']);

  const result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^You may open the PR\.$/m);
});

// ---- the ONE-contract proof: repository-state.sh reads the same file for integration-branch ---

test('repository-state.sh: with no delivery.md, expected_base falls back to origin/develop when present (unchanged behaviour)', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'develop']);
  execFileSync('git', ['-C', repo, 'branch', '--set-upstream-to=origin/develop', 'develop']);

  const { cmd, args } = resolveTool('state', ['inspect', '--repo', repo]);
  const result = await run(cmd, args, { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^expected_base=develop$/m);
});

test('repository-state.sh: `integration-branch` set in delivery.md wins over the hardcoded lookup', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `integration-branch` | trunk |',
    '',
  ].join('\n'));
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);

  const { cmd, args } = resolveTool('state', ['inspect', '--repo', repo]);
  const result = await run(cmd, args, { cwd: repo });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^expected_base=trunk$/m);
});

// ---- §2b item 8: Settings reference drift gate -------------------------------------------------

const PARSER_FIELDS = {
  'forge-word': ['PR', 'MR'],
  'pr-opened-by': ['human', 'agent'],
  'ticket-topology': ['parent-story+child-per-repo'],
  'child-created-by': ['ask', 'analyst', 'agent'],
  'proposal-approval': ['analyst-in-story', 'none'],
  'test-plan-posted-to': ['same-ticket-comment', 'print-only'],
  'review-may-merge': ['no'],
  'archive-when': ['after-merge', 'after-qa-accepted'],
  'merge-style': ['merge', 'squash', 'rebase'],
  'handoff-to': ['chat', 'chat+ticket'],
};

for (const [lang, path, heading] of [
  ['en', 'kits/en/templates/conventions-delivery.md', '## Settings reference'],
  ['ru', 'kits/ru/templates/conventions-delivery.md', '## Справочник настроек'],
]) {
  test(`Settings reference completeness (${lang}): every enum field + every allowed value is documented`, () => {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const idx = text.indexOf(heading);
    assert.ok(idx >= 0, 'Settings reference section must exist');
    const section = text.slice(idx);
    for (const [field, values] of Object.entries(PARSER_FIELDS)) {
      assert.match(section, new RegExp('`' + field + '`'), `${field} must be documented`);
      for (const v of values) {
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(section, new RegExp('`' + esc + '`'), `${field}=${v} must be documented`);
      }
    }
  });
}

// ---- §2b item 3: --handoff records the tip; §2c item 12: handoff-to=chat+ticket -----------------

test('--handoff records the pushed HEAD as a handoff-tip in <repo-root>/.serpens.yaml, latest wins', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-9']);
  writeFileSync(join(repo, 'x.txt'), 'x\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'x.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'feat(SVC-9): one']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'feature/SVC-9']);
  const tip1 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  let result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 0, result.stderr);
  let estate = readFileSync(join(repo, '.serpens.yaml'), 'utf8');
  assert.match(estate, new RegExp(`handoff-tip: feature/SVC-9 ${tip1}`));

  // A second commit + push: the latest tip is recorded too, the first one is kept (not overwritten).
  writeFileSync(join(repo, 'y.txt'), 'y\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'y.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'feat(SVC-9): two']);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'feature/SVC-9']);
  const tip2 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 0, result.stderr);
  estate = readFileSync(join(repo, '.serpens.yaml'), 'utf8');
  assert.match(estate, new RegExp(`handoff-tip: feature/SVC-9 ${tip1}`));
  assert.match(estate, new RegExp(`handoff-tip: feature/SVC-9 ${tip2}`));

  // Re-running --handoff with HEAD unchanged does not grow the file with a duplicate line.
  result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 0, result.stderr);
  const finalEstate = readFileSync(join(repo, '.serpens.yaml'), 'utf8');
  const occurrences = finalEstate.split(`handoff-tip: feature/SVC-9 ${tip2}`).length - 1;
  assert.equal(occurrences, 1, 'an unchanged HEAD must not add a duplicate handoff-tip line');
});

test('--confirm-archive-when records the estate\'s answer once; a repeat call overwrites, not duplicates', async () => {
  const repo = makeRepo();
  let result = await delivery(['--confirm-archive-when', 'after-merge'], repo);
  assert.equal(result.code, 0, result.stderr);
  let estate = readFileSync(join(repo, '.serpens.yaml'), 'utf8');
  assert.match(estate, /^archive-when-confirmed: after-merge$/m);

  result = await delivery(['--confirm-archive-when', 'after-qa-accepted'], repo);
  assert.equal(result.code, 0, result.stderr);
  estate = readFileSync(join(repo, '.serpens.yaml'), 'utf8');
  const lines = estate.split('\n').filter(l => l.startsWith('archive-when-confirmed: '));
  assert.deepEqual(lines, ['archive-when-confirmed: after-qa-accepted']);
});

test('--confirm-archive-when rejects a value outside the two allowed', async () => {
  const repo = makeRepo();
  const result = await delivery(['--confirm-archive-when', 'sometimes'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must be after-merge or after-qa-accepted/);
});

test('handoff-to=chat+ticket with a stub tracker posts the exact hand-off text as a ticket comment', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `handoff-to` | chat+ticket |',
    '',
  ].join('\n'));
  execFileSync('git', ['-C', repo, 'add', 'serpens/delivery.md']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'chore: delivery contract']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-10']);
  writeFileSync(join(repo, 'w.txt'), 'w\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'w.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'feat(SVC-10): work']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'feature/SVC-10']);

  const capture = join(repo, 'posted.txt');
  const result = await delivery(['--handoff'], repo, {
    SERPENS_SDD_TRACKER_CMD: `cat > "${capture}"`,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /posted the hand-off above as a ticket comment/);
  const posted = readFileSync(capture, 'utf8');
  assert.match(posted, /^PR is opened by a human in this shop\. Do not create it\.$/m);
  assert.match(posted, /^Pushed branch: feature\/SVC-10$/m);
  assert.match(posted, /^Target branch: develop$/m);
});

test('handoff-to=chat+ticket with NO tracker configured errors naming the gap, never silently falls back to chat-only', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'serpens-sdd-delivery-origin-'));
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'develop'], { cwd: origin });
  const repo = makeRepo();
  writeDelivery(repo, [
    '<!-- serpens:section delivery-contract -->',
    '| `handoff-to` | chat+ticket |',
    '',
  ].join('\n'));
  execFileSync('git', ['-C', repo, 'add', 'serpens/delivery.md']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'chore: delivery contract']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main:develop']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature/SVC-11']);
  writeFileSync(join(repo, 'w.txt'), 'w\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'w.txt']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, 'commit', '-q', '-m', 'feat(SVC-11): work']);
  execFileSync('git', ['-C', repo, 'push', '-q', '-u', 'origin', 'feature/SVC-11']);

  const result = await delivery(['--handoff'], repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires a configured tracker; none found/);
});
