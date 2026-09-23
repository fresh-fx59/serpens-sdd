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
