import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildKitArchive } from '../scripts/release.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'serpens-release-zip-'));
  const source = join(root, 'kit');
  mkdirSync(source);
  writeFileSync(join(source, 'kept.txt'), 'kept\n');
  writeFileSync(join(source, 'retired.txt'), 'retired\n');
  return { root, source, archive: join(root, 'kit.zip') };
}

function archiveNames(archive) {
  return execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').sort();
}

test('rebuild removes files retired from the source tree', async () => {
  const { root, source, archive } = fixture();
  execFileSync('zip', ['-q', archive, 'retired.txt'], { cwd: source });
  // zip's update mode would leave this old entry behind; the helper must rebuild from scratch.
  unlinkSync(join(source, 'retired.txt'));
  const { code } = await rebuildKitArchive({ sourceDir: source, archivePath: archive });
  assert.equal(code, 0);
  assert.deepEqual(archiveNames(archive), ['kept.txt']);
  assert.equal(readFileSync(join(root, 'kit.zip')).length > 0, true);
});

test('rebuild keeps the existing archive when zip fails', async () => {
  const { source, archive } = fixture();
  writeFileSync(archive, 'known-good archive\n');
  const before = readFileSync(archive);
  const result = await rebuildKitArchive({
    sourceDir: source,
    archivePath: archive,
    runCommand: async () => ({ code: 1, stdout: '', stderr: 'synthetic zip failure' }),
  });
  assert.equal(result.code, 1);
  assert.deepEqual(readFileSync(archive), before);
});

test('dry-run does not create or replace an archive', async () => {
  const { source, archive } = fixture();
  let invoked = false;
  const result = await rebuildKitArchive({
    sourceDir: source,
    archivePath: archive,
    dryRun: true,
    runCommand: async () => { invoked = true; return { code: 0 }; },
  });
  assert.equal(result.dryRun, true);
  assert.equal(invoked, false);
  assert.equal(existsSync(archive), false);
});
