import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLayout, toolNames, exitCodeFor } from '../scripts/gen-ports.mjs';

test('classifies the four observed shapes', () => {
  assert.deepEqual(classifyLayout(['.qwen/commands/opsx-apply.md']),
    { agent_dir: '.qwen', command_dir: 'commands', command_layout: 'flat-prefixed', command_format: 'md', commands_supported: true });
  assert.equal(classifyLayout(['.claude/commands/opsx/apply.md']).command_layout, 'subdir');
  assert.equal(classifyLayout(['.gemini/commands/opsx/apply.toml']).command_format, 'toml');
  assert.equal(classifyLayout(['.agents/skills/openspec-propose/SKILL.md']).commands_supported, false);
});

test('the tool-name list is parsed from openspec --help, never hard-coded', async () => {
  const help = 'Use "all", "none", or a comma-separated list of: amazon-q, qwen, claude, agents.';
  assert.deepEqual(await toolNames({ helpText: help }), ['agents', 'amazon-q', 'claude', 'qwen']);
});

test('the CLI exit-code mapping honours an explicit err.exitCode, else falls back to 1', () => {
  assert.equal(exitCodeFor({ exitCode: 2 }), 2);
  assert.equal(exitCodeFor({ exitCode: 3 }), 3);
  assert.equal(exitCodeFor(new Error('unexpected')), 1);
});

test('classifies a deeply-nested command dir by where the files actually are (costrict shape)', () => {
  assert.deepEqual(classifyLayout(['.cospec/openspec/commands/opsx-sync.md']),
    { agent_dir: '.cospec', command_dir: 'openspec/commands', command_layout: 'flat-prefixed', command_format: 'md', commands_supported: true });
});
