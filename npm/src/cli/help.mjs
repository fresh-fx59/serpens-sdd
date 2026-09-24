import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitPath } from '../integrity.mjs';

// The package's own serpensSddEdition is always known — never a guess — so it is the default
// for ctx.edition when no env var overrides it. Read once at module load.
const PACKAGE_EDITION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).serpensSddEdition;

const WORKFLOW_COMMANDS = [
  'spns-spec',
  'spns-plan',
  'spns-implement',
  'spns-autotest',
  'spns-test-plan',
  'spns-review',
  'spns-archive',
];

// Rule for extracting a workflow command's one-line purpose: the vendored command files
// (kits/<lang>/commands/spns-*.md) carry no markdown heading at all — they open with YAML
// frontmatter, then prose. The only line in the file that is already a usable one-line
// purpose is the frontmatter `description:` field, so that is what we read. This keeps help
// text sourced from the kit (no drift) without inventing a heading the files don't have.
function readWorkflowPurpose(name, lang) {
  const file = join(kitPath(lang), 'commands', `${name}.md`);
  const text = readFileSync(file, 'utf8');
  const m = /^description:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}

const TOOL_PURPOSES = {
  'verify-docs': 'Docs disposer: index --check + lint + split-brain, plus the git-tracking and UNFILLED gates',
  lint: 'Lint the vault/repo against serpens-sdd conventions',
  index: 'Generate a folder index.md catalog',
  'split-brain': 'Check for contract split-brain between spec and code',
  state: 'Report or prepare repository state for a change',
  'git-naming': 'Check git branch/tag naming conventions',
  delivery: 'Print the delivery-convention contract, or the hand-off text for pr-opened-by=human',
  'openspec-root': 'Check the openspec root is correctly located',
  'sync-submodules': 'Sync git submodules to their pinned refs',
  catalog: 'Aggregate per-folder indexes into one catalog',
  'index-code': 'Build a code search index (zoekt)',
  version: 'Print the installed kit edition/version',
  uninstall: 'Reverse a serpens-sdd install; dry-run by default, --apply to execute',
  'opsx-sync': "Re-run `openspec update` for a relocated port (e.g. gigacode) and relocate the refresh; dry-run by default, --apply to execute",
  'check-schema': 'Entry precondition: stop if the OpenSpec schema in effect is not the built-in spec-driven one',
};

/**
 * Build the agent-facing help model: what commands exist, how to invoke them, and where
 * this install lives — so an agent never has to guess this machine's layout.
 * @param {{port: string, scope: string, lang: string, edition: string}} ctx
 * @returns {{commands: Array, workflow: Array, install: object}}
 */
export function buildHelp(ctx) {
  const lang = ctx?.lang ?? 'en';

  const workflow = WORKFLOW_COMMANDS.map((name) => ({
    name,
    usage: `/${name} <args>`,
    purpose: readWorkflowPurpose(name, lang),
  }));

  // Sourced from TOOL_PURPOSES, not TOOL_COMMANDS: 'verify-docs' is a real, listed subcommand
  // (implemented in the CLI layer — src/cli/verify-docs.mjs — rather than wrapped from a
  // vendored script) and TOOL_COMMANDS alone would silently drop it from this list.
  const commands = Object.keys(TOOL_PURPOSES).map((name) => ({
    name,
    usage: `serpens-sdd ${name} [args...]`,
    purpose: TOOL_PURPOSES[name] ?? '',
  }));

  const install = {
    port: ctx?.port,
    scope: ctx?.scope,
    lang,
    edition: ctx?.edition,
  };

  return { commands, workflow, install };
}

function renderText(h) {
  const lines = [];
  lines.push(`serpens-sdd — installed for port ${h.install.port} (${h.install.scope} scope, ${h.install.lang}, edition ${h.install.edition})`);
  lines.push('');
  lines.push('Workflow commands (run inside the agent):');
  for (const c of h.workflow) lines.push(`  ${c.usage.padEnd(24)} ${c.purpose}`);
  lines.push('');
  lines.push('Tool subcommands (run from the shell):');
  for (const c of h.commands) lines.push(`  ${c.usage.padEnd(32)} ${c.purpose}`);
  return lines.join('\n');
}

/**
 * CLI entry point for `serpens-sdd help [command] [--json]`.
 * @param {string[]} argv
 * @returns {number}
 */
export default function main(argv = []) {
  const ctx = {
    port: process.env.SERPENS_SDD_PORT ?? 'unknown',
    // No install config persists yet (nothing writes a resolved scope/port to disk), so these
    // stay honest 'unknown' until a later task exports them. The env var name matches the
    // established key for this concept: src/resolve.mjs's `port_scope` input / SERPENS_SDD_PORT_SCOPE.
    scope: process.env.SERPENS_SDD_PORT_SCOPE ?? 'unknown',
    lang: process.env.SERPENS_SDD_LANG ?? 'en',
    edition: process.env.SERPENS_SDD_EDITION ?? PACKAGE_EDITION,
  };
  const h = buildHelp(ctx);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(h, null, 2));
    return 0;
  }

  const target = argv.find((a) => !a.startsWith('--'));
  if (target) {
    const entry = [...h.workflow, ...h.commands].find((c) => c.name === target);
    if (!entry) {
      console.error(`✗ unknown command "${target}" — run \`serpens-sdd help\``);
      return 2;
    }
    console.log(`${entry.name}\n  usage:   ${entry.usage}\n  purpose: ${entry.purpose}`);
    return 0;
  }

  console.log(renderText(h));
  return 0;
}
