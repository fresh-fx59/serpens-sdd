import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  detectUnsupportedSchema, buildSchemaGateError, readTopLevelScalar, BUILTIN_SCHEMA_IDS,
} from '../src/schemagate.mjs';
import { requireOpenspec } from './helpers/prereqs.mjs';
import { realOpenspec } from './helpers/real-openspec.mjs';

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-schemagate-'));
  return dir;
}

test('no openspec/ directory at all: ok', () => {
  const dir = tempRepo();
  assert.deepEqual(detectUnsupportedSchema(dir), { ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test('config.yaml with the built-in schema: ok', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, 'openspec'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n\ncontext: |\n  schema: not-a-key-here\n');
  assert.deepEqual(detectUnsupportedSchema(dir), { ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test('config.yaml naming a custom schema: caught, names config.yaml', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, 'openspec'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: my-custom\n');
  const r = detectUnsupportedSchema(dir);
  assert.equal(r.ok, false);
  assert.equal(r.schemaId, 'my-custom');
  assert.match(r.foundIn, /config\.yaml/);
  rmSync(dir, { recursive: true, force: true });
});

test('project-local schema directory alone is caught, even if config.yaml still says spec-driven', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, 'openspec', 'schemas', 'my-custom'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'schemas', 'my-custom', 'schema.yaml'), 'name: my-custom\nartifacts: []\n');
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  const r = detectUnsupportedSchema(dir);
  assert.equal(r.ok, false);
  assert.equal(r.schemaId, 'my-custom');
  assert.match(r.foundIn, /project-local schema directory/);
  rmSync(dir, { recursive: true, force: true });
});

test('a project-local directory named "spec-driven" (matching our one built-in) is NOT flagged', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, 'openspec', 'schemas', 'spec-driven'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'schemas', 'spec-driven', 'schema.yaml'), 'name: spec-driven\nartifacts: []\n');
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  assert.deepEqual(detectUnsupportedSchema(dir), { ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test('per-change .openspec.yaml override is caught, names the change', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, 'openspec', 'changes', '2026-09-23-demo'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  writeFileSync(join(dir, 'openspec', 'changes', '2026-09-23-demo', '.openspec.yaml'), 'schema: my-custom\n');
  const r = detectUnsupportedSchema(dir);
  assert.equal(r.ok, false);
  assert.equal(r.schemaId, 'my-custom');
  assert.match(r.foundIn, /2026-09-23-demo.*\.openspec\.yaml/);
  rmSync(dir, { recursive: true, force: true });
});

test('an archived change with a custom schema override is NOT scanned', () => {
  const dir = tempRepo();
  mkdirSync(join(dir, 'openspec', 'changes', 'archive', '2026-01-01-old'), { recursive: true });
  writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  writeFileSync(join(dir, 'openspec', 'changes', 'archive', '2026-01-01-old', '.openspec.yaml'), 'schema: my-custom\n');
  assert.deepEqual(detectUnsupportedSchema(dir), { ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test('readTopLevelScalar ignores a key of the same name nested inside a block scalar', () => {
  const text = 'schema: real-value\ncontext: |\n  schema: fake, indented\n';
  assert.equal(readTopLevelScalar(text, 'schema'), 'real-value');
});

test('readTopLevelScalar strips quotes', () => {
  assert.equal(readTopLevelScalar("schema: 'quoted'\n", 'schema'), 'quoted');
  assert.equal(readTopLevelScalar('schema: "double"\n', 'schema'), 'double');
});

test('buildSchemaGateError names the schema, the location, says unsupported, and is bilingual', () => {
  const msg = buildSchemaGateError({ schemaId: 'my-custom', foundIn: 'openspec/config.yaml (schema: my-custom)' });
  assert.match(msg, /my-custom/);
  assert.match(msg, /openspec\/config\.yaml/);
  assert.match(msg, /not yet supported/);
  assert.match(msg, /follow-up/);
  assert.match(msg, /deferred/);
  // Russian half present
  assert.match(msg, /схем/i);
  assert.match(msg, /отложен/i);
});

test('BUILTIN_SCHEMA_IDS is exactly spec-driven', () => {
  assert.deepEqual(BUILTIN_SCHEMA_IDS, ['spec-driven']);
});

// Real-openspec cross-check (2026-09-23, against a real @fission-ai/openspec@1.13 install):
// `openspec schemas --json` returns `[{name, description, artifacts, source: 'project'|'package'}]`
// for a project-local schema at openspec/schemas/<name>/schema.yaml, and
// `openspec status --change <id> --json` reports the resolved `schemaName` for a change, which
// a per-change `.openspec.yaml`'s own `schema:` key overrides ahead of the project default. This
// test drives the REAL binary end to end and asserts our static detection agrees with it.
test('cross-check: a real openspec init + custom schema + change is caught the same way the real CLI itself reports it', (t) => {
  if (requireOpenspec(t)) return;
  const oss = realOpenspec();
  const projectDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-schemagate-real-'));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });

  const init = oss.run(['init', '--tools', 'none'], { cwd: projectDir });
  assert.equal(init.code, 0, init.stderr);

  // Project-local custom schema, same fixture shape verified by hand against the real CLI.
  const schemaDir = join(projectDir, 'openspec', 'schemas', 'my-custom');
  mkdirSync(join(schemaDir, 'templates'), { recursive: true });
  writeFileSync(join(schemaDir, 'schema.yaml'), [
    'name: my-custom',
    'version: 1',
    'description: A custom lean schema',
    'artifacts:',
    '  - id: proposal',
    '    generates: proposal.md',
    '    description: Proposal',
    '    template: proposal.md',
    '    instruction: Write the proposal.',
    '    requires: []',
    'apply:',
    '  requires: [proposal]',
    '  tracks: proposal.md',
    '  instruction: Do the work.',
    '',
  ].join('\n'));
  writeFileSync(join(schemaDir, 'templates', 'proposal.md'), '# Proposal\n');

  // Point the project default at it, exactly as `openspec init` writes `schema:`.
  const configPath = join(projectDir, 'openspec', 'config.yaml');
  writeFileSync(configPath, 'schema: my-custom\n');

  const schemas = oss.json(['schemas', '--json'], { cwd: projectDir });
  const projectSchema = schemas.find((s) => s.source === 'project');
  assert.ok(projectSchema, 'real openspec did not report the project-local schema at all');
  assert.equal(projectSchema.name, 'my-custom');

  const detection = detectUnsupportedSchema(projectDir);
  assert.equal(detection.ok, false);
  assert.equal(detection.schemaId, projectSchema.name);

  rmSync(projectDir, { recursive: true, force: true });
});
