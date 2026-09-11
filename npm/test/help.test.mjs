import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHelp } from '../src/cli/help.mjs';
import helpMain from '../src/cli/help.mjs';

test('help names all seven workflow commands and all eleven tool commands', () => {
  const h = buildHelp({ port: 'gigacode', scope: 'user', lang: 'en', edition: '2026-08-26.8' });
  assert.equal(h.workflow.length, 7);
  assert.equal(h.commands.length, 11);
  assert.equal(h.install.port, 'gigacode');
  for (const c of [...h.workflow, ...h.commands]) assert.ok(c.purpose.length > 0, c.name);
});

test('--json output is machine-readable and stable', () => {
  const h = buildHelp({ port: 'qwen', scope: 'project', lang: 'ru', edition: '2026-08-26.8' });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(h)));
});

test('edition defaults from package.json serpensSddEdition when no env var is set', () => {
  const prev = process.env.SERPENS_SDD_EDITION;
  delete process.env.SERPENS_SDD_EDITION;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    let out = '';
    const orig = console.log;
    console.log = (s) => { out += s; };
    try {
      const code = helpMain(['--json']);
      assert.equal(code, 0);
    } finally {
      console.log = orig;
    }
    const h = JSON.parse(out);
    assert.equal(h.install.edition, pkg.serpensSddEdition);
  } finally {
    if (prev === undefined) delete process.env.SERPENS_SDD_EDITION;
    else process.env.SERPENS_SDD_EDITION = prev;
  }
});

test('help <unknown-name> exits 2', () => {
  const orig = console.error;
  let logged = '';
  console.error = (s) => { logged = s; };
  try {
    const code = helpMain(['no-such-command']);
    assert.equal(code, 2);
    assert.match(logged, /unknown command/);
  } finally {
    console.error = orig;
  }
});
