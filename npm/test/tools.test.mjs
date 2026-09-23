import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { TOOL_COMMANDS, toolPath, resolveTool, buildCommandTable } from '../src/cli/tools.mjs';

test('every subcommand points at a shipped script', () => {
  // 'verify-docs' is deliberately NOT here: it is the one subcommand implemented in the CLI
  // layer (src/cli/verify-docs.mjs) rather than wrapped from a vendored script — see
  // buildCommandTable's own comment and test/verify-docs.test.mjs.
  assert.equal(Object.keys(TOOL_COMMANDS).length, 10);
  for (const name of Object.keys(TOOL_COMMANDS)) assert.ok(existsSync(toolPath(name)), name);
});

test('arguments pass through untouched', () => {
  const { cmd, args } = resolveTool('state', ['prepare-base', '--repo', '/r', '--base', 'develop']);
  assert.match(args.join(' '), /prepare-base --repo \/r --base develop/);
  assert.ok(cmd === 'bash' || cmd === process.execPath);
});

test('every TOOL_COMMANDS key is dispatchable: buildCommandTable (used by bin/serpens-sdd.mjs) registers all of them, no hand-kept second list to drift', () => {
  const table = buildCommandTable();
  assert.equal(table.help, 'help.mjs');
  assert.equal(table['verify-docs'], 'verify-docs.mjs');
  // 'uninstall' (step 7, gap 6): the reverse of `init`, same CLI-layer pattern as verify-docs.
  assert.equal(table.uninstall, 'uninstall.mjs');
  // 'opsx-sync' (spec-openspec-coexistence-2026-09-22.md): re-syncs a relocated port's OpenSpec
  // artifacts, same CLI-layer pattern as uninstall/verify-docs.
  assert.equal(table['opsx-sync'], 'opsx-sync.mjs');
  for (const name of Object.keys(TOOL_COMMANDS)) {
    assert.equal(table[name], 'tools.mjs', `${name} missing from buildCommandTable()`);
  }
  // and nothing extra: table has exactly TOOL_COMMANDS' keys plus 'help', 'verify-docs',
  // 'uninstall', 'opsx-sync'
  assert.equal(Object.keys(table).length, Object.keys(TOOL_COMMANDS).length + 4);
});

test('a name not in TOOL_COMMANDS fails cleanly from toolPath, not silently', () => {
  assert.throws(() => toolPath('no-such-tool'), /unknown tool subcommand/);
  assert.throws(() => resolveTool('no-such-tool', []), /unknown tool subcommand/);
});

test('toolPath resolves against the package tools dir, not a vendored kit', () => {
  const p = toolPath('state');
  assert.ok(p.endsWith('/tools/repository-state.sh'), p);
  assert.ok(!p.includes('/kits/'), `toolPath must not reach into kits/: ${p}`);
  assert.ok(existsSync(p), `${p} must exist`);
});

test('toolPath ignores lang: the executables are language-neutral', () => {
  assert.equal(toolPath('lint', 'ru'), toolPath('lint', 'en'));
});

test('every TOOL_COMMANDS entry exists on disk', () => {
  for (const name of Object.keys(TOOL_COMMANDS)) {
    if (name === 'verify-docs') continue;   // package-implemented, no script
    assert.ok(existsSync(toolPath(name)), `${name} -> ${toolPath(name)} missing`);
  }
});
