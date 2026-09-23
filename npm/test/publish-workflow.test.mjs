// The publish workflow's own gate.
//
// Everything asserted here is a property that, if it silently regressed, would either leak a
// credential or ship an unverified artifact — neither of which any other test in this package
// can see, because the workflow is data, not code, and nothing imports it.
//
// Read as a file rather than parsed with a YAML library on purpose: the package declares ZERO
// runtime dependencies (see hygiene.test.mjs) and adding one to read nine lines of config would
// be a worse trade than a strict line reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePublishWorkflow } from './helpers/workflow-path.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

// In this vault the workflow sits inside the package directory. In the public repository the
// package is `npm/` and the workflow must sit at the REPOSITORY root — the only place a
// workflow ever runs from. Resolved rather than spelled, and the resolver throws naming both
// candidates if neither exists, so this gate can never pass by finding nothing to check.
// The FILENAME is fixed in both layouts: npm matches a trusted publisher on the workflow's
// filename, so renaming publish.yml breaks the publisher configuration.
function workflowText() {
  const path = resolvePublishWorkflow(PKG_ROOT);
  assert.ok(existsSync(path), `the publish workflow must exist at ${path}`);
  assert.equal(path.endsWith(join('.github', 'workflows', 'publish.yml')), true,
    'npm matches the trusted publisher on this exact filename');
  return readFileSync(path, 'utf8');
}

/** The lines of the top-level `on:` block, as written. */
function triggerBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l) || /^on:\s*\S/.test(l));
  assert.ok(start >= 0, 'the workflow must declare a top-level `on:` trigger block');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // next top-level key
    out.push(lines[i]);
  }
  return out;
}

test('the workflow requests an OIDC identity token', () => {
  const text = workflowText();
  assert.match(text, /^\s*id-token:\s*write\s*$/m,
    'without `id-token: write` there is no OIDC credential and the publish cannot authenticate');
  assert.match(text, /^\s*contents:\s*read\s*$/m,
    'contents must be read-only: a publish job has no business writing to the repository');
});

test('the workflow carries NO npm/registry credential of any kind', () => {
  const text = workflowText();
  // The whole point of trusted publishing: there is nothing npm-shaped here to steal or rotate.
  for (const banned of ['NODE_AUTH_TOKEN', '_authToken', 'NPM_TOKEN']) {
    assert.ok(!text.includes(banned), `the workflow must not mention ${banned}`);
  }
  // D1 fix: pruning the PUBLIC repository (a different repository than this workflow lives in)
  // durably requires ITS OWN write-scoped token — GITHUB_TOKEN cannot reach another repository
  // regardless of this job's own `permissions:` block. That secret has nothing to do with npm
  // publishing (no registry auth, no OIDC substitute), so it is named and scoped narrowly rather
  // than banned outright: only SERPENS_SDD_PUBLIC_REPO_TOKEN may appear as a `secrets.` reference.
  const secretRefs = [...text.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((m) => m[1]);
  for (const name of secretRefs) {
    assert.equal(name, 'SERPENS_SDD_PUBLIC_REPO_TOKEN',
      `the only repository secret this workflow may reference is SERPENS_SDD_PUBLIC_REPO_TOKEN `
      + `(scoped to pushing the prune to the public repo) — found secrets.${name}`);
  }
  // setup-node's `registry-url` input is not neutral: it writes an .npmrc containing a
  // `_authToken` line bound to NODE_AUTH_TOKEN. That is the exact credential shape trusted
  // publishing exists to remove, and with no token set it is an empty auth line for npm to
  // trip over. The default registry is already registry.npmjs.org, so the input buys nothing.
  const executable = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/registry-url/.test(executable),
    'setup-node registry-url writes an _authToken line into .npmrc — trusted publishing needs none');
});

test('the workflow triggers on a pushed TAG only, never on a branch', () => {
  const text = workflowText();
  const block = triggerBlock(text).join('\n');
  assert.match(block, /^\s*tags:\s*$/m, 'the trigger must be a tag filter');
  assert.ok(!/^\s*branches:/m.test(block), 'a branch filter would publish on every merge');
  // `push` must be the only trigger: a pull_request or schedule trigger would publish without a
  // tag, and the tag check below could then only fail the job AFTER the release pipeline ran.
  const triggers = triggerBlock(text)
    .filter((l) => /^ {2}\S/.test(l) && !/^\s*#/.test(l))
    .map((l) => l.trim().replace(/:.*$/, ''));
  assert.deepEqual(triggers, ['push'], `expected only a push trigger, got: ${triggers.join(', ')}`);
});

test('the workflow ASSERTS the resolved Node and npm versions, not just requests them', () => {
  const text = workflowText();
  // The floors must be live values IN THE COMPARING STEP, not prose and not the install
  // request: a comment (or an `npm@^11.5.1` install line) naming 11.5.1 above a step that
  // actually compares against 9.0.0 would read as correct and gate nothing. So find the shell
  // block that reads the versions back, and require both floors inside THAT block.
  const lines = text.split('\n');
  const at = lines.findIndex((l) => !/^\s*#/.test(l) && /npm (-v|--version)/.test(l));
  assert.ok(at > -1, 'no executed line reads the resolved npm version back');
  let from = at;
  while (from > 0 && !/run:\s*\|/.test(lines[from])) from--;
  let to = at;
  while (to < lines.length - 1 && !/^\s*- name:/.test(lines[to + 1])) to++;
  const block = lines.slice(from, to + 1).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(block.includes('22.14.0'), `the Node floor 22.14.0 must be compared against in this step:\n${block}`);
  assert.ok(block.includes('11.5.1'), `the npm floor 11.5.1 must be compared against in this step:\n${block}`);
  // Requesting a version is not asserting one: a runner image can resolve something older and
  // the job would carry on to a publish that cannot authenticate. There must be a step that
  // reads the versions actually in PATH and exits non-zero.
  assert.match(text, /node -v|node --version/, 'the resolved node version must be read back');
  assert.match(text, /npm -v|npm --version/, 'the resolved npm version must be read back');
  assert.match(text, /exit 1/, 'the version-floor step must be able to fail the job');
});

test('the release pipeline runs BEFORE the publish, and the tag check before both', () => {
  // Ordering is asserted over the executed `run:` lines only — the header prose names the same
  // scripts in a different order, and commentary must not be able to satisfy or break this.
  const commands = workflowText()
    .split('\n')
    .filter((l) => /^\s*(run:|-|\s)/.test(l) && !/^\s*#/.test(l))
    .filter((l) => /run:/.test(l) || /^\s{8,}\S/.test(l))
    .join('\n');
  const text = commands;
  const tagCheck = text.indexOf('check-publish-tag.mjs');
  const release = text.indexOf('scripts/release.mjs');
  const publish = text.indexOf('npm publish --access public');
  assert.ok(tagCheck > -1, 'the tag->artifact check must run in the job');
  assert.ok(release > -1, 'scripts/release.mjs must run in the job');
  assert.ok(publish > -1, 'the job must publish');
  assert.ok(tagCheck < release, 'refuse a mismatched tag before spending ~20 minutes on the pipeline');
  assert.ok(release < publish, 'a publish that has not run the release pipeline can ship a stale kit');
});

test('the publish is public and token-free', () => {
  const text = workflowText();
  assert.match(text, /npm publish --access public/, 'the package is scoped; without --access public npm refuses');
  assert.ok(!/--otp/.test(text), 'an OTP is a human keystroke and has no place in an unattended job');
});

test('every run step executes inside the package directory, not the repository root', () => {
  // Path shift on the move: the public repository keeps the package in `npm/`, with the kit
  // trees (`en/`, `ru/`) and the shell suites (`tests/`) as its SIBLINGS at the repository root
  // — which is exactly what scripts/release.mjs and the kit-source resolver expect one level up
  // from the package. The workflow itself must live at the repository root's .github/, so every
  // `run:` step has to change into `npm/` or it will not find a single script.
  const text = workflowText();
  assert.match(text, /^defaults:\s*$/m, 'the workflow must declare a defaults block');
  assert.match(text, /working-directory:\s*npm\s*$/m,
    'run steps must default to the package directory `npm` inside the public repository');
});

test('the job timeout allows for the ~20-minute port regeneration inside release.mjs', () => {
  const text = workflowText();
  const m = /timeout-minutes:\s*(\d+)/.exec(text);
  assert.ok(m, 'the job must declare timeout-minutes — the default 360 hides a hung npx probe');
  assert.ok(Number(m[1]) >= 45, `timeout-minutes is ${m[1]}, too short for gen-ports.mjs (~20 min) plus the shell suites`);
  assert.ok(Number(m[1]) <= 120, `timeout-minutes is ${m[1]}: a runaway job should be killed, not run for hours`);
});

// Found 2026-09-23 by reproducing this workflow's own step-20 failure in a matching
// ubuntu-bookworm container: `bin/serpens-sdd.mjs`'s own suite needs a real `lefthook` binary
// (stage6.test.mjs, the store-uninstall e2e suite, the coexistence gap tests) and a real
// PyYAML (test/openspec-config.test.mjs's assertValidYaml, a second independent parser checking
// the production YAML-editing code) — neither ships on the bare ubuntu-latest runner, and
// nothing installed either before this fix, so `node --test` failed 28-50 cases in CI while
// passing everywhere a developer machine happened to already have both tools. This test pins
// the fix so it cannot silently regress if the workflow is edited again.
test('lefthook and PyYAML are installed before the release pipeline runs (real-binary test deps ubuntu-latest does not ship)', () => {
  const text = workflowText();
  assert.match(text, /python3-yaml/, 'PyYAML must be installed — openspec-config.test.mjs shells out to python3 -c "import yaml"');
  assert.match(text, /npm install -g lefthook/, 'a real lefthook binary must be installed — several suites exercise it directly, not a stub');

  // Order matters: both installs must land before "Run the full release pipeline", or the
  // pipeline's own `node --test` step (which needs them) runs first and fails anyway.
  const pipelineAt = text.indexOf('Run the full release pipeline');
  const lefthookAt = text.indexOf('npm install -g lefthook');
  const pyyamlAt = text.indexOf('python3-yaml');
  assert.ok(pipelineAt > 0 && lefthookAt > 0 && pyyamlAt > 0, 'all three markers must be present');
  assert.ok(lefthookAt < pipelineAt, 'lefthook must be installed before the release pipeline step');
  assert.ok(pyyamlAt < pipelineAt, 'PyYAML must be installed before the release pipeline step');
});
