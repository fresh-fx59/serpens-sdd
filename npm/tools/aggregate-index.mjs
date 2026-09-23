#!/usr/bin/env node
// No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
// aggregate-index.mjs — build the store catalog from registered Git submodules.
// Central = routing hint only. Invalid/missing spoke index => RED + last-good data.
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LAYOUT } from '../src/layout.mjs';

const STRICT = process.argv.includes('--strict');
const rootArg = process.argv.slice(2).find(a => !a.startsWith('--')) ?? '.';
const ROOT = realpathSync(resolve(rootArg));
const modulesPath = join(ROOT, '.gitmodules');

// Repo-local topology (step 6, gap 3): one repository, no system store, so there is no catalog
// to build. `serpens/topology` is read (not the config file, which is absent at hook time) at
// ROOT and at ROOT's git top-level, and the tool refuses instead of writing a phantom catalog.
function isRepoLocal(dir) {
  const p = join(dir, LAYOUT.topology);
  return existsSync(p) && readFileSync(p, 'utf8').trim() === 'repo-local';
}
let topLevel = ROOT;
try {
  topLevel = execFileSync('git', ['-C', ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* not a git repository: ROOT alone is checked */ }
if (isRepoLocal(ROOT) || isRepoLocal(topLevel)) {
  console.error(`✗ catalog: ${topLevel} is a repo-local install (${LAYOUT.topology} = repo-local) — there is no system store and no submodules, so there is no catalog to build. Its own index is serpens/index.json (serpens-sdd index).`);
  process.exit(2);
}

function gitConfig(pattern) {
  if (!existsSync(modulesPath)) return '';
  try {
    return execFileSync('git', ['-C', ROOT, 'config', '-f', '.gitmodules', '--get-regexp', pattern], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status === 1) return '';
    console.error(`✗ cannot read .gitmodules: ${error.message}`);
    process.exit(2);
  }
}

const fields = new Map();
for (const line of gitConfig('^submodule\..*\.(path|url|branch)$').split('\n')) {
  if (!line) continue;
  const split = line.indexOf(' ');
  const key = line.slice(0, split);
  const value = line.slice(split + 1);
  const match = key.match(/^submodule\.(.*)\.(path|url|branch)$/);
  if (!match) continue;
  const [, name, field] = match;
  if (!fields.has(name)) fields.set(name, {});
  fields.get(name)[field] = value;
}

// Input gate: names and paths become filesystem paths; validate all before writes.
const repos = [];
for (const [name, values] of fields) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    console.error(`✗ invalid submodule name "${name}"`);
    process.exit(2);
  }
  const expectedPath = `submodules/${name}`;
  if (values.path !== expectedPath) {
    console.error(`✗ invalid submodule path for ${name}: "${values.path ?? ''}"; expected "${expectedPath}"`);
    process.exit(2);
  }
  if (!values.url || /\s/.test(values.url)) {
    console.error(`✗ invalid submodule URL for ${name}`);
    process.exit(2);
  }
  if (!values.branch || /\s/.test(values.branch)) {
    console.error(`✗ missing or invalid submodule branch for ${name}`);
    process.exit(2);
  }
  repos.push({ name, url: values.url, base_branch: values.branch, path: values.path });
}

// keep-last-good: carry a red repo's previous entry, marked stale, instead of dropping it
const prevPath = join(ROOT, 'catalog.json');
const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : { entries: [] };
const prevByName = new Map((prev.entries ?? []).map(e => [e.name, e]));

const entries = [], red = [];
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); // byte-wise, locale-independent
for (const r of [...repos].sort(byName)) {
  const repoDir = join(ROOT, r.path);
  const idxPath = join(repoDir, LAYOUT.indexJson);
  try {
    if (!existsSync(repoDir)) throw new Error('submodule missing — run serpens-sdd sync-submodules');
    if (!existsSync(idxPath)) throw new Error(`${LAYOUT.indexJson} missing — repo not onboarded or index not generated`);
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    if (!Array.isArray(idx.capabilities)) throw new Error('index.json has no capabilities[] — regenerate in the repo');
    const head = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    entries.push({ name: r.name, url: r.url, base_branch: r.base_branch, head, digest: idx.source_digest, capabilities: idx.capabilities.map(c => ({ id: c.id, title: c.title, summary: c.summary })) });
  } catch (e) {
    red.push({ name: r.name, reason: e.message });
    const lastGood = prevByName.get(r.name);
    if (lastGood) entries.push({ ...lastGood, name: r.name, url: r.url, base_branch: r.base_branch, stale: true, stale_reason: e.message });
  }
}
entries.sort(byName);

const catalog = { schema_version: 1, entries, red };
writeFileSync(join(ROOT, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

const md = [
  '# System catalog',
  '',
  '> GENERATED by `serpens-sdd catalog` — routing hints only. The repo index is the authority; the repo itself outranks its index.',
  '',
  ...(red.length ? ['## 🔴 RED — fix before trusting the catalog', '', ...red.map(x => `- **${x.name}**: ${x.reason}`), ''] : []),
  ...entries.flatMap(e => [
    `## ${e.name}${e.stale ? ' ⚠ STALE (last-good data; see RED above)' : ''}`,
    '',
    `repo: ${e.url} · base \`${e.base_branch}\` · HEAD \`${e.head}\` · digest \`${e.digest}\``,
    '',
    ...e.capabilities.map(c => `- **${c.id}** — ${c.summary}`),
    '',
  ]),
].join('\n');
writeFileSync(join(ROOT, 'catalog.md'), md);

console.log(`✓ catalog: ${entries.length} entries (${entries.filter(e => e.stale).length} stale), ${red.length} red`);
if (red.length) {
  for (const x of red) console.error(`  🔴 ${x.name}: ${x.reason}`);
  if (STRICT) process.exit(1);
}
