import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveKitSource } from '../scripts/kit-source.mjs';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const suites = ['kit-version-test.sh', 'starter-contract-test.sh'];

for (const packageName of ['serpens-sdd-npm', 'npm']) {
  test(`release shell suites execute in the ${packageName} layout`, () => {
    const root = mkdtempSync(join(tmpdir(), 'serpens release layout '));
    try {
      mkdirSync(join(root, 'tests'));
      for (const file of [...suites, 'package-root.sh', 'preserved-public-docs.sh']) {
        const source = join(pkg, '..', 'tests', file);
        cpSync(source, join(root, 'tests', file));
      }
      cpSync(join(pkg, 'tools'), join(root, packageName, 'tools'), { recursive: true });
      cpSync(join(pkg, 'package.json'), join(root, packageName, 'package.json'));
      for (const lang of ['en', 'ru']) {
        const kit = join(root, lang);
        cpSync(resolveKitSource(lang), kit, { recursive: true });
        for (const suite of suites) {
          const result = spawnSync('bash', [join(root, 'tests', suite), kit], {
            cwd: tmpdir(), encoding: 'utf8', timeout: 60_000,
          });
          assert.equal(result.status, 0, `${packageName}/${lang}/${suite}\n${result.stdout}\n${result.stderr}`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('package discovery fails without a complete package and prefers the vault when both exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'serpens resolver '));
  try {
    mkdirSync(join(root, 'tests'));
    const helper = join(root, 'tests', 'package-root.sh');
    cpSync(join(pkg, '..', 'tests', 'package-root.sh'), helper);
    const resolve = () => spawnSync('bash', ['-c', 'source "$1"; serpens_package_root', 'resolver', helper], {
      cwd: tmpdir(), encoding: 'utf8',
    });
    for (const name of ['serpens-sdd-npm', 'npm']) mkdirSync(join(root, name, 'tools'), { recursive: true });
    const absent = resolve();
    assert.equal(absent.status, 1);
    assert.equal(absent.stdout, '');
    for (const name of ['serpens-sdd-npm', 'npm']) assert.ok(absent.stderr.includes(join(root, name)));
    for (const name of ['serpens-sdd-npm', 'npm']) writeFileSync(join(root, name, 'package.json'), '{}');
    const both = resolve();
    assert.equal(both.status, 0, both.stderr);
    // macOS resolves /tmp to /private/tmp; compare the final directory name.
    assert.ok(both.stdout.trim().endsWith('/serpens-sdd-npm'), both.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
