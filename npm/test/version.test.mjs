import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editionToSemver, semverToEdition } from '../src/version.mjs';

test('maps a kit edition to semver', () => {
  assert.equal(editionToSemver('2026-08-26.8'), '1.20260826.8');
  assert.equal(editionToSemver('2026-01-02.0'), '1.20260102.0');
});

test('round-trips', () => {
  assert.equal(semverToEdition('1.20260826.8'), '2026-08-26.8');
});

test('rejects a malformed edition', () => {
  assert.throws(() => editionToSemver('2026-8-26.8'), /edition/);
  assert.throws(() => editionToSemver('2026-08-26'), /edition/);
});
