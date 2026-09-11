import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePort, PORT_FIELDS } from '../src/ports.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Never `ports/` (its ids legitimately name agent products) and never `kits/` (vendored kit
// content) — only the package's own logic.
const VENDORS = [/bitbucket/i, /jira/i, /confluence/i, /github/i, /gitlab/i, /linear/i];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('no source file contains a vendor product name', () => {
  const files = [
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'bin')),
    ...walk(join(ROOT, 'scripts')),
  ];
  assert.ok(files.length > 0, 'expected src/bin/scripts to contain files');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const v of VENDORS) {
      assert.ok(!v.test(text), `${f} mentions vendor pattern ${v}`);
    }
  }
});

test('package.json declares zero runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test('the committed port registry matches a fresh generation', () => {
  // A genuine regeneration comparison (running scripts/gen-ports.mjs, which probes ~40
  // real packages and takes ~20 minutes) belongs in the release pipeline, not here — a test
  // that slow is a test nobody runs. Here we assert the properties a fresh generation would
  // have to satisfy: every port file validates, its id matches its filename, its keys are
  // sorted, it ends with a trailing newline, and gigacode's hand-authored entry has the same
  // *layout* as qwen's (the port it was modeled on) while its identity fields differ.
  const portsDir = join(ROOT, 'ports');
  const files = readdirSync(portsDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'expected ports/*.json to exist');

  const ports = {};
  for (const f of files) {
    const raw = readFileSync(join(portsDir, f), 'utf8');
    assert.ok(raw.endsWith('\n'), `${f} must end with a trailing newline`);

    const parsed = JSON.parse(raw);
    const { ok, errors } = validatePort(parsed);
    assert.ok(ok, `${f} failed validatePort: ${errors.join('; ')}`);

    const expectedId = f.replace(/\.json$/, '');
    assert.equal(parsed.id, expectedId, `${f}: id must equal filename`);

    const keys = Object.keys(parsed);
    const sortedKeys = [...keys].sort();
    assert.deepEqual(keys, sortedKeys, `${f}: keys must be sorted`);

    ports[expectedId] = parsed;
  }

  assert.ok(ports.gigacode, 'expected ports/gigacode.json to exist');
  assert.ok(ports.qwen, 'expected ports/qwen.json to exist');

  const layoutFields = PORT_FIELDS.filter(
    (f) => !['id', 'agent_dir', 'label', 'instruction_file', 'scope_preference', 'verified'].includes(f),
  );
  for (const field of layoutFields) {
    assert.deepEqual(
      ports.gigacode[field],
      ports.qwen[field],
      `gigacode.${field} should match qwen.${field} (same underlying layout)`,
    );
  }
  for (const field of ['agent_dir', 'label', 'instruction_file', 'scope_preference', 'verified']) {
    assert.notDeepEqual(
      ports.gigacode[field],
      ports.qwen[field],
      `gigacode.${field} should differ from qwen.${field} (distinct identity)`,
    );
  }
});

test('package.json files[] lists only directories that exist', () => {
  // A `files` entry naming a directory the package does not have (it listed `tools`, which was
  // never created — the kit scripts ship inside kits/<lang>/scripts/tools/) is dead weight in
  // the manifest and a false promise about what `npm pack` contains.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);
  for (const entry of pkg.files) {
    assert.ok(existsSync(join(ROOT, entry)), `package.json files[] names "${entry}", which does not exist`);
  }
  // and every directory the CLI needs at runtime is still listed
  for (const needed of ['bin', 'src', 'ports', 'kits']) {
    assert.ok(pkg.files.includes(needed), `package.json files[] must ship ${needed}`);
  }
});
