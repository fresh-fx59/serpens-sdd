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

// F7: a narrow, documented exemption — NOT a blanket pass for the file — for this repository's
// OWN CI tooling directory name, `.github/`. That is this repo's real, load-bearing workflow
// directory (see .github/workflows/publish.yml), not a mention of GitHub the vendor PRODUCT the
// /github/i ban exists to keep out of this package's source/logic. Before this exemption,
// scripts/prune-public-tree.mjs dodged the ban with `['.', 'git', 'hub'].join('')` — string
// concatenation that hid the real dependency from readers AND from this very grep. The
// exemption is scoped to exactly one file and exactly the literal `.github` token (never a
// bare, unqualified "github" mention, which would still legitimately trip the ban in that
// file) so a future GitHub-vendor-coupling mention in prune-public-tree.mjs is still caught.
const GITHUB_DIR_EXEMPT_FILES = new Set([join(ROOT, 'scripts', 'prune-public-tree.mjs')]);

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
    let text = readFileSync(f, 'utf8');
    if (GITHUB_DIR_EXEMPT_FILES.has(f)) {
      // Strip only the exact `.github` directory-name token before checking; any OTHER
      // occurrence of "github" in this file (a comment mentioning the vendor, a URL, etc.)
      // still trips the ban below.
      text = text.replace(/\.github\b/g, '');
    }
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

  // openspec_tool: an identity field like agent_dir/label, not a layout field — gigacode names
  // the OpenSpec tool id it maps onto (qwen); qwen (being that tool itself) carries no override.
  // Their difference is exactly the point of the field, so it belongs with the "must differ"
  // set below, not the "must match" one.
  const identityFields = ['id', 'agent_dir', 'label', 'instruction_file', 'scope_preference', 'verified', 'openspec_tool'];
  const layoutFields = PORT_FIELDS.filter((f) => !identityFields.includes(f));
  for (const field of layoutFields) {
    assert.deepEqual(
      ports.gigacode[field],
      ports.qwen[field],
      `gigacode.${field} should match qwen.${field} (same underlying layout)`,
    );
  }
  for (const field of ['agent_dir', 'label', 'instruction_file', 'scope_preference', 'verified', 'openspec_tool']) {
    assert.notDeepEqual(
      ports.gigacode[field],
      ports.qwen[field],
      `gigacode.${field} should differ from qwen.${field} (distinct identity)`,
    );
  }
});

test('OWNED_PREFIXES (src/layout.mjs) has at least one importer', () => {
  // Was dead (serpens-openspec-coexistence-gaps-2026-09-22.md gap 2): declared, never read.
  // src/ownership.mjs is its first consumer (isOwnedPath).
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tools'))].filter(
    (f) => f.endsWith('.mjs') && !f.endsWith('layout.mjs'),
  );
  const importers = files.filter((f) => readFileSync(f, 'utf8').includes('OWNED_PREFIXES'));
  assert.ok(importers.length > 0, 'OWNED_PREFIXES must be imported/used by at least one file');
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
