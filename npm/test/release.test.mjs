import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSteps,
  discoverSuites,
  assertAllMapped,
  parseArgs,
  computeVersionProblems,
} from '../scripts/release.mjs';
import { resolveKitSource } from '../scripts/kit-source.mjs';
import { resolvePublishWorkflow } from './helpers/workflow-path.mjs';
import { SUPPORTED_MINORS } from '../src/openspecversion.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, '..', '..', 'tests');

// Importing scripts/release.mjs must never run the pipeline (no vault file changes, no zip
// rebuild). This just proves the import itself is inert; it does not execute any step.
test('importing release.mjs has no side effect (nothing under the vault kit trees changes)', () => {
  const before = readdirSync(resolveKitSource('en')).sort();
  // buildSteps() only constructs the step descriptors — it must not execute anything either.
  const steps = buildSteps({ dryRun: false });
  assert.ok(Array.isArray(steps) && steps.length > 0);
  const after = readdirSync(resolveKitSource('en')).sort();
  assert.deepEqual(before, after);
});

test('every *-test.sh in the vault tests dir is discovered and appears in the built step list', () => {
  const onDisk = readdirSync(TESTS_DIR).filter((f) => f.endsWith('-test.sh')).sort();
  assert.ok(onDisk.length > 0, 'expected at least one *-test.sh in the vault tests dir');

  const discovered = discoverSuites();
  assert.deepEqual(discovered, onDisk);

  const steps = buildSteps({ dryRun: true });
  const labels = steps.map((s) => s.label).join('\n');
  for (const suite of onDisk) {
    assert.ok(labels.includes(suite), `expected a release step for discovered suite ${suite}`);
  }
});

test('an unmapped suite name is rejected loudly instead of being silently dropped', () => {
  // A tenth suite added to content/enterprise-sdd-agents/tests/ tomorrow, with no entry yet in
  // KIT_ROOT_SUITES or TOOL_SUITES, must force a deliberate decision rather than vanish from
  // the release gate.
  assert.throws(
    () => assertAllMapped(['brand-new-suite-test.sh']),
    /brand-new-suite-test\.sh/,
  );
});

test('discoverSuites itself does not throw against the real tests dir (every suite on disk is mapped today)', () => {
  assert.doesNotThrow(() => discoverSuites());
});

test('tool suites and the bin parity gate run ONCE per release; only kit-root suites run once per kit', () => {
  // There is exactly one shared copy of the ten former kit scripts now (Task 3), so a
  // TOOL_SUITES or BIN_SUITES case run against both kits would assert nothing extra and imply
  // per-kit coverage that no longer exists (controller ruling, 2026-09-08). Only genuinely
  // per-kit suites (their own root, VERSION, MANIFEST) still run twice.
  const steps = buildSteps({ dryRun: true });
  const labels = steps.map((s) => s.label);

  const countFor = (suite) => labels.filter((l) => l.startsWith(`${suite} (`)).length;

  for (const suite of ['tools-parity-test.sh', 'serpens-lint-test.sh', 'repository-state-test.sh',
    'sync-submodules-test.sh', 'index-all-submodules-test.sh', 'aggregate-submodules-test.sh',
    'split-brain-window-test.sh']) {
    assert.equal(countFor(suite), 1, `expected exactly one release step for ${suite}, saw ${countFor(suite)}`);
  }

  for (const suite of ['starter-contract-test.sh', 'kit-version-test.sh']) {
    assert.equal(countFor(suite), 2, `expected exactly two release steps for ${suite} (one per kit), saw ${countFor(suite)}`);
    assert.ok(labels.includes(`${suite} (en)`) && labels.includes(`${suite} (ru)`),
      `expected ${suite} to run once for each of 'en' and 'ru'`);
  }

  // The stamp check and the zip build are the other genuinely per-kit steps.
  assert.equal(labels.filter((l) => l.includes('rebuild') && l.includes('zip')).length, 2);
});

test('parseArgs: no arguments means run for real', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
});

test('parseArgs: exactly --dry-run means dry run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
});

test('parseArgs: an unrecognized argument is a usage error (exit 2), never a silent real run', () => {
  assert.throws(() => parseArgs(['--dry-ryn']), (err) => {
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /--dry-ryn/);
    return true;
  });
  assert.throws(() => parseArgs(['--dry-run', 'extra']), (err) => {
    assert.equal(err.exitCode, 2);
    return true;
  });
});

test('version agreement: well-formed and matching values pass', () => {
  const problems = computeVersionProblems({
    pkgVersion: '1.20260826.8',
    serpensSddEdition: '2026-08-26.8',
    kitVersions: [
      { name: 'en', edition: '2026-08-26.8' },
      { name: 'ru', edition: '2026-08-26.8' },
    ],
  });
  assert.deepEqual(problems, []);
});

test('version agreement: a malformed kit VERSION fails even though it is not a string mismatch', () => {
  // The old implementation compared kit VERSION to serpensSddEdition by raw string equality, so a
  // malformed-but-different string would still surface as a problem — the gap was a malformed
  // string that happens to be unrelated garbage, which editionToSemver must now reject outright.
  const problems = computeVersionProblems({
    pkgVersion: '1.20260826.8',
    serpensSddEdition: '2026-08-26.8',
    kitVersions: [
      { name: 'en', edition: 'not-an-edition' },
      { name: 'ru', edition: '2026-08-26.8' },
    ],
  });
  assert.ok(problems.some((p) => /en kit VERSION.*not a well-formed edition/.test(p)), problems.join('\n'));
});

test('version agreement: a well-formed but mismatched kit VERSION still fails', () => {
  const problems = computeVersionProblems({
    pkgVersion: '1.20260826.8',
    serpensSddEdition: '2026-08-26.8',
    kitVersions: [
      { name: 'en', edition: '2026-08-26.7' },
      { name: 'ru', edition: '2026-08-26.8' },
    ],
  });
  assert.ok(problems.some((p) => /en kit VERSION/.test(p)), problems.join('\n'));
});

test('version agreement: a malformed package.json edition fails, not just a mismatch', () => {
  const problems = computeVersionProblems({
    pkgVersion: '1.20260826.8',
    serpensSddEdition: 'garbage',
    kitVersions: [{ name: 'en', edition: '2026-08-26.8' }],
  });
  assert.ok(problems.some((p) => /serpensSddEdition.*not a well-formed edition/.test(p)), problems.join('\n'));
});

test('version agreement: a missing kit VERSION file is a problem', () => {
  const problems = computeVersionProblems({
    pkgVersion: '1.20260826.8',
    serpensSddEdition: '2026-08-26.8',
    kitVersions: [{ name: 'en', edition: undefined }],
  });
  assert.ok(problems.some((p) => /en kit VERSION does not exist/.test(p)), problems.join('\n'));
});

test('the release pipeline drives vendoring with --resync, and still never publishes, pushes or tags', () => {
  const steps = buildSteps({ dryRun: true });
  const vendorStep = steps.find((s) => s.label.includes('vendor-kits.mjs'));
  assert.ok(vendorStep, 'expected a vendor-kits step');
  assert.match(vendorStep.label, /--resync/,
    'the release must re-sync: stamping the vault trees a step earlier always leaves kits/ behind, '
    + 'and vendor-kits.mjs refuses a differing target by default');

  // Nothing in the pipeline may publish, push or tag — the property the review singled out.
  const source = readFileSync(join(__dirname, '..', 'scripts', 'release.mjs'), 'utf8');
  const executable = source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  for (const forbidden of [/run\([^)]*['"]npm['"]\s*,\s*\[[^\]]*publish/, /'push'/, /"push"/, /'tag'/, /"tag"/]) {
    assert.ok(!forbidden.test(executable), `release.mjs must not contain ${forbidden}`);
  }
  assert.match(source, /npm publish --access public/, 'the publish command is printed, not run');
});

// scripts/gen-ports.mjs REQUIRES `--openspec "<invocation>"` and exits 2 with a usage line
// without it. release.mjs invoked it with no arguments at all, so step 18 of the pipeline could
// never pass — which means the pipeline could never run to completion, which means the publish
// job's central precondition ("release.mjs completed, so the kit is not stale") was
// unsatisfiable. Nothing caught it because every other test builds the steps and reads their
// labels rather than their argv.
// `node --test test/` fails on Node 22 — the runner resolves a bare directory as a module and
// dies with "Cannot find module .../test" while still exiting 0 from the pipeline's point of
// view only because the failure is inside the child. package.json's own `test` script uses the
// glob form, which works; the release pipeline used the directory form, which does not. The
// invariant worth enforcing is that the release runs THE SAME suite command the package
// declares, so the two can never drift again.
test('the release runs exactly the suite command package.json declares', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = pkg.scripts.test.trim().split(/\s+/); // e.g. node --test test/*.test.mjs
  assert.equal(declared[0], 'node', `package.json test script must start with node: ${pkg.scripts.test}`);
  const steps = buildSteps({ dryRun: true });
  const step = steps.find((s) => s.label.startsWith('node --test'));
  assert.ok(step, 'the pipeline must run the package suite');
  assert.ok(step.argv, 'the suite step must expose its argv');
  assert.deepEqual(step.argv, declared.slice(1),
    `the release suite command drifted from package.json's: ${step.argv.join(' ')} vs ${declared.slice(1).join(' ')}`);
});

// npm provenance under OIDC trusted publishing requires `package.json.repository` to name the
// exact GitHub repository the publish comes from (npm's own trusted-publishers docs). Without
// it, `npm publish` still succeeds but ships with no provenance attestation — a silent
// degradation nothing else in this suite would catch, since release.mjs never reads this field.
test('package.json declares a repository field pointing at fresh-fx59/serpens-sdd (required for npm provenance under trusted publishing)', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.repository, 'package.json must declare a "repository" field');
  assert.equal(pkg.repository.type, 'git');
  assert.equal(pkg.repository.url, 'git+https://github.com/fresh-fx59/serpens-sdd.git');
});

test('the gen-ports step passes gen-ports.mjs the --openspec invocation it requires', () => {
  const steps = buildSteps({ dryRun: true });
  const step = steps.find((s) => s.label.startsWith('gen-ports.mjs'));
  assert.ok(step, 'the pipeline must have a gen-ports step');
  assert.ok(step.argv, 'the gen-ports step must expose its argv so this is checkable off a real run');
  const idx = step.argv.indexOf('--openspec');
  assert.ok(idx > -1, `gen-ports.mjs was invoked without --openspec: ${step.argv.join(' ')}`);
  const invocation = step.argv[idx + 1];
  assert.ok(invocation && invocation.length > 0, '--openspec must have a value');
  // A FULL x.y.z, not a range and not `latest`. gen-ports.mjs reads the probed version straight
  // out of this string (`/@(\\d+\\.\\d+\\.\\d+)/`) and writes it into every port's `verified`
  // field; a two-component range like `@1.13` installs fine and then stamps 39 port files with
  // "openspec unknown", silently destroying the registry's provenance.
  const pinned = /@fission-ai\/openspec@(\d+\.\d+\.\d+)(?:\s|$)/.exec(invocation);
  assert.ok(pinned, `the invocation must pin a full x.y.z version, got "${invocation}"`);
  // The pinned line must be one the package actually supports, or the release regenerates the
  // port registry against a CLI the runtime would then reject.
  const minor = pinned[1].split('.').slice(0, 2).join('.');
  assert.equal(minor, SUPPORTED_MINORS[0],
    'the release must probe the NEWEST supported OpenSpec minor');
});

// F3 regression --------------------------------------------------------------------------

test('the prune-public-tree.mjs step is ALWAYS in the pipeline, not gated behind an env var nobody sets', () => {
  // Before the fix, this step existed only `if (publicRepoDir)`, and nothing in this repo ever
  // set SERPENS_PUBLIC_REPO_DIR — so a normal release pruned nothing and the step never even
  // appeared in the step list. buildSteps() must expose it unconditionally now.
  const withEnv = buildSteps({ dryRun: true });
  const withoutStep = withEnv.find((s) => s.label.includes('prune-public-tree.mjs'));
  assert.ok(withoutStep, 'expected a prune-public-tree.mjs step to always be present in buildSteps()');
});

test('the prune step says so loudly when it has no public checkout to prune, instead of vanishing', async () => {
  const savedDir = process.env.SERPENS_PUBLIC_REPO_DIR;
  const savedApply = process.env.SERPENS_PUBLIC_REPO_PRUNE_APPLY;
  delete process.env.SERPENS_PUBLIC_REPO_DIR;
  delete process.env.SERPENS_PUBLIC_REPO_PRUNE_APPLY;
  try {
    const steps = buildSteps({ dryRun: false });
    const step = steps.find((s) => s.label.includes('prune-public-tree.mjs'));
    assert.ok(step, 'expected a prune-public-tree.mjs step');
    const result = await step.exec();
    assert.equal(result.code, 0, 'no public checkout is a loud notice, not a pipeline failure');
    assert.match(result.stdout, /SERPENS_PUBLIC_REPO_DIR is not set/,
      'the step must say loudly that nothing was pruned this run');
  } finally {
    if (savedDir === undefined) delete process.env.SERPENS_PUBLIC_REPO_DIR; else process.env.SERPENS_PUBLIC_REPO_DIR = savedDir;
    if (savedApply === undefined) delete process.env.SERPENS_PUBLIC_REPO_PRUNE_APPLY; else process.env.SERPENS_PUBLIC_REPO_PRUNE_APPLY = savedApply;
  }
});

test('the CI publish workflow wires a real public-repo checkout into the release pipeline', () => {
  const workflow = readFileSync(resolvePublishWorkflow(join(__dirname, '..')), 'utf8');
  assert.match(workflow, /fresh-fx59\/serpens-sdd/,
    'the workflow must check out the public repository prune-public-tree.mjs actually prunes');
  assert.match(workflow, /SERPENS_PUBLIC_REPO_DIR/,
    'the workflow must point the release pipeline at the checked-out public repo');
  assert.match(workflow, /SERPENS_PUBLIC_REPO_PRUNE_APPLY/,
    'a real tagged publish must actually apply the prune, not just dry-run it');
});

// D1 regression --------------------------------------------------------------------------

test('the CI publish workflow actually commits and pushes the prune to the public repository', () => {
  // Before the fix, the workflow deleted files in a LOCAL checkout, logged "deleted N path(s)",
  // and then destroyed the runner — no commit, no push, `permissions: contents: read` — so the
  // retired file was still live in the public repo after every "successful" release.
  const workflow = readFileSync(resolvePublishWorkflow(join(__dirname, '..')), 'utf8');
  assert.match(workflow, /git push/,
    'the workflow must push the prune to the public repository, not just delete locally');
  assert.match(workflow, /git commit/,
    'the workflow must commit the pruned tree before it can push it');
  assert.match(workflow, /secrets\.SERPENS_SDD_PUBLIC_REPO_TOKEN/,
    'pushing to a DIFFERENT repository needs a dedicated write-scoped token — GITHUB_TOKEN '
    + 'cannot reach fresh-fx59/serpens-sdd regardless of this job\'s own permissions: block');
  assert.match(workflow, /token:\s*\$\{\{\s*secrets\.SERPENS_SDD_PUBLIC_REPO_TOKEN\s*\}\}/,
    'the public-repo checkout must actually be authenticated with that token, not merely mention it');
});

test('the CI publish workflow no longer claims the public checkout sits beside the primary one', () => {
  // F3's comment claimed `path: public-repo-checkout` makes actions/checkout create a SIBLING
  // of the primary checkout. It does not: `path:` is always resolved against `github.workspace`
  // (the primary checkout's own root), so the public checkout is a SUBDIRECTORY of it.
  const workflow = readFileSync(resolvePublishWorkflow(join(__dirname, '..')), 'utf8');
  assert.doesNotMatch(workflow, /a sibling of the working directory/,
    'the false "sibling" claim about actions/checkout path: resolution must be gone');
  assert.doesNotMatch(workflow, /sits next to that root, not inside it/,
    'the false "sits next to, not inside" claim must be gone');
  assert.match(workflow, /subdirectory/i,
    'the corrected comment must say path: resolves to a SUBDIRECTORY of github.workspace');
});
