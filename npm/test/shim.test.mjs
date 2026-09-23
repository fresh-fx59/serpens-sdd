import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  writeShim, resolveCallRoute, renderLefthook, shQuote, findLefthookConfigs, yamlSingleQuote,
  LEFTHOOK_MARKER, LEFTHOOK_MAIN_CONFIG_NAMES,
} from '../src/shim.mjs';
import { kitPath } from '../src/integrity.mjs';

test('the shim is executable, POSIX sh, and adds no project files', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const p = writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' });
  assert.equal(p, join(repo, 'serpens', 'bin', 'serpens-sdd'));
  const body = readFileSync(p, 'utf8');
  assert.match(body, /^#!\/bin\/sh/);
  assert.match(body, /exec .*serpens-sdd\.mjs/);
  assert.ok(statSync(p).mode & 0o111);
  // The kit creates its OWN directory and nothing else. `tools/` used to be created here, in a
  // namespace every repository already uses; that is exactly what the move to `serpens/` ends.
  assert.deepEqual(readdirSync(repo).sort(), ['serpens']);
});

test('the shim route is chosen even when no package.json exists', () => {
  const r = resolveCallRoute({ repoRoot: '/r', hasNodeModules: false });
  assert.equal(r.route, 'shim');
  assert.equal(r.invocation, '"$(git rev-parse --show-toplevel)"/serpens/bin/serpens-sdd');
});

test('lefthook calls the shim, never a bare npx', () => {
  const yml = renderLefthook(resolveCallRoute({ repoRoot: '/r', hasNodeModules: false }).invocation);
  assert.match(yml, /serpens\/bin\/serpens-sdd verify-docs/);
  assert.match(yml, /serpens\/bin\/serpens-sdd git-naming --branch/);
  assert.match(yml, /git-naming --commit-msg \{1\}/);
  assert.doesNotMatch(yml, /npx(?! --no-install)/);
});

test('writeShim refuses to overwrite a non-generated file at the shim path', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repo, 'serpens', 'bin'), { recursive: true });
  const shimPath = join(repo, 'serpens', 'bin', 'serpens-sdd');
  const originalContent = '#!/bin/sh\necho "not the serpens-sdd shim"\n';
  writeFileSync(shimPath, originalContent, 'utf8');
  assert.throws(() => writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' }));
  assert.equal(readFileSync(shimPath, 'utf8'), originalContent);
});

test('writeShim overwrites a shim it generated itself', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
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

test('writeShim refuses when the shim directory is occupied by a regular file, with a clear message', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(repo, 'serpens'));
  writeFileSync(join(repo, 'serpens', 'bin'), 'not a directory', 'utf8');
  assert.throws(() => writeShim(repo, { binPath: '/opt/serpens-sdd/bin/serpens-sdd.mjs' }), (err) => {
    assert.match(err.message, /serpens/);
    return true;
  });
});

test('resolveCallRoute: shimAvailable true (default) picks the shim route unchanged', () => {
  const r = resolveCallRoute({ repoRoot: '/r', hasNodeModules: true });
  assert.equal(r.route, 'shim');
  assert.equal(r.invocation, '"$(git rev-parse --show-toplevel)"/serpens/bin/serpens-sdd');
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
  // The value is YAML single-quoted: the shim invocation starts with a double-quoted `"$(…)"`
  // followed by more text, which is INVALID as a plain or double-quoted YAML scalar (real
  // lefthook 2.1.4: `yaml: line 8: did not find expected key`, found in the step-6 repro).
  const RUN_SUBSTITUTIONS = new Map([
    ['<serpens-sdd> verify-docs --staged-scope', yamlSingleQuote(`${invocation} verify-docs --staged-scope`)],
    ['<serpens-sdd> git-naming --branch', yamlSingleQuote(`${invocation} git-naming --branch`)],
    ['<serpens-sdd> git-naming --commit-msg {1}', yamlSingleQuote(`${invocation} git-naming --commit-msg {1}`)],
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

test('renderLefthook starts with the generated marker, en and ru', () => {
  for (const lang of ['en', 'ru']) {
    const yml = renderLefthook('/repo/serpens/bin/serpens-sdd', lang);
    assert.ok(yml.startsWith(LEFTHOOK_MARKER), `${lang}: renderLefthook does not start with the marker`);
  }
});

test('renderLefthook uses only the three namespaced serpens- command names', () => {
  const yml = renderLefthook('/repo/serpens/bin/serpens-sdd');
  assert.match(yml, /\n {4}serpens-docs:\n/);
  assert.match(yml, /\n {4}serpens-branch:\n/, 'pre-commit branch-convention must be renamed');
  assert.match(yml, /\n {4}serpens-commit-msg:\n/);
  // The pre-push copy must be renamed too — same command name, different hook.
  const prePush = yml.slice(yml.indexOf('pre-push:'));
  assert.match(prePush, /\n {4}serpens-branch:\n/);
  // The old command names must be gone entirely.
  assert.doesNotMatch(yml, /docs-disposer|branch-convention|message-convention/);
});

test('findLefthookConfigs finds every one of the 15 main config names, one at a time', () => {
  for (const name of LEFTHOOK_MAIN_CONFIG_NAMES) {
    const repo = mkdtempSync(join(tmpdir(), 'repo-lefthook-cfg-'));
    if (name.includes('/')) mkdirSync(join(repo, name.split('/')[0]), { recursive: true });
    writeFileSync(join(repo, name), '', 'utf8');
    assert.deepEqual(findLefthookConfigs(repo), [name], `expected only ${name} to be found`);
  }
  assert.equal(LEFTHOOK_MAIN_CONFIG_NAMES.length, 15,
    `lefthook reads 15 main config names; got ${LEFTHOOK_MAIN_CONFIG_NAMES.length}`);
});

test('findLefthookConfigs also finds lefthook-local.yml, alongside a main config', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-lefthook-local-'));
  writeFileSync(join(repo, 'lefthook.yml'), '', 'utf8');
  writeFileSync(join(repo, 'lefthook-local.yml'), '', 'utf8');
  assert.deepEqual(findLefthookConfigs(repo), ['lefthook.yml', 'lefthook-local.yml']);
});

test('findLefthookConfigs returns empty when no lefthook config exists', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-lefthook-none-'));
  assert.deepEqual(findLefthookConfigs(repo), []);
});

test('every run: value in the rendered lefthook.yml is a valid YAML single-quoted scalar that unquotes to the shell command', () => {
  // Regression (step-6 real repro, 2026-09-23): `run: "$(git rev-parse --show-toplevel)"/serpens/…`
  // is a double-quoted scalar followed by trailing text — invalid YAML, so real `lefthook install`
  // refused every generated config. The fake lefthook in the suites never parsed YAML, so it hid this.
  const invocation = resolveCallRoute({ repoRoot: '/r', hasNodeModules: false }).invocation;
  for (const lang of ['en', 'ru']) {
    const runs = renderLefthook(invocation, lang).split('\n').filter((l) => /^\s*run:/.test(l));
    assert.equal(runs.length, 4);
    for (const line of runs) {
      const m = /^\s*run: '((?:[^']|'')*)'$/.exec(line);
      assert.ok(m, `not a single-quoted YAML scalar: ${line}`);
      assert.ok(m[1].replaceAll("''", "'").startsWith(invocation));
    }
  }
  assert.equal(yamlSingleQuote("it's"), "'it''s'");
});
