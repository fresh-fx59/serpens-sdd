import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configTemplate } from '../src/config-template.mjs';
import { validateConfig } from '../src/config.mjs';
import { SUPPORTED_MINORS } from '../src/openspecversion.mjs';

test('configTemplate is valid JSON and passes validateConfig with zero errors', () => {
  const text = configTemplate('en');
  const parsed = JSON.parse(text);
  assert.equal(typeof parsed.schema_version, 'number', 'schema_version must be numeric, not a string');
  assert.equal(parsed.schema_version, 1);

  const result = validateConfig(parsed, { checkoutRoot: process.cwd(), resolveFrom: process.cwd() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('configTemplate\'s default invocation always tracks SUPPORTED_MINORS[0], never a hand-typed literal', () => {
  // A frozen `@latest` would drift PAST the support window the moment upstream ships a new
  // minor (every fresh install then fails stage 0 with no configuration change by anyone).
  // The template's invocation must instead be a caret range built FROM SUPPORTED_MINORS[0], so
  // bumping the window without touching this file can never leave the two disagreeing.
  const parsed = JSON.parse(configTemplate('en'));
  assert.equal(parsed.openspec.invocation, `npx @fission-ai/openspec@^${SUPPORTED_MINORS[0]}.0`);
  assert.doesNotMatch(parsed.openspec.invocation, /@latest\b/, 'must not float to an unsupported future minor');
});

test('configTemplate honors the lang argument', () => {
  const parsed = JSON.parse(configTemplate('ru'));
  assert.equal(parsed.lang, 'ru');
});

test('configTemplate shows every field spec §4 documents, including port_scope and store.id', () => {
  const parsed = JSON.parse(configTemplate('en'));
  // Spec §4's printed template — the shape `--config` reads back in. A field missing here is a
  // field an operator has no way to discover from `--print-config-template`.
  assert.equal(parsed.port_scope, 'auto');
  assert.equal(typeof parsed.store.id, 'string');
  assert.match(parsed.store.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'store.id must be lower-case kebab-case (§4 rule 1)');
  for (const key of ['schema_version', 'project', 'lang', 'port', 'port_scope', 'openspec', 'store', 'repositories', 'facts']) {
    assert.ok(key in parsed, `template is missing ${key}`);
  }
  for (const key of ['remote', 'base_branch', 'id', 'root']) {
    assert.ok(key in parsed.store, `template's store is missing ${key}`);
  }
});
