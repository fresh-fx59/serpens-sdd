import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rowsToTsv, diffInventories, parseGitmodules, readGitmodules } from '../src/inventory.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GITMODULES = `[submodule "service-a"]
	path = submodules/service-a
	url = ssh://git@forge/acme/service-a.git
	branch = develop
`;

test('parses path, url and branch', () => {
  assert.deepEqual(parseGitmodules(GITMODULES),
    [{ name: 'service-a', url: 'ssh://git@forge/acme/service-a.git', base_branch: 'develop' }]);
});

test('rowsToTsv emits the name\\turl\\tbase_branch lines sync-submodules.sh --repos-from - reads', () => {
  const text = rowsToTsv(parseGitmodules(GITMODULES));
  assert.equal(text, 'service-a\tssh://git@forge/acme/service-a.git\tdevelop\n');
});

test('rowsToTsv of an empty row list is an empty string', () => {
  assert.equal(rowsToTsv([]), '');
});

test('a url disagreement is reported, not merged', () => {
  const a = parseGitmodules(GITMODULES);
  const b = [{ name: 'service-a', url: 'ssh://git@other/acme/service-a.git', base_branch: 'develop' }];
  const d = diffInventories(a, b);
  assert.equal(d.length, 1);
  assert.match(d[0], /service-a.*url/);
});

test('missing branch in parseGitmodules throws with exitCode 2', () => {
  const noBranch = `[submodule "service-a"]
	path = submodules/service-a
	url = ssh://git@forge/acme/service-a.git
`;
  assert.throws(() => parseGitmodules(noBranch), (err) => {
    return err.message.includes('missing branch') && err.exitCode === 2;
  });
});

test('missing path in parseGitmodules throws with exitCode 2', () => {
  const noPath = `[submodule "service-a"]
	url = ssh://git@forge/acme/service-a.git
	branch = develop
`;
  assert.throws(() => parseGitmodules(noPath), (err) => {
    return err.message.includes('missing path') && err.exitCode === 2;
  });
});

test('readGitmodules prefers git config when successful', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-'));
  const gitmodulesPath = join(tempDir, '.gitmodules');
  writeFileSync(gitmodulesPath, GITMODULES);

  const fakeRun = async (cmd, args, opts) => {
    // Simulate successful git config output
    return {
      code: 0,
      stdout: `submodule.service-a.path submodules/service-a
submodule.service-a.url ssh://git@forge/acme/service-a.git
submodule.service-a.branch develop
`,
      stderr: '',
    };
  };

  const rows = await readGitmodules(tempDir, { run: fakeRun });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'service-a');
  assert.equal(rows[0].url, 'ssh://git@forge/acme/service-a.git');
  assert.equal(rows[0].base_branch, 'develop');
});

test('readGitmodules falls back to raw text parsing on git config failure', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'serpens-sdd-'));
  const gitmodulesPath = join(tempDir, '.gitmodules');
  writeFileSync(gitmodulesPath, GITMODULES);

  const fakeRun = async (cmd, args, opts) => {
    // Simulate git config failure
    return {
      code: 128,
      stdout: '',
      stderr: 'fatal error',
    };
  };

  const rows = await readGitmodules(tempDir, { run: fakeRun });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'service-a');
  assert.equal(rows[0].url, 'ssh://git@forge/acme/service-a.git');
  assert.equal(rows[0].base_branch, 'develop');
});
