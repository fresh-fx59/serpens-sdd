// The four facts docs/SETUP.md §2/§5/§6a name that no script can prove on its own — each one
// needs a human (the operator, or whoever wired MCP, or the team) to supply the real value.
// Naming them here, once, is what keeps `renderPortFacts` and the `UNFILLED` gate in
// `verify-docs` agreeing on exactly what "unfilled" means.
const UNFILLED_SECTIONS = [
  {
    title: 'Tracker',
    body: 'UNFILLED — the tracker name and how it is reached (MCP tool or manual export), from the operator',
  },
  {
    title: 'Forge',
    body: 'UNFILLED — the forge name and this project\'s binding on it, from the operator',
  },
  {
    title: 'MCP tool names',
    body: 'UNFILLED — the MCP tool names for repository bindings, tracker, wiki, and code search, from whoever configured MCP',
  },
  {
    title: 'Testing tiers',
    body: 'UNFILLED — the fast and slow testing tiers and the command that runs each, from the team (spns-tdd and spns-debugging read this)',
  },
];

/**
 * "1 UNFILLED section" vs "N UNFILLED sections" — the STATUS line must read right at
 * both counts, not just at the four this module always produces for port-facts.md.
 * @param {number} n
 * @returns {string}
 */
function sectionsWord(n) {
  return n === 1 ? 'section' : 'sections';
}

/**
 * Count `UNFILLED` marker lines in a rendered `port-facts.md` body. `testing-stack.md` no
 * longer goes through this: it is schema-validated in src/testingstack.mjs, because counting a
 * string reported the untouched template as complete.
 * Matches only lines that literally start with `UNFILLED — `, never the summary `STATUS:` line
 * that reports the count in prose — that line names the count, it is not itself a marker.
 * @param {string} text
 * @returns {number}
 */
export function unfilledCount(text) {
  const matches = text.match(/^UNFILLED — /gm);
  return matches ? matches.length : 0;
}

/**
 * Render `port-facts.md` from what the install actually proved, per docs/SETUP.md §2 and the
 * `installCommands` proof. Every section it cannot prove — the tracker name, the forge name,
 * the MCP tool names, and the testing tiers — becomes a literal `UNFILLED — <what, from whom>`
 * line rather than being silently omitted or guessed; a half-filled page that reads as complete
 * is worse than an install with no evidence file at all. The first line reports how many
 * `UNFILLED` sections remain, so incompleteness cannot be missed at a glance.
 * @param {{openspec: string, port: string, scope: string, agentDir: string, edition: string,
 *   storeId: string, storeRoot: string, repositorySource: string, probedDate?: string}} facts
 * @returns {string}
 */
export function renderPortFacts(facts) {
  const {
    openspec, port, scope, agentDir, edition, storeId, storeRoot, repositorySource, topology, repoName,
    probedDate = new Date().toISOString().slice(0, 10),
  } = facts;

  const lines = [];
  lines.push(`STATUS: PARTIAL — ${UNFILLED_SECTIONS.length} UNFILLED ${sectionsWord(UNFILLED_SECTIONS.length)}`);
  lines.push('');
  lines.push(`# Port facts — ${port} (probed ${probedDate})`);
  lines.push('');
  // serpens-lint.mjs 4c requires at least one real `| P<n> | ... |` row, none of which still hold
  // the literal template placeholder "...", and a header without the template's own
  // placeholders — so every fact this stage actually proved is recorded as a genuine P-row,
  // never left to the freeform prose sections below.
  lines.push('| # | Question | Probe ran | Evidence (verbatim output) | Conclusion |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| P1 | agent home + git config serpens.agentDir | \`git config serpens.agentDir\` | scope: ${scope}; agentDir: ${agentDir} | set |`);
  lines.push(`| P2 | resolved OpenSpec CLI invocation | \`${openspec} --version\` | ${openspec} | proven |`);
  lines.push(`| P3 | kit edition | n/a | ${edition} | recorded |`);
  if (topology === 'repo-local') {
    // Step 6 (gap 3): no store exists, so P4 records the topology instead of a store id.
    lines.push(`| P4 | topology, repository, repository_source | \`cat serpens/topology\` | topology=repo-local (no system store); repo=${repoName}; root=${storeRoot}; repository_source=${repositorySource} | proven |`);
  } else {
    lines.push(`| P4 | store id, root, repository_source | \`openspec store list\` | id=${storeId}; root=${storeRoot}; repository_source=${repositorySource} | proven |`);
  }
  lines.push('');
  for (const section of UNFILLED_SECTIONS) {
    lines.push(`## ${section.title}`);
    lines.push(section.body);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
