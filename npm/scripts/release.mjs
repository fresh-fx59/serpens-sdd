#!/usr/bin/env node
// scripts/release.mjs — the serpens-sdd npm package release pipeline.
//
// Runs, in order, stopping on the first failure: restamp both vault kit trees, the kit
// acceptance suites (against both kits) plus the bin parity gate (run once, against the
// package's own bin/serpens-sdd.mjs), the zip rebuild, `kit-version.sh verify`,
// `vendor-kits.mjs --resync`, `gen-ports.mjs`, `node --test`, and a final assertion that
// package.json's version/edition and both kits' VERSION agree under `editionToSemver`.
//
// It NEVER publishes, pushes or tags. The `npm publish --access public` command is only
// printed — unpublish has a 72-hour window, so the publish stays a deliberate human keystroke.
//
// Nothing here reaches the network except `gen-ports.mjs`, which shells out to `npx` to probe
// real agent-CLI packages; that step alone can take ~20 minutes.
//
// Usage:
//   node scripts/release.mjs            run the full pipeline (stops before npm publish)
//   node scripts/release.mjs --dry-run  print the ordered checklist only, run nothing

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.mjs';
import { editionToSemver } from '../src/version.mjs';
import { SUPPORTED_MINORS } from '../src/openspecversion.mjs';

// The exact OpenSpec CLI the release probes agent ports against. Full x.y.z on purpose (see the
// gen-ports step below) and kept inside SUPPORTED_MINORS[0] by test/release.test.mjs.
const OPENSPEC_PROBE_VERSION = '1.13.0';
import { resolveKitSource } from './kit-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const VAULT_ROOT = join(PKG_ROOT, '..'); // content/enterprise-sdd-agents/
const TESTS_DIR = join(VAULT_ROOT, 'tests');

// Kit directories are RESOLVED, not spelled: this vault names them `serpens-sdd-starter` and
// `serpens-sdd-starter-ru`, the public repository names the same trees `en/` and `ru/`. The zip
// FILENAMES stay fixed in both layouts — they are the published artifact names.
const KITS = [
  { name: 'en', dir: resolveKitSource('en'), zip: join(VAULT_ROOT, 'serpens-sdd-starter-en.zip') },
  { name: 'ru', dir: resolveKitSource('ru'), zip: join(VAULT_ROOT, 'serpens-sdd-starter-ru.zip') },
];

// Suites that take the kit root itself.
const KIT_ROOT_SUITES = ['starter-contract-test.sh', 'kit-version-test.sh'];

// Suites that take the path to the package's own bin entry point, and run ONCE — not once per
// kit — because they exercise the package's dispatcher against a reference pinned in git
// history (see tools-parity-test.sh's resolve_ref_commit), not either kit tree directly.
const BIN_SUITES = ['tools-parity-test.sh'];

// Suites that take the path to one specific tool inside the package's own `tools/` — a
// single shared copy now serves both kits (the eleven scripts are language-neutral), so these
// suites necessarily run once per kit against the SAME target path; that redundancy is
// deliberate here, not a bug — see buildSteps below.
const TOOL_SUITES = {
  'serpens-lint-test.sh': 'serpens-lint.mjs',
  'repository-state-test.sh': 'repository-state.sh',
  'sync-submodules-test.sh': 'sync-submodules.sh',
  'index-all-submodules-test.sh': 'index-all.sh',
  'aggregate-submodules-test.sh': 'aggregate-index.mjs',
  'split-brain-window-test.sh': 'check-contract-split-brain.mjs',
  'git-naming-ownership-test.sh': 'check-git-naming.sh',
  // verify-docs-path-test.sh retired: it tested verify-docs.sh, which Task 3 deleted (the
  // package reimplements verify-docs in src/cli/verify-docs.mjs). Coverage now lives in the
  // package's own test/verify-docs.test.mjs and the parity gate's verify-docs cases.
};

/**
 * Discover the kit acceptance suites by globbing `*-test.sh` in TESTS_DIR — never a hard-coded
 * list — so a suite added to `content/enterprise-sdd-agents/tests/` tomorrow is picked up
 * automatically instead of silently skipped. Throws loudly if a discovered suite has no entry
 * in KIT_ROOT_SUITES or TOOL_SUITES, forcing a deliberate decision about its argument shape
 * rather than dropping it from the release gate.
 * @returns {string[]} suite filenames, sorted
 */
export function discoverSuites() {
  const suites = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('-test.sh'))
    .sort();
  assertAllMapped(suites);
  return suites;
}

/**
 * Throw loudly if any suite name has no entry in KIT_ROOT_SUITES or TOOL_SUITES — pulled out of
 * discoverSuites so the fail-loud behaviour can be tested directly, without needing a real
 * on-disk directory of scripts.
 * @param {string[]} suites
 */
export function assertAllMapped(suites) {
  const unmapped = suites.filter(
    (s) => !KIT_ROOT_SUITES.includes(s) && !(s in TOOL_SUITES) && !BIN_SUITES.includes(s),
  );
  if (unmapped.length > 0) {
    throw new Error(
      `discovered suite(s) with no argument mapping in release.mjs — add each to KIT_ROOT_SUITES ` +
      `(if it takes the kit root), TOOL_SUITES (if it takes one tool file's path), or BIN_SUITES ` +
      `(if it takes the package's bin entry point): ${unmapped.join(', ')}`,
    );
  }
}

/**
 * Build the ordered list of {label, exec} steps that make up the release pipeline.
 * `exec` returns a Promise<{code, stdout, stderr}> (or the dryRun shape from src/run.mjs).
 * @param {{dryRun: boolean}} opts
 * @returns {Array<{label: string, exec: () => Promise<{code:number}>}>}
 */
export function buildSteps({ dryRun }) {
  const steps = [];

  steps.push({
    label: 'stamp both vault kit trees (tests/stamp-kit.py)',
    exec: () => run('python3', [join(TESTS_DIR, 'stamp-kit.py'), ...KITS.map((k) => k.dir)], { dryRun, cwd: VAULT_ROOT }),
  });

  for (const suite of discoverSuites()) {
    if (BIN_SUITES.includes(suite)) {
      steps.push({
        label: `${suite} (bin/serpens-sdd.mjs)`,
        exec: () => run('bash', [join(TESTS_DIR, suite), join(PKG_ROOT, 'bin', 'serpens-sdd.mjs')], { dryRun, cwd: VAULT_ROOT }),
      });
      continue;
    }
    if (suite in TOOL_SUITES) {
      // TOOL_SUITES targets resolve into the package's own tools/, not into either kit: the ten
      // scripts moved there and there is now exactly ONE shared copy (Task 3). Running the suite
      // once per kit against the SAME target asserted nothing extra and made the release log
      // imply per-kit coverage that no longer exists (controller ruling, 2026-09-08) — so, like
      // BIN_SUITES, this runs exactly once per release, not once per kit.
      steps.push({
        label: `${suite} (tools/${TOOL_SUITES[suite]})`,
        exec: () => run('bash', [join(TESTS_DIR, suite), join(PKG_ROOT, 'tools', TOOL_SUITES[suite])], { dryRun, cwd: VAULT_ROOT }),
      });
      continue;
    }
    // KIT_ROOT_SUITES genuinely differ per kit (each kit has its own root, VERSION, MANIFEST),
    // so these stay inside the per-kit loop.
    for (const kit of KITS) {
      steps.push({
        label: `${suite} (${kit.name})`,
        exec: () => run('bash', [join(TESTS_DIR, suite), kit.dir], { dryRun, cwd: VAULT_ROOT }),
      });
    }
  }

  for (const kit of KITS) {
    steps.push({
      label: `rebuild ${kit.name} zip (${kit.zip})`,
      exec: () => run('zip', ['-r', '-X', kit.zip, '.'], { dryRun, cwd: kit.dir }),
    });
  }

  for (const kit of KITS) {
    steps.push({
      label: `kit-version.sh verify (${kit.name})`,
      // kit-version.sh now ships from the package's own tools/, not from inside the kit, and
      // --root is required (Task 3's hazard fix removed the location-relative fallback).
      exec: () => run('bash', [join(PKG_ROOT, 'tools', 'kit-version.sh'), 'verify', '--root', kit.dir], { dryRun, cwd: kit.dir }),
    });
  }

  // `--resync` is required here, and only here: the stamping step above has just rewritten both
  // vault kit trees, so the vendored copies are ALWAYS behind by this point. Without an explicit
  // re-sync path, vendor-kits.mjs's refusal ("already exists and differs") stopped every edition
  // bump until someone deleted `kits/` by hand. A direct `node scripts/vendor-kits.mjs` still
  // refuses, so only this deliberate step overwrites.
  steps.push({
    label: 'vendor-kits.mjs --resync (re-sync kits/en, kits/ru from the freshly stamped vault trees)',
    exec: () => run(process.execPath, [join(PKG_ROOT, 'scripts', 'vendor-kits.mjs'), '--resync'], { dryRun, cwd: PKG_ROOT }),
  });

  // gen-ports.mjs REQUIRES `--openspec "<invocation>"` — without it it prints a usage line and
  // exits 2, which is exactly what this step did (invoked with no arguments at all), making the
  // pipeline unable to reach completion and the publish job's central precondition
  // unsatisfiable.
  //
  // The pin must be a FULL x.y.z. gen-ports.mjs reads the probed version straight out of this
  // string and stamps it into every port's `verified` field; a two-component range like `@1.13`
  // installs correctly and then writes "openspec unknown" into all 39 files, destroying the
  // registry's provenance without failing anything. OPENSPEC_PROBE_VERSION is asserted against
  // SUPPORTED_MINORS[0] in test/release.test.mjs, so the pin cannot drift out of the support
  // window silently — TO BUMP: change it alongside SUPPORTED_MINORS.
  const genPortsArgv = [
    join(PKG_ROOT, 'scripts', 'gen-ports.mjs'),
    '--openspec', `npx --yes @fission-ai/openspec@${OPENSPEC_PROBE_VERSION}`,
  ];
  steps.push({
    label: 'gen-ports.mjs (regenerate ports/*.json against real agent CLIs; ~20 min, network)',
    // argv is exposed so the arguments are assertable without a 20-minute real run.
    argv: genPortsArgv,
    exec: () => run(process.execPath, genPortsArgv, { dryRun, cwd: PKG_ROOT }),
  });

  // Exactly what `npm test` runs — read out of package.json rather than restated, because the
  // restated form had already drifted: `node --test test/` makes the Node 22 runner resolve a
  // bare directory as a module and die with "Cannot find module .../test", so this step could
  // never pass. Reading the declared script means the two cannot diverge again.
  const declaredTest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
    .scripts.test.trim().split(/\s+/);
  const testArgv = declaredTest.slice(1);
  steps.push({
    label: `node --test (the package's own suite: ${declaredTest.join(' ')})`,
    argv: testArgv,
    exec: () => run(declaredTest[0] === 'node' ? process.execPath : declaredTest[0], testArgv, { dryRun, cwd: PKG_ROOT }),
  });

  steps.push({
    label: 'package.json version/edition and both kits\' VERSION agree under editionToSemver',
    exec: async () => {
      if (dryRun) return { code: 0, stdout: '', stderr: '', dryRun: true };
      return checkVersionAgreement();
    },
  });

  // F3 fix: deletes files retired from the vault source (e.g. a config/*.example nobody ships
  // anymore) that would otherwise sit in a public-repo checkout forever, since the sync has
  // always been overwrite-and-add. §10-preserved archival docs are never touched
  // (prune-public-tree.mjs reads the SAME preserve list starter-contract-test.sh does, from
  // tests/preserved-public-docs.sh).
  //
  // This step is now ALWAYS present in the pipeline — it used to be added to buildSteps() only
  // when SERPENS_PUBLIC_REPO_DIR was set, and nothing in the repo ever set it, so a normal CI
  // release pruned nothing and printed nothing: the exact stale-file class this script exists
  // to fix recurred silently. Now:
  //   - with SERPENS_PUBLIC_REPO_DIR set to a real clone of fresh-fx59/serpens-sdd, it reports
  //     (dry-run) or, with SERPENS_PUBLIC_REPO_PRUNE_APPLY=1 alongside it, actually deletes;
  //   - with no public-repo checkout available, it says so LOUDLY (a visible, non-empty log
  //     line every release run) instead of vanishing from the step list.
  // The publish workflow (under this package's CI workflow directory) wires
  // SERPENS_PUBLIC_REPO_DIR (and, for a tagged real publish, SERPENS_PUBLIC_REPO_PRUNE_APPLY=1)
  // by checking out fresh-fx59/serpens-sdd as a sibling directory before running this script,
  // so the actual release workflow exercises the real prune, not just this loud-refusal
  // fallback.
  steps.push({
    label: 'prune-public-tree.mjs (delete public-repo files retired from the vault source)',
    exec: () => {
      const publicRepoDir = process.env.SERPENS_PUBLIC_REPO_DIR;
      if (!publicRepoDir) {
        const msg = 'SERPENS_PUBLIC_REPO_DIR is not set — no public-repo checkout to prune this '
          + 'run. Stale files retired from the vault source will NOT be caught. Set '
          + 'SERPENS_PUBLIC_REPO_DIR to a clone of fresh-fx59/serpens-sdd to exercise this step '
          + '(the publish workflow does this on every run).';
        console.log(`   ⚠ ${msg}`);
        return dryRun
          ? { code: 0, stdout: msg, stderr: '', dryRun: true }
          : { code: 0, stdout: msg, stderr: '' };
      }
      const pruneApply = process.env.SERPENS_PUBLIC_REPO_PRUNE_APPLY === '1';
      const pruneArgv = [join(PKG_ROOT, 'scripts', 'prune-public-tree.mjs'), publicRepoDir, ...(pruneApply ? ['--apply'] : [])];
      return run(process.execPath, pruneArgv, { dryRun, cwd: PKG_ROOT });
    },
  });

  return steps;
}

/**
 * Assert package.json's version and serpensSddEdition, and both kits' VERSION files, all describe
 * the same edition under editionToSemver. Never throws; returns a run()-shaped result so it
 * composes with the rest of the pipeline.
 * @returns {{code: number, stdout: string, stderr: string}}
 */
/**
 * Pure core of the version-agreement gate: given package.json's version/edition and a list of
 * {name, edition, exists} for each kit's raw VERSION-file content, return the list of problems
 * (empty = agreement). Every edition value — package.json's own and each kit's — is routed
 * through editionToSemver, so a malformed edition string fails the gate outright rather than
 * merely a mismatched-but-well-formed one slipping through on string equality.
 * @param {{pkgVersion: string, serpensSddEdition: string, kitVersions: Array<{name: string, edition: string|undefined}>}} input
 * @returns {string[]} problems, empty if everything agrees
 */
export function computeVersionProblems({ pkgVersion, serpensSddEdition, kitVersions }) {
  const problems = [];
  let expectedVersion;
  try {
    expectedVersion = editionToSemver(serpensSddEdition);
  } catch (err) {
    problems.push(`package.json.serpensSddEdition ("${serpensSddEdition}") is not a well-formed edition: ${err.message}`);
    return problems;
  }

  if (pkgVersion !== expectedVersion) {
    problems.push(`package.json.version (${pkgVersion}) != editionToSemver(serpensSddEdition) (${expectedVersion})`);
  }

  for (const kit of kitVersions) {
    if (kit.edition === undefined) {
      problems.push(`${kit.name} kit VERSION does not exist`);
      continue;
    }
    let kitSemver;
    try {
      kitSemver = editionToSemver(kit.edition);
    } catch (err) {
      problems.push(`${kit.name} kit VERSION ("${kit.edition}") is not a well-formed edition: ${err.message}`);
      continue;
    }
    if (kitSemver !== expectedVersion) {
      problems.push(
        `${kit.name} kit VERSION (${kit.edition} -> ${kitSemver}) != editionToSemver(serpensSddEdition) (${expectedVersion})`,
      );
    }
  }

  return problems;
}

/**
 * Assert package.json's version and serpensSddEdition, and both kits' VERSION files, all describe
 * the same edition under editionToSemver. Never throws; returns a run()-shaped result so it
 * composes with the rest of the pipeline.
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function checkVersionAgreement() {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    const kitVersions = KITS.map((kit) => {
      const versionPath = join(kit.dir, 'VERSION');
      return {
        name: kit.name,
        edition: existsSync(versionPath) ? readFileSync(versionPath, 'utf8').trim() : undefined,
      };
    });

    const problems = computeVersionProblems({
      pkgVersion: pkg.version,
      serpensSddEdition: pkg.serpensSddEdition,
      kitVersions,
    });

    if (problems.length > 0) {
      return { code: 1, stdout: '', stderr: problems.join('\n') };
    }
    return { code: 0, stdout: `version agreement OK: ${pkg.version} / ${pkg.serpensSddEdition}`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: err.message };
  }
}

/**
 * Parse argv (excluding node + script path) into { dryRun }. Accepts only no arguments or
 * exactly `--dry-run`; anything else is a usage error (exit 2) rather than falling through to
 * the real pipeline — a typo like `--dry-ryn` must never trigger a real, ~20-minute,
 * zip-rebuilding run.
 * @param {string[]} argv
 * @returns {{dryRun: boolean}}
 */
export function parseArgs(argv) {
  if (argv.length === 0) return { dryRun: false };
  if (argv.length === 1 && argv[0] === '--dry-run') return { dryRun: true };
  const err = new Error(`unrecognized argument(s): ${argv.join(' ')} (expected no arguments, or exactly --dry-run)`);
  err.exitCode = 2;
  throw err;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const steps = buildSteps({ dryRun });

  console.log(`serpens-sdd release pipeline${dryRun ? ' (--dry-run: printing only, nothing runs)' : ''}`);
  console.log('');

  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    if (dryRun) {
      console.log(`${n}. ${step.label}`);
      continue;
    }
    process.stdout.write(`${n}. ${step.label} ... `);
    const result = await step.exec();
    if (result.code !== 0) {
      console.log('FAILED');
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      console.error(`\nrelease pipeline stopped at step ${n}: ${step.label}`);
      process.exit(1);
    }
    console.log('ok');
  }

  console.log('');
  if (dryRun) {
    console.log(`${steps.length + 1}. print (not run): npm publish --access public`);
    console.log('\nAll steps above are printed only; nothing was executed.');
    return;
  }

  console.log('All release steps passed. Publish is a deliberate human step — run it yourself:');
  console.log('');
  console.log('  npm publish --access public');
  console.log('');
  console.log('(unpublish has a 72-hour window; this script will never run that command for you)');
}

// Only run the pipeline when this file is the process entry point — importing it (e.g. from
// a test, to reach buildSteps/checkVersionAgreement) must never have the side effect of
// running the release pipeline.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(typeof err.exitCode === 'number' ? err.exitCode : 1);
  });
}
