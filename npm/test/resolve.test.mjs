import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInputs } from '../src/resolve.mjs';
import { SHIM_INVOCATION } from '../src/shim.mjs';

const base = { argv: [], config: {}, env: {}, tty: false, nonInteractive: false };

test('a flag beats the config file', async () => {
  const r = await resolveInputs({ ...base, argv: ['--project', 'from-flag'], config: { project: 'from-config' } });
  assert.equal(r.value.project, 'from-flag');
  assert.equal(r.sources.project, 'flag');
});

test('the config file beats the environment', async () => {
  const r = await resolveInputs({ ...base, config: { project: 'from-config' }, env: { SERPENS_SDD_PROJECT: 'from-env' } });
  assert.equal(r.value.project, 'from-config');
});

test('prompts only when a TTY is present', async () => {
  const asked = [];
  const ask = async (q) => { asked.push(q.key); return 'typed'; };
  const r = await resolveInputs({ ...base, tty: true, ask });
  assert.equal(r.value.project, 'typed');
  assert.ok(asked.includes('project'));
});

test('without a TTY a missing required input is exit 2 and names the flag', async () => {
  const r = await resolveInputs({ ...base, tty: false });
  assert.equal(r.exitCode, 2);
  assert.match(r.missing.join(' '), /--project/);
});

test('--non-interactive refuses to prompt even on a TTY', async () => {
  const ask = async () => { throw new Error('must not ask'); };
  const r = await resolveInputs({ ...base, tty: true, nonInteractive: true, ask });
  assert.equal(r.exitCode, 2);
});

test('a flag followed by another flag is not swallowed as a value', async () => {
  const r = await resolveInputs({ ...base, argv: ['--project', '--lang', 'en'], tty: false });
  assert.equal(r.value.project, undefined);
  assert.equal(r.exitCode, 2);
  assert.match(r.missing.join(' '), /--project/);
});

test('a trailing flag with nothing after it is not provided', async () => {
  const r = await resolveInputs({ ...base, argv: ['--project'], tty: false });
  assert.equal(r.value.project, undefined);
  assert.equal(r.exitCode, 2);
  assert.match(r.missing.join(' '), /--project/);
});

test('an empty string is not provided and falls through to the next source', async () => {
  const asked = [];
  const ask = async (q) => { asked.push(q.key); return 'typed'; };
  const r = await resolveInputs({
    ...base,
    env: { SERPENS_SDD_PROJECT: '' },
    tty: true,
    ask,
  });
  assert.equal(r.value.project, 'typed');
  assert.equal(r.sources.project, 'prompt');
  assert.ok(asked.includes('project'));
});

test('an unresolved optional key with no default is absent from value and sources', async () => {
  const r = await resolveInputs({ ...base, argv: ['--project', 'p'], tty: false });
  assert.equal('port' in r.value, false);
  assert.equal('port' in r.sources, false);
});

test("the spec §3 published one-liner parses: --openspec and --store-base are accepted aliases", async () => {
  // Verbatim from the spec's own one-line form, minus the `npx …@version init` prefix the CLI
  // never sees. The canonical flag names (--openspec-invocation, --store-base-branch) stay the
  // ones help prints; these two shorter spellings must resolve to the same keys, or the
  // documented command does not run.
  const argv = [
    '--project', 'acme-billing', '--port', 'gigacode', '--lang', 'en',
    '--openspec', 'npx @fission-ai/openspec@1.10.3',
    '--store-remote', 'ssh://git@forge/acme/system-store.git', '--store-base', 'develop',
  ];
  const r = await resolveInputs({ argv, config: {}, env: {}, tty: false, nonInteractive: true });

  assert.equal(r.value.openspec.invocation, 'npx @fission-ai/openspec@1.10.3');
  assert.equal(r.sources['openspec.invocation'], 'flag');
  assert.equal(r.value.store.base_branch, 'develop');
  assert.equal(r.sources['store.base_branch'], 'flag');
  assert.equal(r.value.project, 'acme-billing');
  assert.equal(r.value.port, 'gigacode');
  assert.equal(r.value.store.remote, 'ssh://git@forge/acme/system-store.git');

  // `--store-root` is the one required input the published one-liner genuinely does not
  // carry, still reported as missing by flag name — never defaulted behind the operator's
  // back. `--openspec-pinned-version` is optional now (the support window is the constraint
  // when it is absent), so its absence here is not an error.
  assert.deepEqual(r.missing, ['--store-root']);
  assert.equal(r.exitCode, 2);
});

test('the canonical flag wins over its alias when both are given', async () => {
  const argv = [
    '--openspec', 'aliased', '--openspec-invocation', 'canonical',
    '--store-base', 'from-alias', '--store-base-branch', 'from-canonical',
  ];
  const r = await resolveInputs({ argv, config: {}, env: {}, tty: false, nonInteractive: true });
  assert.equal(r.value.openspec.invocation, 'canonical');
  assert.equal(r.value.store.base_branch, 'from-canonical');
});

test('serpens_sdd.invocation defaults to the generated shim, and a flag or config overrides it', async () => {
  // The install-wide contract: with nothing configured, every installed command and skill calls
  // `<repo>/tools/serpens-sdd` — the same string stage 5 writes into the hooks. A bare `serpens-sdd`
  // would be a call route no devDependency or `npx` install has.
  const d = await resolveInputs({ ...base, tty: false, argv: ['--project', 'p'] });
  assert.equal(d.value.serpens_sdd.invocation, SHIM_INVOCATION);
  assert.equal(d.sources['serpens_sdd.invocation'], 'default');

  const f = await resolveInputs({ ...base, tty: false, argv: ['--project', 'p', '--serpens-sdd-invocation', 'my-wrapper'] });
  assert.equal(f.value.serpens_sdd.invocation, 'my-wrapper');
  assert.equal(f.sources['serpens_sdd.invocation'], 'flag');

  const a = await resolveInputs({ ...base, tty: false, argv: ['--project', 'p', '--serpens-sdd', 'aliased'] });
  assert.equal(a.value.serpens_sdd.invocation, 'aliased');

  const c = await resolveInputs({ ...base, tty: false, argv: ['--project', 'p'], config: { serpens_sdd: { invocation: 'from-config' } } });
  assert.equal(c.value.serpens_sdd.invocation, 'from-config');
  assert.equal(c.sources['serpens_sdd.invocation'], 'config');

  const e = await resolveInputs({ ...base, tty: false, argv: ['--project', 'p'], env: { SERPENS_SDD_INVOCATION: 'from-env' } });
  assert.equal(e.value.serpens_sdd.invocation, 'from-env');
});
