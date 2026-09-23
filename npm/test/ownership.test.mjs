import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isOwnedChange, ownedChanges, isOwnedPath, CHANGE_MARKER_FIRST_LINE } from '../src/ownership.mjs';

function tmpRepo() {
  return mkdtempSync(join(tmpdir(), 'serpens-ownership-'));
}

function writeMarker(dir, extra = '') {
  writeFileSync(
    join(dir, '.serpens.yaml'),
    `${CHANGE_MARKER_FIRST_LINE}\nowner: serpens-sdd\nticket: ABCD-1234\nbranch: feature/ABCD-1234\ncreated: 2026-09-22\n${extra}`,
  );
}

test('isOwnedChange: true when .serpens.yaml declares owner serpens-sdd', () => {
  const root = tmpRepo();
  const changeDir = join(root, 'openspec', 'changes', 'abcd-1234-x');
  mkdirSync(changeDir, { recursive: true });
  writeMarker(changeDir);
  assert.equal(isOwnedChange(changeDir), true);
});

test('isOwnedChange: false when no .serpens.yaml is present (vanilla change)', () => {
  const root = tmpRepo();
  const changeDir = join(root, 'openspec', 'changes', 'vanilla-1');
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, '.openspec.yaml'), 'schema: 1\n');
  writeFileSync(join(changeDir, 'proposal.md'), '# proposal\n');
  assert.equal(isOwnedChange(changeDir), false);
});

test('isOwnedChange: false when .serpens.yaml exists but owner is not serpens-sdd', () => {
  const root = tmpRepo();
  const changeDir = join(root, 'openspec', 'changes', 'weird-1');
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, '.serpens.yaml'), `${CHANGE_MARKER_FIRST_LINE}\nowner: someone-else\n`);
  assert.equal(isOwnedChange(changeDir), false);
});

test('isOwnedChange: false when the change dir does not exist', () => {
  const root = tmpRepo();
  assert.equal(isOwnedChange(join(root, 'openspec', 'changes', 'missing')), false);
});

test('ownedChanges: finds a marked change under changes/ and under changes/archive/', () => {
  const root = tmpRepo();
  const active = join(root, 'openspec', 'changes', 'abcd-1234-a');
  const archived = join(root, 'openspec', 'changes', 'archive', '2026-09-22-abcd-1234-b');
  const vanilla = join(root, 'openspec', 'changes', 'vanilla-1');
  mkdirSync(active, { recursive: true });
  mkdirSync(archived, { recursive: true });
  mkdirSync(vanilla, { recursive: true });
  writeMarker(active);
  writeMarker(archived);
  const found = ownedChanges(root).sort();
  assert.deepEqual(found, [archived, active].sort());
});

test('isOwnedPath: true under an OWNED_PREFIXES entry (serpens/)', () => {
  const root = tmpRepo();
  mkdirSync(join(root, 'serpens'), { recursive: true });
  assert.equal(isOwnedPath('serpens/index.json', root), true);
});

test('isOwnedPath: true under a marked change dir', () => {
  const root = tmpRepo();
  const changeDir = join(root, 'openspec', 'changes', 'abcd-1234-c');
  mkdirSync(changeDir, { recursive: true });
  writeMarker(changeDir);
  assert.equal(isOwnedPath('openspec/changes/abcd-1234-c/proposal.md', root), true);
});

test('isOwnedPath: false under an unmarked change dir and outside owned prefixes', () => {
  const root = tmpRepo();
  const changeDir = join(root, 'openspec', 'changes', 'vanilla-2');
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'proposal.md'), '# proposal\n');
  assert.equal(isOwnedPath('openspec/changes/vanilla-2/proposal.md', root), false);
  assert.equal(isOwnedPath('README.md', root), false);
});

test('JS (ownership.mjs) and shell (ownership.sh) agree on a fixture tree', () => {
  const root = tmpRepo();
  const owned = join(root, 'openspec', 'changes', 'abcd-1234-d');
  const vanilla = join(root, 'openspec', 'changes', 'vanilla-3');
  mkdirSync(owned, { recursive: true });
  mkdirSync(vanilla, { recursive: true });
  writeMarker(owned);
  writeFileSync(join(vanilla, '.openspec.yaml'), 'schema: 1\n');
  mkdirSync(join(root, 'serpens'), { recursive: true });

  const shLib = new URL('../tools/lib/ownership.sh', import.meta.url).pathname;
  const cases = [
    ['serpens/index.json', true],
    ['openspec/changes/abcd-1234-d/proposal.md', true],
    ['openspec/changes/vanilla-3/proposal.md', false],
    ['README.md', false],
  ];
  for (const [relPath, expected] of cases) {
    const jsAnswer = isOwnedPath(relPath, root);
    const shOut = execFileSync(
      'bash',
      ['-c', `source "${shLib}" && is_owned_path "$1" "$2" && echo yes || echo no`, '--', relPath, root],
    ).toString().trim();
    assert.equal(jsAnswer, shOut === 'yes', `mismatch for ${relPath}: js=${jsAnswer} sh=${shOut}`);
  }
});
