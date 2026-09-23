import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Real repro (2026-09-23, contabo, real `npm install` of a packed tarball into a throwaway
// repo-local install): stage 5 (onboard) threw `ENOENT` copying
// `kits/en/system-store-template/.gitignore` into the target repo. Root cause: `npm pack`
// silently drops any file NAMED `.gitignore` (and `.npmignore`) from the tarball — npm treats
// those filenames as its OWN ignore-file convention regardless of the package.json `files`
// list, so the kit template never reached a real npm-installed package even though it exists on
// disk and every fixture-based test (which reads kits straight off disk, never through `npm
// pack`) stayed green. Fix: the shipped template is named `gitignore.template` (no leading dot)
// everywhere — `src/stages/stage5-onboard.mjs`, `src/cli/uninstall.mjs`, kit docs — and only the
// file WRITTEN into the target repo is called `.gitignore`. This test packs the real tarball
// (the only way to see npm's own exclusion) and asserts the template survives, and that nothing
// under `kits/` is ever again named `.gitignore` verbatim (the one shape `npm pack` cannot
// ship).
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function packFileList() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG_ROOT, encoding: 'utf8' });
  const [{ files }] = JSON.parse(out);
  return files.map((f) => f.path);
}

test('a real `npm pack` ships kits/**/gitignore.template, not a bare .gitignore', () => {
  const paths = packFileList();
  const literalDotGitignore = paths.filter((p) => p.startsWith('kits/') && p.endsWith('/.gitignore'));
  assert.deepEqual(
    literalDotGitignore, [],
    `npm pack silently drops these (rename to gitignore.template): ${literalDotGitignore.join(', ')}`,
  );
  const templates = paths.filter((p) => p.endsWith('system-store-template/gitignore.template'));
  assert.ok(
    templates.length >= 2, // kits/en + kits/ru
    `expected gitignore.template under both kit languages' system-store-template, got: ${JSON.stringify(paths.filter((p) => p.includes('system-store-template')))}`,
  );
});

test('stage5-onboard and uninstall source no longer reference a literal .gitignore kit source path', () => {
  const stage5Src = execFileSync('cat', [join(PKG_ROOT, 'src/stages/stage5-onboard.mjs')], { encoding: 'utf8' });
  const uninstallSrc = execFileSync('cat', [join(PKG_ROOT, 'src/cli/uninstall.mjs')], { encoding: 'utf8' });
  assert.equal(/system-store-template['"], ['"]\.gitignore['"]\)/.test(stage5Src), false);
  assert.equal(/system-store-template['"], ['"]\.gitignore['"]\)/.test(uninstallSrc), false);
});
