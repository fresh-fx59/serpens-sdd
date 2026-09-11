#!/usr/bin/env node
// corp-version: 2026-08-26.8
// check-contract-split-brain.mjs — the split-brain lint. Zero dependencies.
//
// Rule (design §"one spec-truth"): a cross-repo contract fact lives in exactly ONE place — the
// system store. A spoke repo LINKS the store contract; it never restates the shape. OpenSpec's
// `references:` guarantees the tool never inlines store content, but nothing stops a human or an
// agent from pasting the payload into a spoke's delta by hand. This catches that.
//
// Scope: only repos that declare `references:` in openspec/config.yaml. Others exit 0 immediately.
// Checks a spoke's specs (living + change deltas) against every referenced store's contract
// sources — living specs AND the delta specs and store-contract.md of its ACTIVE changes — for:
//   1. a restated `### Requirement:` heading   → ERROR
//   2. a copied fenced code block (the shape)  → ERROR
// Missing/unregistered store → WARN (environmental, never blocks a commit).
// Exit 1 on any ERROR. WARNs never block.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(process.argv[2] ?? '.');
const CONFIG = join(ROOT, 'openspec', 'config.yaml');

const errors = [];
const warns = [];

// ---- 1. references: from the spoke's config -------------------------------------------------
// Deliberately a line parser, not a YAML dependency: the disposer must stay zero-dependency on a
// restricted network. Three forms are legal upstream and all three must yield the bare store id —
// a scalar item, the `{id, remote}` map form (which the CLI accepts and SETUP recommends, because
// the remote turns an unregistered store into a pasteable clone+register line), and the inline
// list. Reading the map form as the literal string `id: <store-id>` would leave every id
// unresolvable and downgrade this whole check to a warning nobody reads.
function readReferences(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  let inBlock = false;
  let pendingMap = false;                    // inside a `- id: x` item, skipping its other keys
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^references:\s*$/.test(line)) { inBlock = true; pendingMap = false; continue; }
    if (inBlock) {
      const m = line.match(/^\s+-\s+(.+?)\s*$/);
      if (m) {
        const item = m[1].replace(/^["']|["']$/g, '');
        const mapped = item.match(/^id:\s*(.+?)\s*$/);
        out.push((mapped ? mapped[1] : item).replace(/^["']|["']$/g, ''));
        pendingMap = Boolean(mapped);
        continue;
      }
      // continuation keys of a map item (`    remote: …`) belong to the id just pushed
      if (pendingMap && /^\s+[A-Za-z_][\w-]*:\s*/.test(line)) continue;
      if (line.trim() === '' || line.startsWith('#')) continue;
      inBlock = false; pendingMap = false;   // any other top-level key ends the list
    }
    // inline form: references: [a, b]
    const inline = line.match(/^references:\s*\[(.*)\]\s*$/);
    if (inline) out.push(...inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
  }
  return [...new Set(out.filter(Boolean))];
}

const refs = readReferences(CONFIG);
if (refs.length === 0) {
  console.log('✓ split-brain: no references declared — nothing to check');
  process.exit(0);
}

// ---- 2. resolve each store id through OpenSpec's own registry --------------------------------
// ~/.local/share/openspec/stores/registry.yaml, written by `openspec store register`.
// Same flat shape every time, so a line parser is exact here.
const REGISTRY = process.env.OPENSPEC_STORE_REGISTRY
  ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'openspec', 'stores', 'registry.yaml');

function readRegistry(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  let currentId = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const id = raw.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
    if (id) { currentId = id[1]; continue; }
    const p = raw.match(/^\s+local_path:\s*(.+?)\s*$/);
    if (p && currentId) map.set(currentId, p[1].replace(/^["']|["']$/g, ''));
  }
  return map;
}

const registry = readRegistry(REGISTRY);

// ---- 3. build the contract fingerprint from every referenced store ----------------------------
const normHeading = s => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.:;,]+$/, '');
const normBlock = s => s.split('\n').map(l => l.trim()).filter(Boolean).join('\n');

function specFiles(dir, names = ['spec.md']) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...specFiles(p, names));
    else if (names.includes(e.name)) out.push(p);
  }
  return out;
}

function headingsAndBlocks(text) {
  const headings = [];
  for (const m of text.matchAll(/^###\s+Requirement:\s*(.+)$/gm)) headings.push(normHeading(m[1]));
  const blocks = [];
  for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    const body = normBlock(m[1]);
    if (body.split('\n').length >= 2) blocks.push(body);   // one-liners are too common to be evidence
  }
  return { headings, blocks };
}

const contractHeadings = new Map();   // normalized heading -> "storeId:specId"
const contractBlocks = new Map();     // normalized block    -> "storeId:specId"

for (const id of refs) {
  const storePath = registry.get(id);
  if (!storePath) {
    warns.push(`store '${id}' is referenced but not registered on this machine — cannot verify contract facts\n     ↳ run: openspec store register <path> --id ${id} --yes`);
    continue;
  }
  const specsDir = join(storePath, 'openspec', 'specs');
  const changesDir = join(storePath, 'openspec', 'changes');
  // A contract is fingerprinted from the moment it is WRITTEN, not from the moment it is archived.
  // The kit merges the store contract LAST, so for the whole cross-repo window the contract exists
  // only at <store>/openspec/changes/<change-id>/specs/<spec-id>/spec.md — and a lint that reads
  // living specs alone is blind for exactly the window it exists to protect. `store-contract.md`
  // is read for the same reason: the kit's own template keeps the SHAPE there, so a lint that never
  // opens that file can never catch a copied shape.
  const storeSources = [
    ...specFiles(specsDir).map(f => [f, relative(specsDir, f).split(/[\\/]/)[0]]),
    ...specFiles(changesDir, ['spec.md', 'store-contract.md'])
      .map(f => [f, relative(changesDir, f).split(/[\\/]/)[0]]),
  ];
  if (storeSources.length === 0) {
    warns.push(`store '${id}' has no contract sources at ${storePath} (neither openspec/specs nor an active change with a delta)`);
    continue;
  }
  for (const [f, specId] of storeSources) {
    const { headings, blocks } = headingsAndBlocks(readFileSync(f, 'utf8'));
    for (const h of headings) if (!contractHeadings.has(h)) contractHeadings.set(h, `${id}:${specId}`);
    for (const b of blocks) if (!contractBlocks.has(b)) contractBlocks.set(b, `${id}:${specId}`);
  }
}

// ---- 4. scan this repo's specs ----------------------------------------------------------------
const targets = [
  ...specFiles(join(ROOT, 'openspec', 'specs')),
  ...specFiles(join(ROOT, 'openspec', 'changes')),
].filter(f => !f.includes(`${'archive'}/`) || process.env.SPLIT_BRAIN_INCLUDE_ARCHIVE === '1');

for (const f of targets) {
  const rel = relative(ROOT, f);
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const m = line.match(/^###\s+Requirement:\s*(.+)$/);
    if (!m) return;
    const owner = contractHeadings.get(normHeading(m[1]));
    if (owner) {
      errors.push(`${rel}:${i + 1}: restates contract requirement "${m[1].trim()}" owned by ${owner}\n     ↳ delete it here and link the store spec instead: \`openspec show ${owner.split(':')[1]} --type spec --store ${owner.split(':')[0]}\``);
    }
  });

  for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    const body = normBlock(m[1]);
    if (body.split('\n').length < 2) continue;
    const owner = contractBlocks.get(body);
    if (owner) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      errors.push(`${rel}:${lineNo}: copies a contract shape owned by ${owner}\n     ↳ contract shapes live in the store only — reference it, never paste it`);
    }
  }
}

// ---- 5. report --------------------------------------------------------------------------------
for (const w of warns) console.log(`  ⚠ ${w}`);
for (const e of errors) console.error(`  ✗ ${e}`);

if (errors.length) {
  console.error(`✗ split-brain: ${errors.length} contract fact(s) restated in this repo`);
  process.exit(1);
}
console.log(`✓ split-brain: no contract facts restated (checked ${targets.length} spec file(s) against ${contractHeadings.size} store requirement(s))`);
