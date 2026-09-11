import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.mjs';
import { resolveTool } from '../src/cli/tools.mjs';
import { runVerifyDocs } from '../src/cli/verify-docs.mjs';
import { renderPortFacts, unfilledCount } from '../src/portfacts.mjs';

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-portfacts-'));
  mkdirSync(join(repoRoot, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(repoRoot, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(repoRoot, 'openspec', 'repo.txt'), 'store\n');
  return repoRoot;
}

async function primeIndex(repoRoot) {
  const { cmd, args } = resolveTool('index');
  const result = await run(cmd, args, { cwd: repoRoot });
  assert.equal(result.code, 0, result.stderr);
}

test('proven facts are filled and unknown ones are marked UNFILLED', () => {
  const text = renderPortFacts({
    openspec: 'npx @fission-ai/openspec@1.10.3',
    port: 'gigacode',
    scope: 'user',
    agentDir: '/home/u/.gigacode',
    edition: '2026-08-26.8',
    storeId: 'acme-store',
    storeRoot: '/w/system-store',
    repositorySource: 'manual',
  });
  assert.match(text, /^STATUS: PARTIAL — 4 UNFILLED sections/m);
  assert.match(text, /npx @fission-ai\/openspec@1\.10\.3/);
  assert.match(text, /acme-store/);
  assert.match(text, /\/w\/system-store/);
  assert.match(text, /2026-08-26\.8/);
  assert.match(text, /\/home\/u\/\.gigacode/);
  assert.equal(unfilledCount(text), 4);
});

test('verify-docs fails while port-facts.md holds an UNFILLED marker', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);

  const text = renderPortFacts({
    openspec: 'npx @fission-ai/openspec@1.10.3',
    port: 'gigacode',
    scope: 'user',
    agentDir: '/home/u/.gigacode',
    edition: '2026-08-26.8',
    storeId: 'acme-store',
    storeRoot: repoRoot,
    repositorySource: 'manual',
  });
  writeFileSync(join(repoRoot, 'port-facts.md'), text, 'utf8');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false);
  const combined = result.evidence.join('\n') + result.output;
  assert.match(combined, /port-facts\.md/);
  assert.match(combined, /4 UNFILLED/);
});

test('verify-docs passes once the markers are replaced', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);

  // Simulate the operator having filled in every previously-UNFILLED section, in the same
  // `| P<n> | ... |` shape serpens-lint.mjs (4c) requires for the facts it can check mechanically.
  const filled = [
    'STATUS: DONE',
    '',
    '# Port facts — gigacode (probed 2026-09-07)',
    '',
    '| # | Question | Probe ran | Evidence (verbatim output) | Conclusion |',
    '|---|---|---|---|---|',
    '| P1 | agent home + git config serpens.agentDir | `git config serpens.agentDir` | scope: user; agentDir: /home/u/.gigacode | set |',
    '| P2 | resolved OpenSpec CLI invocation | `npx @fission-ai/openspec@1.10.3 --version` | npx @fission-ai/openspec@1.10.3 | proven |',
    '| P3 | kit edition | n/a | 2026-08-26.8 | recorded |',
    '| P4 | store id, root, repository_source | `openspec store list` | id=acme-store; root=/w/system-store; repository_source=manual | proven |',
    '',
    '## Tracker',
    'AcmeTrack, via the internal MCP tracker-bridge tool.',
    '',
    '## Forge',
    'internal GitLab instance, project acme/billing.',
    '',
    '## MCP tool names',
    'repo-bindings, tracker-bridge, wiki-search, code-search.',
    '',
    '## Testing tiers',
    'fast: `npm test`; slow: `npm run test:e2e`.',
    '',
  ].join('\n');
  writeFileSync(join(repoRoot, 'port-facts.md'), filled, 'utf8');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output);
});

test('a repo with no port-facts.md at all is unaffected by the gate', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);
  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output);
});

test('a store-shaped repo (project-repositories.json present) with no port-facts.md fails, naming the missing file', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);
  // A legacy data signal that distinguishes the store from a spoke: no spoke ever gets a
  // project-repositories.json. Stage 1 no longer writes this file (see the .openspec-store
  // signal tests below), but an existing one is never deleted either, so it stays a live
  // signal alongside `.openspec-store/store.yaml`.
  writeFileSync(join(repoRoot, 'project-repositories.json'), '{"schema_version":1,"project":"acme","repository_source":"manual","repositories":[]}\n', 'utf8');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false);
  const combined = result.evidence.join('\n') + result.output;
  assert.match(combined, /port-facts\.md/);
  assert.match(combined, /missing/);
});

test('a spoke-shaped repo (no project-repositories.json) with no port-facts.md still passes', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);
  // No project-repositories.json here — this is exactly the shape of every onboarded spoke,
  // which never gets a port-facts.md and must never be gated on its absence.
  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output);
});

test('a store signalled ONLY by .openspec-store/store.yaml (no project-repositories.json) with no '
  + 'port-facts.md still fails — the legacy file is not the only store signal', async () => {
  // spec-drop-inventory-file-2026-09-11.md §6: stage 1 no longer writes project-repositories.json
  // at all, so a store must still be recognized by OpenSpec's own committed store identity
  // (item 3's `.openspec-store/store.yaml`) or the legacy file — either one, not just the legacy
  // one. Missing this would silently turn the port-facts.md gate off for every store on this
  // edition, exactly the failure shape codex's critique caught in the original design.
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);
  mkdirSync(join(repoRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(repoRoot, '.openspec-store', 'store.yaml'), 'id: acme-store\n', 'utf8');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, false);
  const combined = result.evidence.join('\n') + result.output;
  assert.match(combined, /port-facts\.md/);
  assert.match(combined, /missing/);
});

test('a store signalled by .openspec-store/store.yaml PASSES once port-facts.md has no UNFILLED sections', async () => {
  const repoRoot = makeRepo();
  await primeIndex(repoRoot);
  mkdirSync(join(repoRoot, '.openspec-store'), { recursive: true });
  writeFileSync(join(repoRoot, '.openspec-store', 'store.yaml'), 'id: acme-store\n', 'utf8');
  const filled = [
    'STATUS: DONE',
    '',
    '# Port facts — gigacode (probed 2026-09-07)',
    '',
    '| # | Question | Probe ran | Evidence (verbatim output) | Conclusion |',
    '|---|---|---|---|---|',
    '| P1 | agent home + git config serpens.agentDir | `git config serpens.agentDir` | scope: user; agentDir: /home/u/.gigacode | set |',
    '| P2 | resolved OpenSpec CLI invocation | `npx @fission-ai/openspec@1.10.3 --version` | npx @fission-ai/openspec@1.10.3 | proven |',
    '| P3 | kit edition | n/a | 2026-08-26.8 | recorded |',
    '| P4 | store id, root, repository_source | `openspec store list` | id=acme-store; root=/w/system-store; repository_source=manual | proven |',
    '',
    '## Tracker',
    'AcmeTrack, via the internal MCP tracker-bridge tool.',
    '',
    '## Forge',
    'internal GitLab instance, project acme/billing.',
    '',
    '## MCP tool names',
    'repo-bindings, tracker-bridge, wiki-search, code-search.',
    '',
    '## Testing tiers',
    'fast: `npm test`; slow: `npm run test:e2e`.',
    '',
  ].join('\n');
  writeFileSync(join(repoRoot, 'port-facts.md'), filled, 'utf8');

  const result = await runVerifyDocs({ repoRoot });
  assert.equal(result.ok, true, result.output);
});
