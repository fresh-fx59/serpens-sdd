import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, proveOpenspec } from '../src/config.mjs';
import { SUPPORTED_MINORS } from '../src/openspecversion.mjs';

const good = {
  schema_version: 1, project: 'acme-billing', lang: 'en', port: 'gigacode',
  openspec: { invocation: 'npx @fission-ai/openspec@1.10.3', pinned_version: '1.10.3' },
  store: { remote: 'ssh://git@forge/acme/system-store.git', base_branch: 'develop', root: '../system-store' },
  repositories: [{ name: 'service-a', url: 'ssh://git@forge/acme/service-a.git', base_branch: 'develop' }],
  facts: { forge: 'anything', tracker: 'anything', repository_source: 'manual' },
};

test('accepts a good config and defaults store.id', () => {
  const r = validateConfig(good);
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.store.id, 'acme-billing-store');
});

test('rejects a non-kebab project and store id', () => {
  assert.match(validateConfig({ ...good, project: 'Acme_Billing' }).errors.join(), /kebab-case/);
});

test('rejects an unsafe repository name and a bad branch', () => {
  const bad = { ...good, repositories: [{ name: '../evil', url: 'u', base_branch: 'develop' }] };
  assert.match(validateConfig(bad).errors.join(), /name/);
  const badBranch = { ...good, repositories: [{ name: 'a', url: 'u', base_branch: 'bad branch' }] };
  assert.match(validateConfig(badBranch).errors.join(), /branch/);
});

test('rejects a store root inside the serpens-sdd checkout', () => {
  assert.match(validateConfig({ ...good, store: { ...good.store, root: './inside' } },
    { checkoutRoot: process.cwd(), resolveFrom: process.cwd() }).errors.join(), /outside/);
});

test('a pinned-version mismatch is exit 3, not a warning', async () => {
  const fakeRun = async () => ({ code: 0, stdout: '1.12.0\n', stderr: '' });
  const r = await proveOpenspec(good, { run: fakeRun });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.error, /1\.10\.3/);
});

test('openspec.pinned_version is optional: validateConfig accepts a config without it', () => {
  const { pinned_version, ...openspecNoPin } = good.openspec;
  const r = validateConfig({ ...good, openspec: openspecNoPin });
  assert.deepEqual(r.errors, []);
});

test('proveOpenspec accepts a supported version with no pin set', async () => {
  const { pinned_version, ...openspecNoPin } = good.openspec;
  const config = { ...good, openspec: openspecNoPin };
  const fakeRun = async () => ({ code: 0, stdout: `${SUPPORTED_MINORS[0]}.0\n`, stderr: '' });
  const r = await proveOpenspec(config, { run: fakeRun });
  assert.equal(r.ok, true);
  assert.equal(r.minorKey, SUPPORTED_MINORS[0]);
});

test('proveOpenspec rejects an out-of-window version with no pin set, naming detected + supported', async () => {
  const { pinned_version, ...openspecNoPin } = good.openspec;
  const config = { ...good, openspec: openspecNoPin };
  const fakeRun = async () => ({ code: 0, stdout: '1.2.3\n', stderr: '' });
  const r = await proveOpenspec(config, { run: fakeRun });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.error, /1\.2\.3/);
  for (const minor of SUPPORTED_MINORS) {
    assert.match(r.error, new RegExp(minor.replace('.', '\\.')));
  }
  assert.match(r.error, /nothing was written/);
});

test('proveOpenspec rejects unparseable --version output', async () => {
  const fakeRun = async () => ({ code: 0, stdout: 'garbage\n', stderr: '' });
  const r = await proveOpenspec(good, { run: fakeRun });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.error, /unparseable/);
});

test('proveOpenspec returns the detected version on success', async () => {
  const config = { ...good, openspec: { invocation: 'openspec', pinned_version: `${SUPPORTED_MINORS[0]}.5` } };
  const fakeRun = async () => ({ code: 0, stdout: `${SUPPORTED_MINORS[0]}.5\n`, stderr: '' });
  const r = await proveOpenspec(config, { run: fakeRun });
  assert.equal(r.ok, true);
  assert.equal(r.version.raw, `${SUPPORTED_MINORS[0]}.5`);
});

// Step 6 (gap 3, spec-openspec-coexistence-2026-09-22.md): repo-local topology — one repository,
// no sibling store. `store:`/`repositories:` are FORBIDDEN there (a validation error), never ignored.
const repoLocal = {
  schema_version: 1, topology: 'repo-local', project: 'acme-billing', lang: 'en', port: 'claude',
  openspec: { invocation: 'npx @fission-ai/openspec@1.13.1' },
  repo: { root: '.', name: 'acme-billing', base_branch: 'main' },
};

test('repo-local: a valid config passes, and root may equal the checkout (the outside rule is store-only)', () => {
  const r = validateConfig(repoLocal, { checkoutRoot: process.cwd(), resolveFrom: process.cwd() });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.topology, 'repo-local');
  assert.equal(r.value.store, undefined, 'no store object is invented in repo-local');
  assert.equal(r.value.repositories, undefined);
});

test('repo-local: store: is an error, not ignored', () => {
  const r = validateConfig({ ...repoLocal, store: good.store });
  assert.match(r.errors.join('\n'), /store.*not allowed.*repo-local/);
});

test('repo-local: repositories: is an error, not ignored', () => {
  const r = validateConfig({ ...repoLocal, repositories: good.repositories });
  assert.match(r.errors.join('\n'), /repositories.*not allowed.*repo-local/);
});

test('repo-local: missing repo.base_branch, repo.name or repo.root is an error', () => {
  assert.match(validateConfig({ ...repoLocal, repo: { root: '.', name: 'x' } }).errors.join(), /repo\.base_branch/);
  assert.match(validateConfig({ ...repoLocal, repo: { root: '.', base_branch: 'main' } }).errors.join(), /repo\.name/);
  assert.match(validateConfig({ ...repoLocal, repo: { name: 'x', base_branch: 'main' } }).errors.join(), /repo\.root/);
});

test('an unknown topology is an error; an absent one means store (existing configs unchanged)', () => {
  assert.match(validateConfig({ ...good, topology: 'mesh' }).errors.join(), /topology/);
  const r = validateConfig(good);
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.topology, 'store');
});
