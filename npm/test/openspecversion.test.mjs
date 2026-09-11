import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_MINORS, parseOpenspecVersion, classifyOpenspecVersion, capabilitiesFor,
} from '../src/openspecversion.mjs';

test('SUPPORTED_MINORS is exactly the three latest minors, newest first', () => {
  assert.deepEqual(SUPPORTED_MINORS, ['1.13', '1.12', '1.11']);
});

test('parseOpenspecVersion parses a bare version line', () => {
  assert.deepEqual(parseOpenspecVersion('1.12.0'), { major: 1, minor: 12, patch: 0, raw: '1.12.0' });
});

test('parseOpenspecVersion tolerates surrounding text and a trailing newline', () => {
  assert.deepEqual(parseOpenspecVersion('openspec v1.13.0\n'), { major: 1, minor: 13, patch: 0, raw: '1.13.0' });
});

test('parseOpenspecVersion returns null for unparseable text', () => {
  assert.equal(parseOpenspecVersion(''), null);
  assert.equal(parseOpenspecVersion('not a version'), null);
  assert.equal(parseOpenspecVersion(undefined), null);
});

test('classifyOpenspecVersion accepts every supported minor', () => {
  for (const minor of SUPPORTED_MINORS) {
    const r = classifyOpenspecVersion(`${minor}.0`);
    assert.equal(r.ok, true);
    assert.equal(r.minorKey, minor);
  }
});

test('classifyOpenspecVersion rejects an out-of-window version, naming it and the window', () => {
  const r = classifyOpenspecVersion('1.2.3');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported');
  assert.equal(r.minorKey, '1.2');
  assert.deepEqual(r.supported, SUPPORTED_MINORS);
});

test('classifyOpenspecVersion rejects unparseable output', () => {
  const r = classifyOpenspecVersion('garbage');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable');
  assert.deepEqual(r.supported, SUPPORTED_MINORS);
});

test('capabilitiesFor returns a frozen, documented-empty object', () => {
  const caps = capabilitiesFor('1.13');
  assert.deepEqual(caps, {});
  assert.ok(Object.isFrozen(caps));
});
