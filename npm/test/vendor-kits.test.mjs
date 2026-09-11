import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vendorKit, parseArgs, diff } from '../scripts/vendor-kits.mjs';

// Never against the real trees: every fixture below is a throwaway pair of directories.
function pair({ sourceFiles, targetFiles }) {
  const root = mkdtempSync(join(tmpdir(), 'serpens-sdd-vendor-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const writeAll = (dir, files) => {
    if (files === null) return;
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  };
  writeAll(source, sourceFiles);
  writeAll(target, targetFiles);
  return { source, target };
}

test('importing vendor-kits.mjs vendors nothing (the module is inert)', () => {
  // The import at the top of this file already happened; if it had run main(), the package's
  // own kits/ would have been touched. Assert both kits are still there and readable.
  assert.ok(readdirSync(new URL('../kits', import.meta.url)).sort().includes('en'));
});

test('a target that does not exist yet is vendored', () => {
  const { source, target } = pair({ sourceFiles: { 'VERSION': '2026-08-26.8\n' }, targetFiles: null });
  const r = vendorKit({ source, target });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'vendored');
  assert.equal(readFileSync(join(target, 'VERSION'), 'utf8'), '2026-08-26.8\n');
});

test('an identical target is left alone', () => {
  const files = { 'VERSION': '2026-08-26.8\n' };
  const { source, target } = pair({ sourceFiles: files, targetFiles: files });
  const r = vendorKit({ source, target });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'unchanged');
  assert.deepEqual(diff(source, target), []);
});

test('a differing target is REFUSED by default, naming every differing path, and nothing is written', () => {
  const { source, target } = pair({
    sourceFiles: { 'VERSION': '2026-08-26.9\n', 'NEW.md': 'new\n' },
    targetFiles: { 'VERSION': '2026-08-26.8\n' },
  });
  const r = vendorKit({ source, target });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'refused');
  assert.deepEqual(r.differing, ['NEW.md', 'VERSION']);
  assert.match(r.message, /refusing to vendor/);
  assert.match(r.message, /--resync/);
  // untouched
  assert.equal(readFileSync(join(target, 'VERSION'), 'utf8'), '2026-08-26.8\n');
  assert.deepEqual(readdirSync(target), ['VERSION']);
});

test('--resync overwrites the vendored copy from the source — the path an edition bump needs', () => {
  const { source, target } = pair({
    sourceFiles: { 'VERSION': '2026-08-26.9\n', 'NEW.md': 'new\n' },
    targetFiles: { 'VERSION': '2026-08-26.8\n' },
  });
  const r = vendorKit({ source, target, resync: true });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'resynced');
  assert.equal(readFileSync(join(target, 'VERSION'), 'utf8'), '2026-08-26.9\n');
  assert.equal(readFileSync(join(target, 'NEW.md'), 'utf8'), 'new\n');
  assert.deepEqual(diff(source, target), [], 'after a re-sync the trees must agree byte for byte');
  // the source is only ever read
  assert.deepEqual(readdirSync(source).sort(), ['NEW.md', 'VERSION']);
});

test('parseArgs accepts nothing or exactly --resync, and refuses a typo with exit 2', () => {
  assert.deepEqual(parseArgs([]), { resync: false });
  assert.deepEqual(parseArgs(['--resync']), { resync: true });
  assert.throws(() => parseArgs(['--resnyc']), (err) => {
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /--resnyc/);
    return true;
  });
});
