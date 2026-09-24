import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { substituteTokens } from '../src/stages/stage6-install.mjs';

const fixture = fileURLToPath(new URL('../../tests/weak-model-gate-fixture.sh', import.meta.url));
const kits = fileURLToPath(new URL('../kits/', import.meta.url));

function targetFor(t) {
  const target = mkdtempSync(join(tmpdir(), 'weak-model-gate-test-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  return target;
}

function build(target, flags) {
  const result = spawnSync('bash', [fixture, target, ...flags], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /== fixture built ==/);
}

for (const [lang, flags] of [
  ['en', []], ['en', ['--lang', 'en']], ['en', ['--lang=en']],
  ['ru', ['--lang', 'ru']], ['ru', ['--lang=ru']],
]) {
  test(`fixture installs kits/${lang} with ${flags.join(' ') || 'default language'}`, (t) => {
    const target = targetFor(t);
    build(target, flags);
    const kit = join(kits, lang);
    const installed = join(target, 'sample-service', '.claude');
    const files = [
      ...readdirSync(join(kit, 'commands')).filter((f) => f.endsWith('.md')).map((f) => join('commands', f)),
      ...readdirSync(join(kit, 'skills')).map((f) => join('skills', f, 'SKILL.md')),
    ];
    for (const file of files) {
      const expected = substituteTokens(readFileSync(join(kit, file), 'utf8'), {
        openspec: join(target, 'bin', 'openspec'),
        serpensSdd: '"$(git rev-parse --show-toplevel)"/serpens/bin/serpens-sdd',
      });
      const destination = file.startsWith('commands/') ? file.replace('commands/spns-', 'commands/spns/') : file;
      assert.equal(readFileSync(join(installed, destination), 'utf8'), expected, `${lang}/${file}`);
    }
  });
}

for (const flags of [['--lang', 'xx'], ['--lang=xx'], ['--lang'], ['--lang='], ['--lang', '']]) {
  test(`fixture rejects invalid language arguments ${JSON.stringify(flags)}`, (t) => {
    const target = targetFor(t);
    const result = spawnSync('bash', [fixture, target, ...flags], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FATAL:.*(?:language|--lang).*en.*ru/);
    assert.equal(existsSync(join(target, 'sample-service')), false);
  });
}

test('OpenSpec stub rejects invented commands, preserves recognized responses, and logs every call', (t) => {
  const target = targetFor(t);
  build(target, ['--lang=en']);
  const cwd = join(target, 'sample-service');
  const calls = [];
  const invoke = (args) => {
    calls.push(args);
    return spawnSync(join(target, 'bin', 'openspec'), args, { cwd, encoding: 'utf8' });
  };
  for (const args of [['invented-command', '--json'], ['new', 'invented-kind'], []]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unrecognized.*subcommand/i);
    if (args.length) assert.ok(result.stderr.includes(args.join(' ')));
  }
  for (const [args, expected] of [
    [['new', 'change', 'test-change'], { ok: true, change: 'test-change', created: true }],
    [['status'], { ok: true, artifacts: [] }],
    [['instructions', 'proposal'], { ok: true, artifact: 'proposal', instructions: 'stub instructions for proposal', done: false }],
    [['instructions'], { ok: true, artifact: 'unknown', instructions: 'stub instructions for unknown', done: false }],
    [['validate'], { ok: true, valid: true, errors: [] }],
    [['archive', 'test-change'], { ok: true, archived: 'test-change' }],
    [['archive'], { ok: true, archived: null }],
    [['list'], { ok: true, items: [] }],
    [['show'], { ok: true, item: null }],
    [['store'], { ok: true, stores: [] }],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  assert.equal(readFileSync(join(cwd, 'openspec/changes/test-change/proposal.md'), 'utf8'), '# Proposal (stub)\n');
  const version = invoke(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stderr, '');
  assert.equal(version.stdout, 'stub-openspec 0.0.0-fixture\n');
  const lines = readFileSync(join(target, 'openspec-calls.log'), 'utf8').split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, calls.length);
  lines.forEach((line, i) => {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z openspec /);
    assert.equal(line.slice(line.indexOf(' openspec ') + 10), calls[i].map((arg) => JSON.stringify(arg)).join(' '));
  });
});

// spec-org-facts-slice-delivery-2026-09-23.md §2b item 3, fix (slice B part 7, eval 2026-09-24
// part7-b): the archive-ready fixture's change folder + handoff-tip record must be pre-seeded
// EXACTLY as a real spec/implement pass + `delivery --handoff` would have left them BEFORE the
// PR merged — keyed by change-id (+ticket), never by branch. The original fixture keyed the tip
// to `develop`, silently masking the very branch-vs-change-id bug this design fixes (samples 1/2
// of that run: assert-archivable found no tip, and the model fabricated one by hand instead of
// doing the archive work).
test('archive-ready fixture pre-marks the change and records the handoff tip by change-id, never by branch', (t) => {
  const target = targetFor(t);
  build(target, ['--variant=archive-ready']);
  const repo = join(target, 'sample-service');

  const marker = readFileSync(join(repo, 'openspec/changes/SVC-142/.serpens.yaml'), 'utf8');
  assert.match(marker, /^ticket: SVC-142$/m);

  const estate = readFileSync(join(repo, '.serpens.yaml'), 'utf8');
  assert.match(estate, /^handoff-tip: SVC-142 SVC-142 [0-9a-f]{40}$/m);
  assert.doesNotMatch(estate, /^handoff-tip: develop /m, 'must never key the tip by branch name');

  // End-to-end proof: the real CLI's assert-archivable passes IMMEDIATELY, with no hand-off
  // needed and no branch switch — exactly the state a genuinely-merged, already-marked change is
  // in when archive starts.
  const bin = fileURLToPath(new URL('../bin/serpens-sdd.mjs', import.meta.url));
  const result = spawnSync('node', [bin, 'state', 'assert-archivable', '--change', 'SVC-142', '--repo', repo], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /merge-style=merge/);
});
