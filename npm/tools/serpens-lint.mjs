#!/usr/bin/env node
// No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
// serpens-lint.mjs — deterministic disposer for agent-written docs. Zero dependencies.
// Scope: openspec/, serpens/, and the agent home of whatever CLI this port runs
// (never lints build output or source code docs). The agent home is NEVER hard-coded:
// it is SERPENS_AGENT_DIR, else `git config serpens.agentDir`, else the one dot-directory at the
// repository root that contains a `skills/` subdirectory. Root instruction files
// (an AGENTS.md-style file under any name) are linted by shape: ALL-CAPS .md at the root,
// minus the usual project files.
// Checks: hard file caps, index<->spec bijection + index schema, relative links + anchors,
// embedded snippets vs source, tasks.md state header, delta-spec sections.
// Every ERROR carries a remediation hint. Exit 1 on any ERROR; WARNs never block.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { LAYOUT, SERPENS_DIR, HARD_RULE_MARKER } from '../src/layout.mjs';
import { isOwnedChange } from '../src/ownership.mjs';

// Root resolution: an explicit positional root always wins. With none given, fall back to the
// git worktree root (like check-openspec-root.sh and repository-state.sh), never the bare
// process cwd — running this from a nested subdirectory must resolve to the real repo root.
function resolveRoot(explicit) {
  if (explicit) return resolve(explicit);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return resolve('.');
  }
}
const ROOT = resolveRoot(process.argv[2]);

// The agent home is discovered, never named: a port may call it anything.
function discoverAgentDir() {
  const configured = process.env.SERPENS_AGENT_DIR
    || (() => { try { return execFileSync('git', ['-C', ROOT, 'config', '--get', 'serpens.agentDir'],
      { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  if (configured) return configured.replace(/^\.\//, '').replace(/\/+$/, '');
  const found = readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('.') && e.name !== '.git'
                 && existsSync(join(ROOT, e.name, 'skills')))
    .map(e => e.name)
    .sort();
  if (found.length > 1) {
    console.error(`✗ ${found.join(', ')}: more than one agent home found`);
    console.error(`   ↳ set SERPENS_AGENT_DIR or \`git config serpens.agentDir <dir>\` so the lint knows which one to read`);
    process.exit(1);
  }
  return found[0] ?? '';
}
const AGENT_DIR = discoverAgentDir();
// `serpens/`, not `docs/`: this kit owns exactly one directory, and a team's own `docs/` tree is
// none of our business — putting it under our line caps was an accident of where our one
// document used to sit.
const SCOPES = ['openspec', SERPENS_DIR, AGENT_DIR].filter(Boolean)
  .map(d => join(ROOT, d)).filter(existsSync);

// Root instruction files (the port's AGENTS.md analogue, under whatever name it uses).
const ROOT_DOC_SKIP = new Set(['README.md', 'LICENSE.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'SECURITY.md', 'CODE_OF_CONDUCT.md', 'NOTICE.md']);
const rootDocs = readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isFile() && /^[A-Z0-9_]+\.md$/.test(e.name) && !ROOT_DOC_SKIP.has(e.name))
  .map(e => join(ROOT, e.name));

// ---- hardcoded caps (lines). The write-boundary contract: exceed => rejected, never trimmed.
const CAPS = [
  [new RegExp(`(^|/)${LAYOUT.indexMd.replaceAll('.', '\\.')}$`), 300],
  [/(^|\/)openspec\/specs\/.+\/spec\.md$/, 400],
  [/(^|\/)openspec\/changes\/.+\/tasks\.md$/, 200],
  [/(^|\/)openspec\/changes\/.+\/research\.md$/, 400],
  [/(^|\/)openspec\/changes\/.+\/proposal\.md$/, 200],
  // Only OUR skills. A port's own CLI ships skills of its own under the same directory — on a
  // stock `openspec init` two of them are over 300 lines — and capping a file this kit neither
  // writes nor may edit turns every fresh install red with no sanctioned fix.
  [new RegExp(`(^|/)${AGENT_DIR.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/skills/spns-[^/]+/.+\\.md$`), 250],
];

const errors = [], warns = [];
const err = (f, m, hint) => errors.push(`  ✗ ${f}: ${m}\n     ↳ ${hint}`);
const warn = (f, m, hint) => warns.push(`  • ${f}: ${m}\n     ↳ ${hint}`);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const rel = p => relative(ROOT, p).split(sep).join('/');
const mdFiles = [...SCOPES.flatMap(s => [...walk(s)]).filter(p => p.endsWith('.md')), ...rootDocs];

// ---- ownership scoping (gap 1, serpens-openspec-coexistence-gaps-2026-09-22.md, step 3).
// Before this, every check below judged EVERY dir under openspec/changes/ the same way — a
// hand-made (vanilla) OpenSpec change with no `## Why` or no state header went red exactly like
// one of ours. Change-level rules now apply only to a MARKED change dir (`.serpens.yaml`,
// `owner: serpens-sdd` — src/ownership.mjs). An unmarked one is silently skipped by each check
// below and counted once, reported as a single WARN line at the end — never an error.
const changesRootDir = join(ROOT, 'openspec', 'changes');
const activeChangeIds = existsSync(changesRootDir)
  ? readdirSync(changesRootDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'archive')
      .map(e => e.name)
  : [];
const unmarkedChangeIds = activeChangeIds.filter(id => !isOwnedChange(join(changesRootDir, id)));

// True iff the `openspec/changes/<id>/...` (or `openspec/changes/archive/<id>/...`) relative
// path `r` belongs to a MARKED change. A path outside `openspec/changes/` is not this question's
// business and answers false (callers only ask it after already matching a changes/ regex).
function isChangeOwnedByRelPath(r) {
  let m = r.match(/^openspec\/changes\/archive\/([^/]+)\//);
  if (m) return isOwnedChange(join(changesRootDir, 'archive', m[1]));
  m = r.match(/^openspec\/changes\/([^/]+)\//);
  if (m && m[1] !== 'archive') return isOwnedChange(join(changesRootDir, m[1]));
  return false;
}

// Which capabilities a MARKED change (active or archived) touches, via its specs/<cap>/*.md
// delta files. Main-spec caps and the index<->spec bijection stay ERRORS only for these; every
// other capability downgrades to WARN, so a vanilla `openspec archive` commit that happens to
// update a main spec we never asked about does not go red on our gate.
function touchedCapabilitiesSet() {
  const caps = new Set();
  const dirs = activeChangeIds.map(id => join(changesRootDir, id));
  const archiveDir = join(changesRootDir, 'archive');
  if (existsSync(archiveDir)) {
    for (const e of readdirSync(archiveDir, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(join(archiveDir, e.name));
    }
  }
  for (const d of dirs) {
    if (!isOwnedChange(d)) continue;
    const specsSubdir = join(d, 'specs');
    if (!existsSync(specsSubdir)) continue;
    for (const f of walk(specsSubdir)) {
      if (!f.endsWith('.md')) continue;
      const capRel = relative(specsSubdir, dirname(f)).split(sep).join('/');
      if (capRel && capRel !== '.') caps.add(capRel);
    }
  }
  return caps;
}
const touchedCapabilities = touchedCapabilitiesSet();

// ---- root instruction files: only the HARD RULE block we ourselves appended is in scope, never
// the rest of a team's own file (gap 1 correction: a team's CLAUDE.md used to be linted whole).
const rootDocSet = new Set(rootDocs);
function extractHardRuleBlock(text) {
  const idx = text.indexOf(HARD_RULE_MARKER);
  if (idx === -1) return '';
  const after = text.slice(idx + HARD_RULE_MARKER.length);
  const m = after.match(/\n##\s+/);
  return m ? text.slice(idx, idx + HARD_RULE_MARKER.length + m.index) : text.slice(idx);
}
function scopedRead(p) {
  const text = readFileSync(p, 'utf8');
  return rootDocSet.has(p) ? extractHardRuleBlock(text) : text;
}

// GitHub-style anchor slug. Unicode-aware on purpose: `\w` is ASCII-only, so a Cyrillic
// heading used to slug to the empty string and EVERY Russian anchor was reported broken.
const slug = h => h.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
const headingSlugs = txt => new Set(
  [...txt.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(m => slug(m[1]))
);
// strip fenced code (``` and ~~~), inline code, and HTML comments before link checks
const stripCode = txt => txt
  .replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
  .replace(/`[^`\n]*`/g, '').replace(/<!--[\s\S]*?-->/g, '');
// per-line fence tracking for the embed scanner
const fenceMask = lines => {
  const mask = []; let open = null;
  for (const l of lines) {
    const f = l.match(/^(```|~~~)/)?.[1];
    if (f && !open) { open = f; mask.push(true); continue; }
    if (f && open === f) { open = null; mask.push(true); continue; }
    mask.push(!!open);
  }
  return mask;
};

// ---- 1. caps
for (const p of mdFiles) {
  const r = rel(p);
  // Change-level caps (tasks.md/research.md/proposal.md under openspec/changes/, active or
  // archived) apply only to a marked change — see the ownership scoping above.
  if (/^openspec\/changes\//.test(r) && !isChangeOwnedByRelPath(r)) continue;
  for (const [re, cap] of CAPS) {
    if (re.test(r)) {
      const lines = readFileSync(p, 'utf8').split('\n').length;
      if (lines > cap) {
        const mainSpecMatch = r.match(/^openspec\/specs\/(.+)\/spec\.md$/);
        if (mainSpecMatch && !touchedCapabilities.has(mainSpecMatch[1])) {
          warn(r, `${lines} lines (hard cap ${cap}) — untouched by any Serpens-marked change`,
            'no marked change touches this capability, so this stays advisory; a vanilla openspec archive commit is not blocked by it');
          continue;
        }
        err(r, `${lines} lines (hard cap ${cap})`,
          `split content into references/ subfiles or tighten; caps are rejected-not-trimmed by design`);
      }
    }
  }
}

// ---- 2. serpens/index.json schema + bijection with openspec/specs/ (a capability = a dir WITH spec.md)
const idxPath = join(ROOT, LAYOUT.indexJson);
const specsDir = join(ROOT, 'openspec', 'specs');
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

const { capabilities: capDirs, emptyDirs } = findCapabilities(specsDir);
for (const d of emptyDirs) {
  err(`openspec/specs/${d}/`, 'directory holds no spec.md and no capability beneath it',
    'add spec.md (a capability IS its spec), or delete the dir');
}
if (existsSync(idxPath)) {
  let idx;
  try { idx = JSON.parse(readFileSync(idxPath, 'utf8')); }
  catch (e) { err(LAYOUT.indexJson, `invalid JSON: ${e.message}`, 'regenerate: serpens-sdd index'); }
  if (idx) {
    const allowed = new Set(['schema_version', 'repo', 'source_digest', 'capabilities', 'modules']);
    for (const k of Object.keys(idx)) if (!allowed.has(k))
      err(LAYOUT.indexJson, `unknown key "${k}"`, 'schema forbids extra keys (pollution gate); regenerate');
    for (const k of ['schema_version', 'repo', 'source_digest', 'capabilities']) if (!(k in idx))
      err(LAYOUT.indexJson, `missing required key "${k}"`, 'regenerate: serpens-sdd index');
    if (typeof idx.repo === 'string' && idx.repo.length > 80)
      err(LAYOUT.indexJson, 'repo name >80 chars', `shorten ${LAYOUT.repoTxt}`);
    const ids = new Set();
    for (const c of idx.capabilities ?? []) {
      for (const k of ['id', 'title', 'path', 'summary']) if (!(k in c))
        err(LAYOUT.indexJson, `capability missing "${k}"`, 'regenerate');
      // Kebab-case per PATH SEGMENT, slashes allowed between them: `identity/user-auth` is the
      // nested form OpenSpec's own proposal template recommends, and the old single-segment
      // pattern rejected it outright.
      if (c.id && !/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(c.id))
        err(LAYOUT.indexJson, `capability id "${c.id}" is not kebab-case path segments`,
          'rename each spec dir segment to kebab-case (e.g. identity/user-auth)');
      if (c.summary && c.summary.length > 200)
        err(LAYOUT.indexJson, `summary for "${c.id}" >200 chars`, 'first paragraph of the spec is the summary; shorten it');
      ids.add(c.id);
    }
    for (const d of capDirs) if (!ids.has(d)) {
      const hint = `regenerate: serpens-sdd index && git add ${SERPENS_DIR}/index.*`;
      if (touchedCapabilities.has(d)) err(LAYOUT.indexJson, `spec dir "${d}" missing from index`, hint);
      else warn(LAYOUT.indexJson, `spec dir "${d}" missing from index — untouched by any Serpens-marked change`, hint);
    }
    for (const id of ids) if (!capDirs.includes(id)) {
      const msg = `index lists "${id}" but openspec/specs/${id}/spec.md does not exist`;
      if (touchedCapabilities.has(id)) err(LAYOUT.indexJson, msg, 'regenerate the index');
      else warn(LAYOUT.indexJson, `${msg} — untouched by any Serpens-marked change`, 'regenerate the index');
    }
  }
} else if (capDirs.length) {
  err(LAYOUT.indexJson, 'missing but specs exist', 'generate: serpens-sdd index');
}

// ---- 3. relative links + anchors (skip external, skip code/comments)
// A root instruction file (a team's own CLAUDE.md/AGENTS.md/…) is scoped to the HARD RULE block
// we appended (scopedRead) — never the rest of the file, which is theirs (gap 1 correction).
for (const p of mdFiles) {
  const r = rel(p);
  const txt = stripCode(scopedRead(p));
  for (const m of txt.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [fp, anchor] = target.split('#');
    const abs = resolve(dirname(p), fp);
    if (!existsSync(abs)) {
      err(r, `broken link → ${target}`, 'fix the path or create the target');
      continue;
    }
    if (anchor && abs.endsWith('.md')) {
      const slugs = headingSlugs(readFileSync(abs, 'utf8'));
      if (!slugs.has(anchor)) err(r, `broken anchor → ${target}`, `no heading "#${anchor}" in ${rel(abs)}`);
    }
  }
}

// ---- 4. embedded snippets: <!-- embed: path#L3-L5 --> followed by a fence whose body must equal those lines
for (const p of mdFiles) {
  const r = rel(p);
  const lines = scopedRead(p).split('\n');
  const inFence = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue; // fenced examples are not directives
    const line = lines[i].trimEnd(); // trailing whitespace must not disable the check
    const m = line.match(/^<!--\s*embed:\s*(\S+?)#L(\d+)-L(\d+)\s*-->$/);
    if (!m) {
      // A directive is a whole line. Inside an inline-code span it is prose ABOUT the syntax —
      // documentation that explains the directive must not be reported as a broken one.
      const bare = line.replace(/`[^`]*`/g, '');
      if (/<!--.*embed:/.test(bare)) warn(r, `line ${i + 1} looks like an embed directive but does not parse`,
        'expected exactly: <!-- embed: relative/path#Lstart-Lend -->');
      continue;
    }
    const [, src, a, b] = m;
    const srcAbs = resolve(dirname(p), src);
    if (!existsSync(srcAbs)) { err(r, `embed source missing: ${src}`, 'fix the path'); continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (!lines[j]?.startsWith('```')) { err(r, `embed directive at line ${i + 1} not followed by a code fence`, 'add ``` fence right after the directive'); continue; }
    const fenceStart = j + 1;
    let k = fenceStart;
    while (k < lines.length && !lines[k].startsWith('```')) k++;
    const body = lines.slice(fenceStart, k).join('\n');
    const want = readFileSync(srcAbs, 'utf8').split('\n').slice(a - 1, +b).join('\n');
    if (body !== want) err(r, `embed drift at line ${i + 1} (${src}#L${a}-L${b})`,
      'source changed — re-copy the lines (or update the range); specs must embed live truth');
  }
}

// ---- 4b. proposal.md must carry the two headings `openspec show` parses.
// Measured on OpenSpec 1.10.0: a proposal without a literal `## Why` makes
// `show <change> --type change --json --deltas-only` fail with
// {"code":"show_error","message":"Change must have a Why section"} — the exact call every
// cross-repo spoke uses to read the contract — while `validate --strict` still reports
// "valid": true. Upstream validates one thing and its own reader requires another, so the
// change passes every gate and nobody can read it. That gap is ours to close.
for (const p of mdFiles.filter(p => /(^|\/)openspec\/changes\/[^/]+\/proposal\.md$/.test(rel(p)))) {
  const r = rel(p);
  if (!isChangeOwnedByRelPath(r)) continue; // unmarked (vanilla) change — not ours to judge
  const body = stripCode(readFileSync(p, 'utf8'));
  if (!/^##\s+Why\s*$/im.test(body))
    err(r, 'no "## Why" section',
        'add a literal `## Why` heading — without it `openspec show <change> --type change --json` fails with "Change must have a Why section", so no other repository can read this change');
  if (!/^##\s+What\s+Changes\s*$/im.test(body))
    err(r, 'no "## What Changes" section',
        'add a literal `## What Changes` heading — the schema expects it beside `## Why`');
}

// ---- 4c. port-facts.md must hold probed facts, not the template's placeholders.
// It is the file the whole install is supposed to be derived from — the agent home, the project
// instruction filename, the pinned CLI invocation, the store and repository ids — and until now
// nothing ever read it, so an install could run to completion on a file that still said "...".
{
  const pf = join(ROOT, LAYOUT.portFacts);
  if (existsSync(pf)) {
    const r = relative(ROOT, pf).split(sep).join('/');
    const txt = readFileSync(pf, 'utf8');
    const rows = txt.split('\n').filter(l => /^\|\s*P\d+\s*\|/.test(l));
    const unfilled = rows.filter(l => /\|\s*\.\.\.\s*\|/.test(l));
    if (rows.length === 0)
      err(r, 'no probed facts (no P-rows at all)',
          'fill the table from the real port: this file is where the agent home, the instruction filename, the pinned CLI invocation and the ids are recorded — see docs/SETUP.md stage 2');
    else if (unfilled.length)
      err(r, `${unfilled.length} of ${rows.length} probed fact(s) still hold the template placeholder "..."`,
          'run the probe and paste its verbatim output — an unfilled row means nobody proved that fact on this port');
    if (/probed YYYY-MM-DD|<port name \+ version>/.test(txt))
      err(r, 'header still holds the template placeholders',
          'record the real port name, version and probe date in the title line');
  }
}

// ---- 4d. a STARTED change directory must carry a delta spec UNLESS it legitimately has none.
// `skip_specs: true` is a first-class field of a change's `.openspec.yaml`
// (`dist/core/change-metadata/schema.js:34`); upstream then REFUSES a delta spec under a
// `skip_specs` change (`dist/core/validation/constants.js:34`) and reports the `specs`
// artifact as `skipped`, never missing. A change directory with no `specs/` is therefore not
// wrong by itself — only when nothing says it is deliberate.
//
// NOR is it wrong before the change has started. `openspec new change <id>` scaffolds a folder
// holding exactly one file, `.openspec.yaml` — no proposal.md, no specs/ — and upstream reports
// `specs` as `blocked` on `proposal` there, i.e. a delta spec is not yet owed. Failing that
// directory would fail a change upstream itself considers perfectly fine and would block
// repository-wide verification on one freshly scaffolded draft. `proposal.md` is therefore the
// started/not-started line: it is the first artifact of every change, the one `specs` depends
// on, and it exists on disk or it does not — no need to read or replay upstream's artifact
// graph (see spec-skipspecs-and-custom-schemas-2026-09-11 §6: that generalization is item 4b,
// explicitly deferred).
//
// So this fires on exactly one thing: a change that HAS a proposal — work started, upstream
// says the delta is owed — yet carries no delta spec and no `skip_specs: true`. That is a
// change nobody ever gave one: silently missing, not skipped on purpose.
{
  const changesDir = join(ROOT, 'openspec', 'changes');
  if (existsSync(changesDir)) {
    for (const e of readdirSync(changesDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'archive') continue;
      const changeAbs = join(changesDir, e.name);
      if (!isOwnedChange(changeAbs)) continue; // unmarked (vanilla) change — not ours to judge
      const changeRel = `openspec/changes/${e.name}`;
      const yamlPath = join(changeAbs, '.openspec.yaml');
      const skipSpecs = existsSync(yamlPath)
        && /^\s*skip_specs\s*:\s*true\s*$/m.test(readFileSync(yamlPath, 'utf8'));
      // Not started yet: `openspec new change` leaves only `.openspec.yaml` behind.
      const hasProposal = existsSync(join(changeAbs, 'proposal.md'));
      if (!hasProposal) continue;
      const specsSubdir = join(changeAbs, 'specs');
      const hasDeltaSpec = existsSync(specsSubdir) && walk(specsSubdir).some((f) => f.endsWith('.md'));
      if (!skipSpecs && !hasDeltaSpec) {
        err(`${changeRel}/`, 'no delta spec under specs/, and .openspec.yaml does not set skip_specs: true',
          `write the delta spec (\`<openspec> instructions specs --change ${e.name} --json\`), or if this `
          + 'change truly has no spec-level behavior change, set `skip_specs: true` in .openspec.yaml — '
          + 'never create an empty specs/ placeholder to silence this');
      }
    }
  }
}

// ---- 5. tasks.md state header + checkbox shape (nesting allowed)
for (const p of mdFiles.filter(p => /(^|\/)openspec\/changes\/[^/]+\/tasks\.md$/.test(rel(p)))) {
  const r = rel(p);
  if (!isChangeOwnedByRelPath(r)) continue; // unmarked (vanilla) change — not ours to judge
  const head = readFileSync(p, 'utf8').split('\n').slice(0, 5).join('\n');
  if (!/^As of \d{4}-\d{2}-\d{2} — .+/m.test(head))
    err(r, 'missing state header in first 5 lines', 'add a line: "As of YYYY-MM-DD — stage N, next: <action>" (overwrite it each session)');
  const bad = readFileSync(p, 'utf8').split('\n')
    .map((l, i) => [l, i + 1]).filter(([l]) => /^\s*-\s*\[/.test(l) && !/^\s*- \[( |x)\] \S/.test(l));
  for (const [, n] of bad) err(r, `malformed checkbox at line ${n}`, 'use "- [ ] task" or "- [x] task" (indentation for sub-tasks is fine)');
}

// ---- 6. delta specs: only the checks OpenSpec itself does NOT make.
// `openspec validate <change> --type change --strict --json` is the authority on delta-spec
// grammar, and every command that writes or reviews a spec runs it. Measured against the real
// CLI (1.10.0, 2026-08-25), it already errors on: a missing delta section, a `### ` heading that
// is not `### Requirement:` when it is the ONLY heading, an ADDED/MODIFIED requirement with no
// scenario, and a delta section with no requirement at all. Those four checks were removed from here rather than kept as a
// second, drifting implementation of the upstream parser.
// What survives below is what the CLI is measurably blind to:
//   * a requirement heading OUTSIDE any delta section — upstream drops it silently (valid=true),
//     so this error is the only thing between an agent and a lost requirement;
//   * a `### ` heading that is not `### Requirement:` in a file that ALSO has a good one —
//     upstream logs INFO, keeps valid=true, and drops that requirement from the deltas;
//   * SHALL/MUST — upstream agrees, but under --strict it BLOCKS; here it stays advisory;
//   * observability — no upstream concept at all.
// A `#### Сценарий: …` is a valid scenario upstream (SCENARIO_HEADER = /^####\s+/, any wording);
// only the structure keywords `Requirements` and `Requirement:` are hard-coded English.
const DELTA_SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/im;
for (const p of mdFiles.filter(p => /(^|\/)openspec\/changes\/[^/]+\/specs\/.+\.md$/.test(rel(p)))) {
  const r = rel(p);
  if (!isChangeOwnedByRelPath(r)) continue; // unmarked (vanilla) change — not ours to judge
  const txt = readFileSync(p, 'utf8');
  const body = stripCode(txt);
  // No delta section at all is an openspec ERROR ("No delta sections found …"); nothing to add here.
  if (!DELTA_SECTION.test(body)) continue;

  // MODIFIED / REMOVED / RENAMED need a living spec to act on. Measured on OpenSpec 1.10.0: a
  // MODIFIED delta against a capability that has no openspec/specs/<id>/spec.md validates as
  // "valid": true and then fails at fold time with
  //   archive_spec_update_failed: "<id>: target spec does not exist; only ADDED requirements are
  //   allowed for new specs. MODIFIED and RENAMED operations require an existing spec."
  // That failure lands post-merge, on the base branch, where recovery is manual — so it is caught
  // here, at authoring time, where the fix is one word.
  const capMatch = rel(p).match(/openspec\/changes\/[^/]+\/specs\/(.+)\/[^/]+\.md$/);
  const capability = capMatch ? capMatch[1] : null;
  if (capability) {
    for (const m of body.matchAll(/^##\s+(MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/gim)) {
      if (!existsSync(join(ROOT, 'openspec', 'specs', capability, 'spec.md'))) {
        err(r, `${m[1].toUpperCase()} targets capability "${capability}", which has no living spec`,
            `openspec/specs/${capability}/spec.md does not exist — openspec archive refuses this delta ("target spec does not exist; only ADDED requirements are allowed for new specs") AFTER the merge, while validate --strict still calls it valid; use ADDED for a new capability, or fix the capability directory name`);
        break;
      }
    }
  }

  // Walk the delta sections so each requirement is judged under the operation that owns it.
  const lines = body.split('\n');
  let op = null;              // current delta operation, or null before the first one
  let reqName = null;         // current requirement heading text
  let reqLine = 0;
  let scenarios = 0;          // level-4 headers seen in the current requirement
  let reqBody = '';
  let reqAll = '';            // heading + body + scenario text, for the observability check

  // A tester must be able to check the requirement from OUTSIDE the running system. This looks for
  // any sign of an observable surface: an HTTP verb or status code, a path, a topic or table, a
  // query, a queue. It is a WARNING like SHALL/MUST above — a hint at spec time, never a blocker,
  // because no regex can prove observability.
  const OBSERVABLE = /\b(GET|POST|PUT|PATCH|DELETE|HTTP|[1-5]\d\d\b|topic|топик|table|таблиц|column|колонк|SELECT|INSERT|payload|запрос|ответ|response|request|event|событ|dead-letter|DLQ|endpoint|эндпоинт)\b|\s\/[a-z0-9]/i;

  const closeRequirement = () => {
    if (reqName === null) return;
    if ((op === 'ADDED' || op === 'MODIFIED') && !/\b(SHALL|MUST)\b/.test(reqBody))
      warn(r, `requirement "${reqName}" (line ${reqLine}) states no SHALL/MUST`,
           'openspec treats the SHALL/MUST keyword as guidance unless --strict, but the normative verb belongs in the requirement text');
    if ((op === 'ADDED' || op === 'MODIFIED') && scenarios > 0 && !OBSERVABLE.test(reqAll))
      warn(r, `requirement "${reqName}" (line ${reqLine}) names no observable surface`,
           'a black-box tester must be able to send and observe it: name the endpoint, topic, table, status code or query in a scenario — a requirement only checkable from inside belongs to spns-autotest, not spns-test-plan');
    reqName = null;
  };

  lines.forEach((line, i) => {
    const delta = line.match(/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i);
    if (delta) { closeRequirement(); op = delta[1].toUpperCase(); return; }
    if (/^##\s+/.test(line)) { closeRequirement(); op = null; return; }
    if (/^###\s+/.test(line)) {
      closeRequirement();
      const heading = line.replace(/^###\s+/, '').trim();
      const named = heading.match(/^Requirement:\s*(\S.*)$/i);
      // openspec reports this as INFO only, and the change still validates as long as ONE good
      // requirement parsed — the mistyped one is dropped from the deltas and never reaches the
      // living spec. Measured on 1.10.0: two requirements in the file, `deltaCount: 1`,
      // `valid: true`. A silently lost requirement is ours to catch.
      if (!named) {
        err(r, `heading "### ${heading}" (line ${i + 1}) is not a requirement heading`,
            'use "### Requirement: <text>" verbatim — openspec ignores any other form (INFO only) and drops the requirement from the delta, so it silently never reaches the living spec; only the <text> may be Russian');
        reqName = null;
        return;
      }
      if (op === null) {
        err(r, `requirement "${named[1]}" (line ${i + 1}) sits outside a delta section`,
            'put every requirement under "## ADDED|MODIFIED|REMOVED|RENAMED Requirements"');
      }
      reqName = named[1];
      reqLine = i + 1;
      scenarios = 0;
      reqBody = '';
      reqAll = named[1] + '\n';
      return;
    }
    if (reqName !== null) {
      reqAll += line + '\n';
      if (/^####\s+/.test(line)) scenarios += 1;
      else reqBody += line + '\n';
    }
  });
  closeRequirement();
}

// ---- report
if (unmarkedChangeIds.length)
  warn('openspec/changes/', `${unmarkedChangeIds.length} unmarked change(s) ignored`,
    `these are hand-made OpenSpec changes with no ${LAYOUT.changeMarker} (${unmarkedChangeIds.join(', ')}) — `
    + 'mark one with `serpens-sdd state mark-change <id> --ticket <T>` to bring it under Serpens checks');
if (warns.length) console.log(`warnings (${warns.length}):\n${warns.join('\n')}\n`);
if (errors.length) {
  console.log(`errors (${errors.length}):\n${errors.join('\n')}\n\n✗ serpens-lint failed`);
  process.exit(1);
}
console.log('✓ serpens-lint passed');
