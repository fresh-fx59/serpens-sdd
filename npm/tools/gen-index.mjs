#!/usr/bin/env node
// No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
// gen-index.mjs — generates serpens/index.json + index.md from openspec/specs/ (+ optional build/modules.txt).
// Deterministic across machines: byte-wise sort (no locale), digest built from sorted content,
// repo name from committed serpens/repo.txt (never from the checkout folder name).
// --check: regenerate in memory and diff against committed files; exit 1 on drift.
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { LAYOUT, SERPENS_DIR } from '../src/layout.mjs';

// Root resolution: an explicit positional root always wins. With none given, fall back to the
// git worktree root (like check-openspec-root.sh and repository-state.sh already do), never the
// bare process cwd — a caller running this from inside openspec/ (or anywhere else nested) must
// not have it silently write a phantom store under the subdirectory it happened to stand in.
// `resolve('.')` is the last-resort fallback only when git itself is unavailable/fails.
function resolveRoot(explicit) {
  if (explicit) return resolve(explicit);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return resolve('.');
  }
}

const CHECK = process.argv.includes('--check');
const ROOT = resolveRoot(process.argv.filter(a => !a.startsWith('--'))[2]);
const osDir = join(ROOT, 'openspec');      // OpenSpec's directory — we only READ specs/ from it
const specsDir = join(osDir, 'specs');
const outDir = join(ROOT, SERPENS_DIR);    // ours — where the generated index and repo.txt live
const repoTxt = join(ROOT, LAYOUT.repoTxt);

// repo identity is committed data, not the folder name (CI workspaces, worktrees, renamed clones)
const repoName = existsSync(repoTxt) ? readFileSync(repoTxt, 'utf8').trim() : basename(ROOT);

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); // byte-wise, locale-independent
// A capability is a DIRECTORY CONTAINING spec.md, identified by its path relative to
// openspec/specs/ with forward slashes — `user-auth`, or `identity/user-auth`.
//
// It used to be a single-level `readdirSync`, which was blind to nesting. That is not an exotic
// layout: OpenSpec's own proposal template recommends it — *"Use kebab-case for path segments you
// introduce (e.g., `user-auth` or `identity/user-auth`) ... Each creates
// specs/<capability-path>/spec.md"*. A repository following that advice got
// `✗ openspec/specs/identity/: capability dir has no spec.md` from the lint and `capabilities: []`
// from the index, so a real OpenSpec user was red on arrival.
//
// A directory holding no spec.md is only a PROBLEM when nothing beneath it is a capability
// either; a pure container like `identity/` is legal. Descent continues through a capability, so
// a spec nested under a spec is found rather than hidden.
//
// NOTE: duplicated verbatim in tools/gen-index.mjs and tools/serpens-lint.mjs. Each vendored tool
// must run standalone, so they cannot share a module; `test/nested-capabilities.test.mjs` asserts
// the two agree on the same tree, which is what makes the duplication safe.
function findCapabilities(specsDir) {
  const capabilities = [];
  const emptyDirs = [];
  const walk = (abs, rel) => {
    let found = false;
    if (existsSync(join(abs, 'spec.md'))) { capabilities.push(rel); found = true; }
    let sub = [];
    try { sub = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { sub = []; }
    for (const d of sub) {
      if (walk(join(abs, d.name), rel ? `${rel}/${d.name}` : d.name)) found = true;
    }
    if (!found && rel) emptyDirs.push(rel);
    return found;
  };
  if (existsSync(specsDir)) walk(specsDir, '');
  capabilities.sort();
  emptyDirs.sort();
  return { capabilities, emptyDirs };
}

const caps = [];
const texts = {};
// Dirs with no spec.md are serpens-lint's problem, not the index's — findCapabilities reports
// them separately and this ignores them.
for (const id of findCapabilities(specsDir).capabilities) {
  const specPath = join(specsDir, id, 'spec.md');
  const txt = readFileSync(specPath, 'utf8');
  texts[id] = txt;
  const title = txt.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;
  const summary = (txt.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '').trim().slice(0, 200);
  caps.push({ id, title, path: `openspec/specs/${id}/spec.md`, summary });
}
caps.sort(byId);

let modules = [];
const modFile = join(ROOT, 'build', 'modules.txt'); // produced by the build: mvn/gradle module list
if (existsSync(modFile)) {
  modules = readFileSync(modFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean).sort(); // default sort = code-unit order
}

// digest over SORTED content so filesystem readdir order can never change it
const digestInput = [repoName, ...caps.map(c => c.id + '\x00' + texts[c.id]), ...modules];
const index = {
  schema_version: 1,
  repo: repoName,
  source_digest: createHash('sha256').update(digestInput.join('\x01')).digest('hex').slice(0, 16),
  capabilities: caps,
  ...(modules.length ? { modules } : {}),
};
const json = JSON.stringify(index, null, 2) + '\n';

const md = [
  `# ${index.repo} — capability index`,
  '',
  `> GENERATED by \`serpens-sdd index\` — do not edit. digest: ${index.source_digest}`,
  '',
  // index.md lives in `serpens/`, so a link into OpenSpec's `specs/` must climb out first.
  ...caps.map(c => `- [${c.title}](../${c.path}) — ${c.summary}`),
  ...(modules.length ? ['', '## Modules', '', ...modules.map(m => `- ${m}`)] : []),
  '',
].join('\n');

const jsonPath = join(ROOT, LAYOUT.indexJson);
const mdPath = join(ROOT, LAYOUT.indexMd);

if (CHECK) {
  const cur = f => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  if (cur(jsonPath) !== json || cur(mdPath) !== md) {
    console.error(`✗ index drift: ${SERPENS_DIR}/index.* does not match current specs`);
    console.error(`  ↳ run: serpens-sdd index && git add ${LAYOUT.indexJson} ${LAYOUT.indexMd} ${LAYOUT.repoTxt}`);
    process.exit(1);
  }
  console.log('✓ index up to date');
} else {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(repoTxt)) writeFileSync(repoTxt, repoName + '\n'); // pin identity on first run — commit it
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, md);
  console.log(`✓ wrote ${LAYOUT.indexJson} + ${LAYOUT.indexMd} (${caps.length} capabilities, digest ${index.source_digest})`);
}
