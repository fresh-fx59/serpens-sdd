import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeShim, resolveCallRoute, renderLefthook, shQuote } from '../src/shim.mjs';
import { kitPath } from '../src/integrity.mjs';

test('the shim is executable, POSIX sh, and adds no project files', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repo, 'tools'));
  const p = writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });
  assert.equal(p, join(repo, 'tools', 'serpens-sdd'));
  const body = readFileSync(p, 'utf8');
  assert.match(body, /^#!\/bin\/sh/);
  assert.match(body, /exec .*serpens-sdd\.mjs/);
  assert.ok(statSync(p).mode & 0o111);
  assert.deepEqual(readdirSync(repo).sort(), ['tools']);
});

test('the shim route is chosen even when no package.json exists', () => {
  const r = resolveCallRoute({ repoRoot: '/r', hasNodeModules: false });
  assert.equal(r.route, 'shim');
  assert.equal(r.invocation, '"$(git rev-parse --show-toplevel)"/tools/serpens-sdd');
});

test('lefthook calls the shim, never a bare npx', () => {
  const yml = renderLefthook(resolveCallRoute({ repoRoot: '/r', hasNodeModules: false }).invocation);
  assert.match(yml, /tools\/serpens-sdd verify-docs/);
  assert.match(yml, /tools\/serpens-sdd git-naming --branch/);
  assert.match(yml, /git-naming --commit-msg \{1\}/);
  assert.doesNotMatch(yml, /npx(?! --no-install)/);
});

test('writeShim refuses to overwrite a non-generated file at the shim path', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repo, 'tools'));
  const shimPath = join(repo, 'tools', 'serpens-sdd');
  const originalContent = '#!/bin/sh\necho "not the serpens-sdd shim"\n';
  writeFileSync(shimPath, originalContent, 'utf8');
  assert.throws(() => writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' }));
  assert.equal(readFileSync(shimPath, 'utf8'), originalContent);
});

test('writeShim overwrites a shim it generated itself', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repo, 'tools'));
  writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });
  const p = writeShim(repo, { binPath: '/opt/serpens-sdd-v2/bin/serpens-sdd.mjs' });
  const body = readFileSync(p, 'utf8');
  assert.match(body, /serpens-sdd-v2/);
});

test('writeShim refuses when repoRoot does not exist, exitCode 3', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const missing = join(repo, 'does-not-exist');
  assert.throws(() => writeShim(missing, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' }), (err) => {
    assert.equal(err.exitCode, 3);
    return true;
  });
});

test('writeShim refuses when tools/ path is occupied by a regular file, with a clear message', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  writeFileSync(join(repo, 'tools'), 'not a directory', 'utf8');
  assert.throws(() => writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' }), (err) => {
    assert.match(err.message, /tools/);
    return true;
  });
});

test('resolveCallRoute: shimAvailable true (default) picks the shim route unchanged', () => {
  const r = resolveCallRoute({ repoRoot: '/r', hasNodeModules: true });
  assert.equal(r.route, 'shim');
  assert.equal(r.invocation, '"$(git rev-parse --show-toplevel)"/tools/serpens-sdd');
});

test('resolveCallRoute: no shim, has package.json -> node_modules route', () => {
  const r = resolveCallRoute({ repoRoot: '/r', hasNodeModules: true, shimAvailable: false });
  assert.equal(r.route, 'node_modules');
  assert.equal(r.invocation, 'node_modules/.bin/serpens-sdd');
});

test('resolveCallRoute: no shim, no package.json -> npx --no-install last resort', () => {
  const r = resolveCallRoute({ repoRoot: '/r', hasNodeModules: false, shimAvailable: false });
  assert.equal(r.route, 'npx');
  assert.equal(r.invocation, 'npx --no-install @fresh-fx59/serpens-sdd');
});

test('renderLefthook reproduces the kit\'s own config/lefthook.yml.example, with only the run: lines rewritten', () => {
  // renderLefthook is a hand-copy of the kit file (comments and all). Nothing but this test
  // keeps the two in step: a kit edit that changes a comment, a hook name or a command now
  // fails here instead of silently shipping a lefthook.yml that no longer matches the kit.
  const invocation = resolveCallRoute({ repoRoot: '/r', hasNodeModules: false }).invocation;

  // The ONLY licensed transformation: each `<serpens-sdd> <subcommand>` placeholder in the kit's
  // example becomes the resolved serpens-sdd invocation. Any other run: line in the kit file fails
  // the test rather than being quietly accepted.
  const RUN_SUBSTITUTIONS = new Map([
    ['<serpens-sdd> verify-docs', `${invocation} verify-docs`],
    ['<serpens-sdd> git-naming --branch', `${invocation} git-naming --branch`],
    ['<serpens-sdd> git-naming --commit-msg {1}', `${invocation} git-naming --commit-msg {1}`],
  ]);

  for (const lang of ['en', 'ru']) {
    const kitFile = join(kitPath(lang), 'config', 'lefthook.yml.example');
    const expected = readFileSync(kitFile, 'utf8').split('\n').map((line) => {
      const m = /^(\s*run:\s*)(.+?)\s*$/.exec(line);
      if (!m) return line;
      const replacement = RUN_SUBSTITUTIONS.get(m[2]);
      assert.ok(replacement !== undefined,
        `${kitFile}: unexpected run: line "${m[2]}" — add its serpens-sdd substitution to renderLefthook and to this test`);
      return `${m[1]}${replacement}`;
    }).join('\n');

    assert.equal(renderLefthook(invocation, lang), expected,
      `renderLefthook has drifted from ${kitFile}`);
  }
});

test('a path with shell metacharacters yields a shim that still passes the real path through sh', () => {
  // A `$`, a backtick or a `"` in the installed path would be expanded by /bin/sh inside a
  // double-quoted shim, producing a broken hook in every repository that got it.
  for (const nasty of ['/opt/co$rp `whoami` "sdd"/bin/serpens-sdd.mjs', "/opt/it's here/bin/serpens-sdd.mjs"]) {
    const repo = mkdtempSync(join(tmpdir(), 'repo-meta-'));
    const body = readFileSync(writeShim(repo, { binPath: nasty }), 'utf8');
    const execLine = body.split('\n').find((l) => l.startsWith('exec '));
    assert.ok(execLine, `no exec line in:\n${body}`);

    // Run the real exec line through /bin/sh with `exec` swapped for a function that prints its
    // second argument: what the shell would actually hand the interpreter, expansions and all.
    const printed = execFileSync('/bin/sh', [
      '-c',
      `f() { printf '%s\n' "$2"; }; ${execLine.replace(/^exec /, 'f ')}`,
    ], { encoding: 'utf8' });
    assert.equal(printed.trimEnd(), nasty, `the shell mangled the path in:\n${execLine}`);
  }
});

test('shQuote survives every shell metacharacter, proven by /bin/sh itself', () => {
  for (const value of ['plain', '$HOME', '`id`', 'a"b', "a'b", 'a b\\c', '$(echo hi)', '!*?~']) {
    const printed = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${shQuote(value)}`], { encoding: 'utf8' });
    assert.equal(printed.trimEnd(), value);
  }
});
