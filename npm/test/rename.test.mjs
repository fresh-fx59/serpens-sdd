// Edition 2026-09-09.1 — the rename gate. Five assertions the spec
// (rename-spec-serpens-sdd-2026-09-09.md §6) requires, each one a name that used to be `corp`
// and now must not be, anywhere the rename could regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SHIM_INVOCATION, writeShim } from '../src/shim.mjs';
import { assertLintScope } from '../src/scope.mjs';
import { run } from '../src/run.mjs';
import { resolveKitSource } from '../scripts/kit-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const VAULT_ROOT = join(PKG_ROOT, '..');
const KITS = [resolveKitSource('en'), resolveKitSource('ru')];

// The word "corporate"/"корпоративный" is the product's SUBJECT and must survive the rename.
// Everything else spelled corp is a leftover. Measured after the rename: two English
// `corporate` in each kit's docs/SETUP.md line 34 ("the corporate agent port name") and six
// Russian `корпоратив*` in the RU tree. `corpus` appears in the deck quoting Zoekt's docs.
const ALLOWED = /corporate|корпоратив|corpus/i;
const LEFTOVER = /\bcorp[-_. ]/i;

// `docs/UPGRADE.md` is the ONE file that must still spell the pre-rename names: its rename
// boundary section tells the installation agent which `corp-*` commands, `corp-*` skills,
// `tools/corp-sdd` shims and `corp.*` git config keys to delete and migrate. An upgrade that
// cannot name the old thing cannot remove it. Exempted here, and asserted positively below so
// the section can never be silently dropped.
// `docs/MIGRATION-71de101-to-current.md` is the second, and it exists ONLY in the published
// repository (`fresh-fx59/serpens-sdd`), never in this vault — the kit-source resolver reaches it
// once the package lives beside `en/` and `ru/` there. It is the runbook for migrating FROM the
// public `corp-sdd` at `71de101`, so naming `corp-*` skills and `Corp` commands is its entire
// subject; a migration document that cannot name what you are migrating from is useless.
// Surfaced by assembling the public layout for the first time — the gate had never seen it.
const NAMES_OLD_ON_PURPOSE = /docs\/(UPGRADE|MIGRATION-71de101-to-current)\.md$/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// --- 1. no leftover `corp` identifier anywhere in the package or either kit ---------------
test('no file in the package or either kit still carries a corp- identifier', () => {
  const roots = [join(PKG_ROOT, 'bin'), join(PKG_ROOT, 'src'), join(PKG_ROOT, 'tools'),
    join(PKG_ROOT, 'scripts'), join(PKG_ROOT, 'ports'), join(PKG_ROOT, 'kits'), ...KITS];
  const offenders = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (file.endsWith('.zip')) continue;
      if (NAMES_OLD_ON_PURPOSE.test(file)) continue;
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const [i, line] of text.split('\n').entries()) {
        if (LEFTOVER.test(line) && !ALLOWED.test(line)) {
          offenders.push(`${relative(VAULT_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}`);
});

test('no PATH in the package or either kit is still named corp', () => {
  const roots = [join(PKG_ROOT, 'kits'), ...KITS];
  const bad = roots.flatMap((r) => walk(r)).filter((f) => /(^|\/)corp[-_.]/i.test(relative(VAULT_ROOT, f)));
  assert.deepEqual(bad, []);
});

test('docs/UPGRADE.md still names every pre-rename identifier the migration must remove', () => {
  for (const kit of KITS) {
    const text = readFileSync(join(kit, 'docs', 'UPGRADE.md'), 'utf8');
    for (const needed of ['corp-*.md', 'corp-*', 'tools/corp-sdd', 'corp.$pair', '@fresh-fx59/corp-sdd']) {
      assert.ok(text.includes(needed), `${kit}/docs/UPGRADE.md no longer mentions ${needed}`);
    }
  }
});

// --- 2. commands are spns-*.md and skills are spns-* -------------------------------------
test('every shipped command file and skill directory carries the spns- prefix', () => {
  for (const kit of KITS) {
    const commands = readdirSync(join(kit, 'commands')).sort();
    assert.equal(commands.length, 7, `${kit}: expected 7 commands, got ${commands.join(', ')}`);
    for (const c of commands) assert.match(c, /^spns-[a-z-]+\.md$/, `${kit}/commands/${c}`);
    const skills = readdirSync(join(kit, 'skills')).sort();
    assert.equal(skills.length, 6, `${kit}: expected 6 skills, got ${skills.join(', ')}`);
    for (const s of skills) {
      assert.match(s, /^spns-[a-z-]+$/, `${kit}/skills/${s}`);
      assert.ok(existsSync(join(kit, 'skills', s, 'SKILL.md')), `${kit}/skills/${s}/SKILL.md missing`);
    }
  }
});

// --- 3. command_prefix in every command-capable port -------------------------------------
test('every command-capable port namespaces our commands as spns, never corp', () => {
  const dir = join(PKG_ROOT, 'ports');
  let capable = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const port = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!port.commands_supported) continue;
    capable += 1;
    assert.ok(['spns-', 'spns'].includes(port.command_prefix),
      `${f}: command_prefix is ${JSON.stringify(port.command_prefix)}`);
    assert.equal(port.command_prefix, port.command_layout === 'flat-prefixed' ? 'spns-' : 'spns', f);
  }
  assert.equal(capable, 31, 'expected 31 command-capable ports');
});

// --- 4. the generated shim is tools/serpens-sdd, and no tools/corp-sdd is ever written ----
test('writeShim writes tools/serpens-sdd and nothing named corp', () => {
  const repo = mkdtempSync(join(tmpdir(), 'serpens-shim-'));
  const written = writeShim(repo, { binPath: join(PKG_ROOT, 'bin', 'serpens-sdd.mjs') });
  const shim = join(repo, 'tools', 'serpens-sdd');
  assert.ok(existsSync(shim), 'tools/serpens-sdd must exist');
  assert.ok(!existsSync(join(repo, 'tools', 'corp-sdd')), 'tools/corp-sdd must NOT be written');
  assert.deepEqual(readdirSync(join(repo, 'tools')).sort(), ['serpens-sdd']);
  assert.ok(String(written).includes('serpens-sdd'));
  assert.ok(!readFileSync(shim, 'utf8').includes('corp-sdd'), 'the shim body must not mention corp-sdd');
  assert.ok(statSync(shim).mode & 0o111, 'the shim must be executable');
});

test('SHIM_INVOCATION resolves to tools/serpens-sdd under the repository root', () => {
  assert.equal(SHIM_INVOCATION, '"$(git rev-parse --show-toplevel)"/tools/serpens-sdd');
});

// --- 5. serpens.agentDir is the key, and a leftover corp.agentDir is NOT consulted --------
function seedRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'serpens-cfg-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const agentRoot = join(repo, '.gigacode');
  mkdirSync(agentRoot, { recursive: true });
  return { repo, agentRoot };
}

test('assertLintScope reads git config serpens.agentDir', async () => {
  const { repo, agentRoot } = seedRepo();
  execFileSync('git', ['config', 'serpens.agentDir', '.gigacode'], { cwd: repo });
  const r = await assertLintScope({ repoRoot: repo, agentRoot, run });
  assert.equal(r.ok, true, r.error);
});

test('a leftover corp.agentDir is NOT consulted — an unmigrated repository fails loudly', async () => {
  const { repo, agentRoot } = seedRepo();
  // Exactly the state an upgrade leaves behind if it rewrites nothing: the OLD key still set,
  // the new one absent. This must fail, not silently pass by reading the pre-rename key.
  execFileSync('git', ['config', 'corp.agentDir', '.gigacode'], { cwd: repo });
  const r = await assertLintScope({ repoRoot: repo, agentRoot, run });
  assert.equal(r.ok, false, 'a repository carrying only the pre-rename key must NOT pass');
  assert.match(r.error, /serpens\.agentDir/);
});
