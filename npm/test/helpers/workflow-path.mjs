// Where the publish workflow lives, in either checkout.
//
// The workflow moves the same way the kit trees do, and for the same reason. In this vault it
// sits inside the package (`serpens-sdd-npm/.github/workflows/publish.yml`) because the package
// is a subdirectory of a larger repository; in the public repository it must live at the
// REPOSITORY root, one level ABOVE the package's own `npm/` — a workflow anywhere else simply
// never runs.
//
// This deliberately lives under `test/`, not `scripts/`: hygiene.test.mjs forbids any vendor
// product name in src/bin/scripts, and the literal path segment below is one. Dodging that gate
// by splicing the string together would be worse than keeping this helper on the test side,
// where the rule does not apply and the path can be written plainly.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve publish.yml in whichever of the two layouts this checkout is. Both locations are
 * accepted, package-local first, and a checkout with neither fails loudly naming BOTH — so the
 * workflow's own gate can never pass by quietly finding no file to check.
 * @param {string} pkgRoot the package directory
 * @returns {string} absolute path to publish.yml
 */
export function resolvePublishWorkflow(pkgRoot) {
  const tried = [
    join(pkgRoot, '.github', 'workflows', 'publish.yml'),
    join(pkgRoot, '..', '.github', 'workflows', 'publish.yml'),
  ];
  for (const p of tried) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'cannot locate the publish workflow: none of these paths exists:\n'
    + tried.map((p) => `  ${p}`).join('\n')
    + '\n  (inside the package while it is a subdirectory of a larger repository; at the '
    + 'repository root once the package IS the published repository\'s npm/ directory)',
  );
}
