import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage4 } from '../src/stages/stage4-submodules.mjs';
import { stage9 } from '../src/stages/stage9-accept.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';
import { toolPath } from '../src/cli/tools.mjs';
import { onboardPlan } from '../src/stages/stage5-onboard.mjs';
import { kitPath } from '../src/integrity.mjs';

// A `--lang ru` install must run the RU kit's DOCS under Russian prose, and the same
// language-neutral executables (from the package's own tools/) as `--lang en` — the ten tool
// scripts carry no prose, so `toolPath()` deliberately ignores `lang` (see src/cli/tools.mjs).
// Every wrapper call site is checked by recording what `run` was asked to execute.

/** A `run` stub that records every (cmd, args) it is handed and reports success. */
function recordingRun(records, { stdout = '' } = {}) {
  return async (cmd, args) => {
    records.push({ cmd, args });
    return { code: 0, stdout, stderr: '' };
  };
}

function storeFixture() {
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-lang-store-'));
  writeFileSync(join(storeRoot, 'project-repositories.json'), '{}\n', 'utf8');
  return storeRoot;
}

for (const lang of ['en', 'ru']) {
  test(`stage4 resolves the ${lang} kit's sync-submodules.sh`, async () => {
    const records = [];
    const storeRoot = storeFixture();
    const result = await stage4({
      config: { lang, store: { base_branch: 'main' } },
      run: recordingRun(records),
      storeRoot,
    });
    assert.equal(result.ok, true, result.error);
    const scriptArgs = records.map((r) => r.args.join(' ')).join('\n');
    assert.ok(scriptArgs.includes(toolPath('sync-submodules', lang)),
      `expected the shared tools/ path ${toolPath('sync-submodules', lang)} in:\n${scriptArgs}`);
  });

  test(`stage9 resolves the ${lang} kit's sync-submodules.sh`, async () => {
    const records = [];
    const storeRoot = storeFixture();
    const result = await stage9({
      config: { lang }, port: { id: 'claude' }, run: recordingRun(records), storeRoot,
    });
    assert.equal(result.ok, true, result.error);
    const scriptArgs = records.map((r) => r.args.join(' ')).join('\n');
    assert.ok(scriptArgs.includes(toolPath('sync-submodules', lang)));
  });

  test(`verify-docs runs the ${lang} kit's index/lint/split-brain`, async () => {
    const records = [];
    const repoRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-lang-repo-'));
    mkdirSync(join(repoRoot, 'openspec'), { recursive: true });
    // This test is purely about WHICH per-language script paths get dispatched — recordingRun
    // stubs every command as an instant success and writes nothing to disk, so none of
    // index.json/index.md/repo.txt actually exist here. checkGitTracking: false skips the
    // separate (and separately tested, in verify-docs.test.mjs) git-tracking gate, which is not
    // what this test is checking and would otherwise fail spuriously on a fixture with no real
    // git repo or index files at all.
    const result = await runVerifyDocs({
      repoRoot, run: recordingRun(records), lang, checkGitTracking: false,
    });
    assert.equal(result.ok, true, result.output);
    for (const name of ['index', 'lint', 'split-brain']) {
      const expected = toolPath(name, lang);
      assert.ok(records.some((r) => r.args.includes(expected)),
        `expected ${expected} to be executed, got:\n${records.map((r) => r.args.join(' ')).join('\n')}`);
    }
  });
}

for (const lang of ['en', 'ru']) {
  test(`stage5's onboarding resolves the ${lang} kit's gen-index and kit tools`, async () => {
    // onboardPlan is what onboardOne itself enumerates, and it resolves through the same
    // `resolveTool(..., lang)` call the real pass uses.
    const kitDir = kitPath(lang);
    const lines = onboardPlan({
      config: { lang, openspec: { invocation: 'openspec' }, store: { id: 's', remote: 'r' } },
      port: { id: 'claude', instruction_file: 'CLAUDE.md', scope_preference: ['project'] },
      kitDir,
    }, '/tmp/some-spoke').join('\n');
    assert.ok(lines.includes(toolPath('index', lang)), `expected the ${lang} gen-index path in:\n${lines}`);
    // repository-state.sh ships from the package's own tools/ now (Task 3), not from inside
    // the kit — so this is toolPath('state', lang), not a kitDir-relative scripts/tools path.
    assert.ok(lines.includes(toolPath('state', lang)));
    assert.ok(!lines.includes(kitPath(lang === 'en' ? 'ru' : 'en')));
  });
}

test('the two kits\' docs really are different paths, so the assertions above can fail', () => {
  assert.notEqual(kitPath('en'), kitPath('ru'));
  assert.match(kitPath('ru'), /kits\/ru$/);
});

test('toolPath is lang-invariant: the executables are language-neutral, unlike kitPath', () => {
  assert.equal(toolPath('sync-submodules', 'en'), toolPath('sync-submodules', 'ru'));
  assert.ok(!toolPath('sync-submodules', 'ru').includes('/kits/'));
});

// Step 4 of the coexistence spec (gap 4): the four self-triggering skills must bind to Serpens
// work only, in both languages, never to "ANY"/"ALL" (EN) or "ЛЮБОЙ"/"ВСЕХ" (RU) work.
import { readFileSync as readFileSyncForLang } from 'node:fs';
import { join as joinForLang } from 'node:path';

const SELF_TRIGGERING_SKILLS = ['spns-tdd', 'spns-verification', 'spns-debugging', 'spns-drill-down'];

function skillDescription(lang, skill) {
  const path = joinForLang(kitPath(lang), 'skills', skill, 'SKILL.md');
  const text = readFileSyncForLang(path, 'utf8');
  const m = /^description: (.*)$/m.exec(text);
  if (!m) throw new Error(`${path} has no description: line`);
  return m[1];
}

for (const skill of SELF_TRIGGERING_SKILLS) {
  test(`${skill}: EN description does not bind to ANY/ALL work and names .serpens.yaml`, () => {
    const description = skillDescription('en', skill);
    assert.doesNotMatch(description, /\b(ANY|ALL)\b/);
    assert.match(description, /\.serpens\.yaml/);
  });

  test(`${skill}: RU description does not bind to ЛЮБОЙ/ВСЕХ work and names .serpens.yaml`, () => {
    const description = skillDescription('ru', skill);
    assert.doesNotMatch(description, /ЛЮБОЙ|ВСЕХ/);
    assert.match(description, /\.serpens\.yaml/);
  });
}
