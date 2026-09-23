import {
  existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool, toolPath } from '../cli/tools.mjs';
import { writeShim, resolveCallRoute, renderLefthook, findLefthookConfigs, LEFTHOOK_MARKER } from '../shim.mjs';
import { resolveScope, assertLintScope } from '../scope.mjs';
import { readGitmodules } from '../inventory.mjs';
import { splitInvocation } from '../invocation.mjs';
import { runVerifyDocs } from '../cli/verify-docs.mjs';
import { SHIM_INVOCATION } from '../shim.mjs';
import {
  declareArtifactRules, declareContextCatalog, declareStoreReference, resolveConfigPath,
  inspectConfig,
} from '../openspecconfig.mjs';
import { artifactRules, contextCatalog } from '../factfiles.mjs';
import { LAYOUT, SERPENS_DIR } from '../layout.mjs';
import { recordInstalledFile } from '../installrecord.mjs';
import { openspecToolId } from '../ports.mjs';
import { snapshotOpenspecToolDir, relocateAfterOpenspecRun } from '../openspec-tool-relocate.mjs';

const BIN_PATH = fileURLToPath(new URL('../../bin/serpens-sdd.mjs', import.meta.url));

// docs/SETUP.md §5 item 4: the templates the installed commands cite by path for a SPOKE
// repository — a subset of the six templates the store gets (no store-contract.md there).
const SPOKE_TEMPLATES = ['adr.md', 'research.md', 'testing-stack.md'];

export const HARD_RULE_MARKER = '## HARD RULE — disposer self-check';
// Bump this whenever HARD_RULE_BLOCKS' body text changes. appendHardRuleOnce reads the marker
// comment carrying this version out of an existing block: a mismatch means the block is stale
// prose from an older release and gets replaced in place; a match means it is already current
// and is left untouched (never duplicated, never rewritten for no reason).
const HARD_RULE_VERSION = '2026-09-23.1';
const HARD_RULE_VERSION_MARKER = `<!-- serpens-sdd:hard-rule-version ${HARD_RULE_VERSION} -->`;

// gap 4, serpens-openspec-coexistence-gaps-2026-09-22.md: scoped to SERPENS OWNED work only —
// serpens/ itself, or an openspec/changes/<id>/ that carries a .serpens.yaml marker (step 2). A
// hand-made, unmarked OpenSpec change is explicitly carved out, so a team's own vanilla work
// never trips this rule.
export const HARD_RULE_BLOCKS = {
  en: `${HARD_RULE_MARKER}
${HARD_RULE_VERSION_MARKER}
After creating or editing a file under ${SERPENS_DIR}/, or under an openspec/changes/<id>/ that
has a .serpens.yaml, run:
    ${SHIM_INVOCATION} verify-docs
Fix every ✗ (each error carries a remediation hint) and re-run until green
BEFORE reporting work done or proposing a commit. Rejected writes are corrected
by regenerating the content — never by loosening caps or deleting checks.
Hand-made OpenSpec changes (no .serpens.yaml) are not Serpens work: do not run this for them.
CIRCUIT BREAKER: if the same error survives 3 fix attempts, STOP and ask a human —
do not keep looping.
`,
  ru: `${HARD_RULE_MARKER}
${HARD_RULE_VERSION_MARKER}
После создания или редактирования файла в ${SERPENS_DIR}/, или в openspec/changes/<id>/, у
которого есть .serpens.yaml, запустите:
    ${SHIM_INVOCATION} verify-docs
Исправляйте каждый ✗ (у каждой ошибки есть подсказка по исправлению) и запускайте снова, пока
не станет зелено, — ПЕРЕД тем, как отчитаться о готовности работы или предложить коммит.
Отклонённые записи исправляются регенерацией содержимого — никогда ослаблением лимитов или
удалением проверок.
Обычные изменения OpenSpec без .serpens.yaml — не работа Serpens: не запускайте это для них.
CIRCUIT BREAKER: если одна и та же ошибка не устраняется за 3 попытки исправления,
ОСТАНОВИТЕСЬ и спросите человека — не зацикливайтесь.
`,
};

/**
 * The half-open [start, end) range of the existing HARD RULE block inside `text`, from its
 * marker heading up to (not including) the next top-level (`## `) heading, or EOF if there is
 * none. Returns null when the marker is absent.
 * @param {string} text
 * @returns {{start: number, end: number} | null}
 */
function findHardRuleRange(text) {
  const start = text.indexOf(HARD_RULE_MARKER);
  if (start === -1) return null;
  const nextHeadingAt = text.indexOf('\n## ', start + HARD_RULE_MARKER.length);
  const end = nextHeadingAt === -1 ? text.length : nextHeadingAt + 1;
  return { start, end };
}

/**
 * Append (or, if a stale version is present, replace in place) the disposer HARD RULE in a
 * port's instruction file. Creates the file if it does not yet exist (a freshly-added submodule
 * has no port scaffold of its own before this). A block already at the current
 * `HARD_RULE_VERSION` is left byte-identical — this is what keeps a second run a no-op.
 * @param {string} path
 * @param {'en'|'ru'} [lang]
 */
export function appendHardRuleOnce(path, lang = 'en') {
  const block = HARD_RULE_BLOCKS[lang] ?? HARD_RULE_BLOCKS.en;
  if (!existsSync(path)) {
    writeFileSync(path, block, 'utf8');
    return true;
  }
  const existing = readFileSync(path, 'utf8');
  const range = findHardRuleRange(existing);
  if (!range) {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(path, `${existing}${sep}${block}`, 'utf8');
    return true;
  }
  const current = existing.slice(range.start, range.end);
  if (current === block) return false;
  const replaced = existing.slice(0, range.start) + block + existing.slice(range.end);
  writeFileSync(path, replaced, 'utf8');
  return true;
}

// WHY WE DO NOT ALWAYS RUN `openspec init`.
//
// `openspec init` runs `handleLegacyCleanup` before anything else (OpenSpec 1.13.1,
// `dist/core/init.js:113`). When it finds legacy artifacts — legacy marker blocks inside a
// team's `CLAUDE.md`/`AGENTS.md`, `.claude/commands/openspec/`-style directories, GLOBAL legacy
// prompt files in the USER'S HOME, `openspec/AGENTS.md`, `openspec/project.md`
// (`dist/core/legacy-cleanup.js:185-193`) — it normally asks a human
// "Upgrade and clean up legacy files?" (`init.js:337-341`).
//
// It cannot ask inside our run. `canPromptInteractively()` returns false whenever `--tools` is
// passed (`init.js:223-229`), and we spawn `openspec` as a child process with captured output,
// so `process.stdin.isTTY` is false regardless (`dist/utils/interactive.js:12-21`). It therefore
// takes the AUTO-CLEAN branch silently (`init.js:330-336`): it rewrites the team's instruction
// files and deletes files, some of them under the user's HOME
// (`legacy-cleanup.js:565-583`). There is no opt-out — `init`'s only related flag is `--force`,
// "Auto-cleanup legacy files without prompting" (`dist/cli/index.js:169`).
//
// That is a question we must not answer on a team's behalf. So: `openspec/` absent means the
// repository has never been initialized and the cleanup cannot have anything to find — run init.
// `openspec/` present means the repository already uses OpenSpec — skip init entirely, assert
// the few things the rest of stage 5 depends on, and if one is missing hand the exact command
// to the human instead of running it for them.
//
// `openspec/` is deliberately the same signal OpenSpec itself uses to tell "extend" from
// "greenfield" (`init.js:216`, `extendMode = await FileSystemUtils.directoryExists(openspecPath)`).
// We do NOT re-implement its legacy DETECTION: that module is large and changes between minors,
// and a copy of it here would rot silently.

/** The directory whose presence means "this repository already uses OpenSpec". */
const OPENSPEC_DIR = 'openspec';

/**
 * What stage 5 needs from an OpenSpec root that already exists, checked without running
 * `openspec init`. The directory list is OpenSpec's own (`dist/core/init.js:613-624`); the
 * config rule matches what init does with a config already on disk — it returns `'exists'` and
 * never touches it (`:810-817`), so a present, parseable config is all we require.
 * @param {string} repoRoot
 * @returns {{ok: boolean, missing: string[]}}
 */
export function inspectExistingOpenspec(repoRoot) {
  const missing = [];
  for (const dir of [['specs'], ['changes'], ['changes', 'archive']]) {
    if (!existsSync(join(repoRoot, OPENSPEC_DIR, ...dir))) {
      missing.push(`${OPENSPEC_DIR}/${dir.join('/')}/ (directory does not exist)`);
    }
  }
  const resolved = resolveConfigPath(repoRoot, existsSync);
  if (!resolved.existed) {
    missing.push(`${OPENSPEC_DIR}/config.yaml or ${OPENSPEC_DIR}/config.yml (neither exists)`);
  } else {
    let text;
    try {
      text = readFileSync(resolved.path, 'utf8');
    } catch (err) {
      text = null;
      missing.push(`${relative(repoRoot, resolved.path)} (cannot be read: ${err.message})`);
    }
    if (text !== null) {
      const parsed = inspectConfig(text);
      if (!parsed.ok) missing.push(`${relative(repoRoot, resolved.path)} (does not parse as YAML: ${parsed.reason})`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The message a human gets when a pre-existing `openspec/` is incomplete. It names every missing
 * thing and hands over the one command to run BY HAND — with the prompt warning, because that
 * prompt is the whole reason we are not running it ourselves.
 * @param {string} name
 * @param {string[]} missing
 * @param {string} openspecInvocation - e.g. `npx @fission-ai/openspec@1.13.1`
 * @param {string|undefined} portId
 * @param {string} repoRoot
 * @returns {string}
 */
export function incompleteOpenspecMessage(name, missing, openspecInvocation, portId, repoRoot) {
  const cmd = `${openspecInvocation} init${portId ? ` --tools ${portId}` : ''}`;
  return [
    `${name}: ${OPENSPEC_DIR}/ already exists, so Serpens did NOT run \`openspec init\` — but that`,
    'OpenSpec root is incomplete. Missing:',
    ...missing.map((m) => `  - ${m}`),
    '',
    'Run this yourself, in that repository:',
    `    cd ${repoRoot}`,
    `    ${cmd}`,
    '',
    'It may ask "Upgrade and clean up legacy files?". Answer it yourself — it can rewrite your',
    "CLAUDE.md/AGENTS.md and delete files, including some in your home directory, and Serpens",
    'will not answer that question for you. Then re-run Serpens.',
  ].join('\n');
}

/**
 * Decide which of the three lefthook.yml ownership branches (gap 8) a repository falls into,
 * WITHOUT writing anything — the same decision drives both the dry-run plan and the real pass,
 * so they can never disagree.
 *   - 'write': no lefthook config present at all -> write `lefthook.yml`, marked, `lefthook install`.
 *   - 'regenerate': the ONLY config present is our own marked `lefthook.yml` -> rewrite it in place.
 *   - 'manual': any other main config is present (unmarked `lefthook.yml`, or any of the other
 *     14 names, or more than one config) -> write ours to `serpens/lefthook.yml` and leave an
 *     `extends:` line for the team to add by hand; never run `lefthook install` ourselves.
 * @param {string} submodulePath
 * @returns {{mode: 'write'|'regenerate'|'manual', path: string, theirs?: string}}
 */
function planLefthook(submodulePath) {
  const configs = findLefthookConfigs(submodulePath);
  const mainPath = join(submodulePath, 'lefthook.yml');
  if (configs.length === 0) {
    return { mode: 'write', path: mainPath };
  }
  if (configs.length === 1 && configs[0] === 'lefthook.yml') {
    const existing = readFileSync(mainPath, 'utf8');
    if (existing.startsWith(LEFTHOOK_MARKER)) {
      return { mode: 'regenerate', path: mainPath };
    }
  }
  return { mode: 'manual', path: join(submodulePath, LAYOUT.lefthookFallback), theirs: configs[0] };
}

/**
 * Everything `onboardOne` would do for one submodule, printed by `--dry-run`. Built from the
 * same constants and the same path expressions the real pass uses (SPOKE_TEMPLATES, the
 * kit tool paths, the shim path, the instruction file from the port), so the printed plan names
 * the files that would really be written. The order matches the numbered steps below it.
 * @param {object} ctx - the ctx `onboardOne` receives
 * @param {string} submodulePath
 * @returns {string[]}
 */
export function onboardPlan(ctx, submodulePath) {
  const { config, port, kitDir } = ctx;
  const lang = config?.lang ?? 'en';
  const { cmd: openspecCmd, args: openspecBaseArgs } = splitInvocation(config?.openspec?.invocation);
  const openspec = [openspecCmd, ...openspecBaseArgs].join(' ');
  // The ten wrapped executables ship from the package's own tools/ (src/cli/tools.mjs),
  // never from the vendored kit tree — kitDir only supplies language-specific prose/templates.
  // `lang` is accepted by toolPath and ignored (the scripts are language-neutral); passed
  // through anyway so this reads the same as every other resolveTool/toolPath call site.
  const tool = (name) => {
    const subcommand = name === 'check-openspec-root.sh' ? 'openspec-root'
      : name === 'repository-state.sh' ? 'state' : null;
    if (!subcommand) throw new Error(`onboardPlan: no TOOL_COMMANDS subcommand for ${name}`);
    return toolPath(subcommand, lang);
  };
  const { cmd: indexCmd, args: indexArgs } = resolveTool('index', [], lang);
  const route = resolveCallRoute({ repoRoot: submodulePath, hasNodeModules: false, shimAvailable: true });
  const lines = [`dry-run: would onboard ${submodulePath} (nothing below is executed):`];
  // Which of the two branches step 1 would take, decided by the SAME signal the real pass uses
  // (does `openspec/` exist?), so a dry run over a mixed set of repositories says, per
  // repository, whether `openspec init` would run at all. Nothing here is executed or written.
  if (existsSync(join(submodulePath, OPENSPEC_DIR))) {
    const found = inspectExistingOpenspec(submodulePath);
    lines.push(`  # ${OPENSPEC_DIR}/ already exists → would SKIP \`openspec init\` (its legacy-cleanup prompt is the team's to answer)`);
    if (found.ok) {
      lines.push(`  $ assert ${OPENSPEC_DIR}/specs/, ${OPENSPEC_DIR}/changes/, ${OPENSPEC_DIR}/changes/archive/ and the config → all present`);
    } else {
      lines.push(`  ✗ would STOP: incomplete OpenSpec root — ${found.missing.join('; ')}`);
      lines.push(`    run by hand in ${submodulePath}: ${openspec} init${openspecToolId(port) ? ` --tools ${openspecToolId(port)}` : ''}`);
    }
  } else {
    lines.push(`  # no ${OPENSPEC_DIR}/ yet → greenfield`);
    lines.push(`  $ ${openspec} init${openspecToolId(port) ? ` --tools ${openspecToolId(port)}` : ''}   # cwd=${submodulePath}`);
  }
  lines.push(`  $ bash ${tool('check-openspec-root.sh')}   # must report ${submodulePath}, not the store`);
  const repoLocal = ctx.topology === 'repo-local';
  if (repoLocal) {
    lines.push(`  $ git rev-parse --verify --quiet refs/heads/${config.repo.base_branch}   # or refs/remotes/origin/${config.repo.base_branch}; read-only, no checkout, no fetch`);
    lines.push(`  $ git config serpens.baseBranch ${config.repo.base_branch}`);
  } else {
    lines.push(`  $ bash ${tool('repository-state.sh')} prepare-base --repo ${submodulePath} --base <.gitmodules branch>`);
  }
  lines.push(`  scope: ${(port?.scope_preference ?? []).join(' -> ')}; on user scope also `
    + '$ git config serpens.agentDir <rel> plus the planted-probe lint proof');
  lines.push(`  $ write ${join(submodulePath, LAYOUT.repoTxt)}`);
  if (repoLocal) lines.push(`  $ write ${join(submodulePath, LAYOUT.topology)}   # repo-local`);
  lines.push(`  $ mkdir -p ${join(submodulePath, LAYOUT.adrDir)} and write its .gitkeep`);
  lines.push(`  $ ${indexCmd} ${indexArgs.join(' ')}`);
  lines.push('  $ serpens-sdd verify-docs (index --check, lint, split-brain, then the UNFILLED gate)');
  const lefthookPlan = planLefthook(submodulePath);
  if (lefthookPlan.mode === 'write') {
    lines.push(`  $ write ${lefthookPlan.path}   # marked, run: ${route.invocation} …`);
    lines.push('  $ lefthook install');
  } else if (lefthookPlan.mode === 'regenerate') {
    lines.push(`  $ regenerate ${lefthookPlan.path}   # our marked file, run: ${route.invocation} …`);
    lines.push('  $ lefthook install');
  } else {
    lines.push(`  # ${lefthookPlan.theirs} already present in ${submodulePath} — not our file`);
    lines.push(`  $ write ${lefthookPlan.path}   # ours; run: ${route.invocation} …`);
    lines.push(`    manual: add to ${join(submodulePath, lefthookPlan.theirs)}:  extends:\n    - serpens/lefthook.yml`);
    lines.push('  # lefthook install NOT run — the team owns their hooks');
  }
  lines.push(`  $ cp ${join(kitDir, 'system-store-template', 'gitignore.template')} ${join(submodulePath, '.gitignore')}   # only when absent`);
  if (repoLocal) {
    lines.push(`  # ${join(submodulePath, 'openspec', 'config.yaml')}: references: skipped — repo-local has no store; context catalog + rules as normal`);
  } else {
    lines.push(`  $ write ${join(submodulePath, 'openspec', 'config.yaml')}   # references: id ${config?.store?.id} + remote ${config?.store?.remote}`);
  }
  lines.push(`  $ append the disposer HARD RULE to ${join(submodulePath, port?.instruction_file ?? '(no instruction_file)')}   # exactly once`);
  for (const file of SPOKE_TEMPLATES) {
    lines.push(`  $ cp ${join(kitDir, 'templates', file)} ${join(submodulePath, LAYOUT.templates, file)}`);
  }
  lines.push(`  $ write ${join(submodulePath, LAYOUT.shim)}   # the shim; no script copies, ever`);
  return lines;
}

/**
 * Onboard exactly one already-materialized submodule (docs/SETUP.md §5), fully re-runnable.
 * A repository whose gate fails returns `ok: false` with `error` naming the failing command
 * and its output — the caller (stage5) is responsible for finishing every other repository
 * first and never leaving one half-onboarded.
 * @param {{config: object, port: object, run: Function, log?: object, dryRun?: boolean,
 *   storeRoot: string, kitDir: string, home?: string}} ctx
 * @param {string} submodulePath
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function onboardOne(ctx, submodulePath) {
  const { config, port, run, log, kitDir, storeRoot, dryRun = false } = ctx;
  // The resolved kit language, threaded into every wrapper call below (`kitDir` already is
  // this language's tree) so a `--lang ru` install never runs the English kit's executables.
  const lang = config?.lang ?? 'en';
  const evidence = [];

  if (dryRun) {
    for (const line of onboardPlan(ctx, submodulePath)) evidence.push(line);
    return { ok: true, evidence };
  }

  // Repo-local topology (step 6, gap 3): the ONE repository is onboarded directly — its name
  // and base branch come from `config.repo`, never from a store's .gitmodules (there is none).
  const repoLocal = ctx.topology === 'repo-local';
  const name = repoLocal ? config.repo.name : basename(submodulePath);
  const runOpts = { log };

  async function step(cmd, args, opts = {}) {
    const result = await run(cmd, args, { ...runOpts, ...opts, cwd: opts.cwd ?? submodulePath });
    evidence.push(`$ ${cmd} ${args.join(' ')} → exit ${result.code}`);
    return result;
  }
  function recordWrite(description, fn) {
    fn();
    evidence.push(`$ ${description} → done`);
  }
  function fail(error, exitCode = 1) {
    return { ok: false, evidence, error, exitCode };
  }

  // Resolve this submodule's base branch from the store's own .gitmodules — onboardOne takes
  // only (ctx, submodulePath), so it looks its row up rather than requiring a third argument.
  // Repo-local: `config.repo.base_branch`, validated by validateConfig.
  let base;
  if (repoLocal) {
    base = config.repo.base_branch;
  } else {
    let rows;
    try {
      rows = await readGitmodules(storeRoot, { run });
    } catch (err) {
      return fail(`could not read .gitmodules to resolve ${name}'s base branch: ${err.message}`, err.exitCode ?? 2);
    }
    const row = rows.find((r) => r.name === name);
    base = row?.base_branch;
    if (!base) {
      return fail(`${name}: no base_branch recorded in .gitmodules`, 2);
    }
  }

  const { cmd: openspecCmd, args: openspecBaseArgs } = splitInvocation(config?.openspec?.invocation);

  // 1. Give this submodule an OpenSpec root of its own, BEFORE `state prepare-base`.
  //
  // GREENFIELD (no openspec/ here): run `openspec init`. It has to happen before prepare-base
  // because an un-onboarded submodule has no openspec/ of its own, so OpenSpec's upward walk
  // resolves to the STORE's root instead — repository-state.sh's own assert modes refuse to run
  // against a repo that isn't its own OpenSpec root (verified: it fails here with exactly that
  // message and points at this fix).
  //
  // BROWNFIELD (openspec/ already present): skip init entirely and only ASSERT what stage 5
  // needs. See the block comment above `inspectExistingOpenspec` for why running init here would
  // silently auto-answer OpenSpec's legacy-cleanup prompt on the team's behalf. The ordering
  // reason above does not apply on this branch: openspec/ already exists in the repository, so
  // the upward walk stops here. Step 2 below still PROVES that, on both branches.
  if (existsSync(join(submodulePath, OPENSPEC_DIR))) {
    const found = inspectExistingOpenspec(submodulePath);
    if (!found.ok) {
      return fail(incompleteOpenspecMessage(
        name,
        found.missing,
        [openspecCmd, ...openspecBaseArgs].join(' '),
        openspecToolId(port),
        submodulePath,
      ));
    }
    evidence.push(`${OPENSPEC_DIR}/ already exists in ${name} — skipped \`openspec init\` (its legacy-cleanup prompt is the team's to answer); specs/, changes/, changes/archive/ and the config all present`);
  } else {
    const initArgs = ['init'];
    if (openspecToolId(port)) initArgs.push('--tools', openspecToolId(port));
    // gigacode etc. (spec-openspec-coexistence-2026-09-22.md): OpenSpec only knows the tool id
    // we just passed it (e.g. `qwen`), not the port's own — so before running init we snapshot
    // that OpenSpec tool's directory (whatever was there BEFORE, e.g. a real pre-existing
    // `.qwen/` the operator also uses directly), and after init relocate only what init just
    // added into the port's real `agent_dir`, rewriting in-file path references as it goes.
    const relocationSnapshot = snapshotOpenspecToolDir(submodulePath, port);
    const inited = await step(openspecCmd, [...openspecBaseArgs, ...initArgs]);
    if (inited.code !== 0) {
      return fail(`openspec init failed in ${name}:\n${inited.stderr || inited.stdout}`);
    }
    const relocation = relocateAfterOpenspecRun(submodulePath, port, relocationSnapshot);
    if (relocation.moved.length > 0) {
      evidence.push(`relocated ${relocation.moved.length} OpenSpec-generated file(s) for ${port.openspec_tool} into ${port.agent_dir}/ (GigaCode reads its own agent_dir, not OpenSpec's ${port.openspec_tool} dir)`);
    }
    if (relocation.skippedPreexisting.length > 0) {
      evidence.push(`left ${relocation.skippedPreexisting.length} pre-existing file(s) untouched under the ${port.openspec_tool} dir (present before this run — not ours to move)`);
    }
  }

  // 2. Prove the reported OpenSpec root is this submodule, not the store.
  const rootCheck = await step('bash', [toolPath('openspec-root', lang)]);
  if (rootCheck.code !== 0) {
    return fail(`check-openspec-root failed in ${name}:\n${rootCheck.stderr || rootCheck.stdout}`);
  }
  let resolvedSubmodule;
  try {
    resolvedSubmodule = realpathSync(submodulePath);
  } catch {
    resolvedSubmodule = submodulePath;
  }
  if (!(rootCheck.stdout || '').includes(resolvedSubmodule)) {
    return fail(`check-openspec-root did not prove ${resolvedSubmodule} as the reported root:\n${rootCheck.stdout}`);
  }

  // 3. Now that the submodule owns its own OpenSpec root, prepare-base can actually resolve.
  //
  // Repo-local: NOT prepare-base. It fetches origin, checks the base branch out and fast-forwards
  // it — right for a submodule this kit cloned, wrong in the team's own working checkout (it
  // would move them off their branch, and a trial repository need not have an origin at all).
  // Instead: prove the base branch exists (local or origin ref, read-only) and record it as
  // `git config serpens.baseBranch`, which repository-state.sh's base resolution already prefers.
  if (repoLocal) {
    const localRef = await step('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
    if (localRef.code !== 0) {
      const originRef = await step('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
      if (originRef.code !== 0) {
        return fail(`${name}: base branch '${base}' (repo.base_branch) exists neither locally nor as origin/${base}`, 2);
      }
    }
    const baseConfig = await step('git', ['config', 'serpens.baseBranch', base]);
    if (baseConfig.code !== 0) {
      return fail(`could not set serpens.baseBranch for ${name}:\n${baseConfig.stderr}`);
    }
  } else {
    const prepared = await step('bash', [toolPath('state', lang), 'prepare-base', '--repo', submodulePath, '--base', base]);
    if (prepared.code !== 0) {
      return fail(`state prepare-base failed for ${name}:\n${prepared.stderr || prepared.stdout}`);
    }
  }

  // 4. Resolve and prove the port scope. Project scope is auto-discoverable by serpens-lint;
  // user scope lives outside this repo entirely, so it MUST be recorded in git config for
  // serpens-lint to ever find it — and that recording is proved here, not merely written.
  const home = ctx.home ?? homedir();
  const force = config?.port_scope && config.port_scope !== 'auto' ? config.port_scope : undefined;
  let scopeResult;
  try {
    scopeResult = resolveScope(port, { home, repoRoot: submodulePath, force });
  } catch (err) {
    return fail(`could not resolve port scope for ${name}: ${err.message}`, err.exitCode ?? 3);
  }
  evidence.push(`scope resolved: ${scopeResult.reason}`);
  if (scopeResult.scope === 'user') {
    const agentDirRel = relative(submodulePath, scopeResult.agentRoot);
    const configured = await step('git', ['config', 'serpens.agentDir', agentDirRel]);
    if (configured.code !== 0) {
      return fail(`could not set serpens.agentDir for ${name}:\n${configured.stderr}`);
    }
    const proof = await assertLintScope({
      repoRoot: submodulePath, agentRoot: scopeResult.agentRoot, run, lang,
    });
    evidence.push(`$ assertLintScope(${name}) → ${proof.ok ? 'ok' : 'failed'}`);
    if (!proof.ok) {
      return fail(`serpens.agentDir was set but assertLintScope could not prove it for ${name}: ${proof.error}`);
    }
  }

  // 5. A stable repository id, read by gen-index.mjs instead of the checkout folder name.
  // `openspec/` exists by now either way (init made it, or it was already there) — but nothing
  // has made OUR directory at this point on EITHER branch, which is why the mkdirSync is here
  // and not left to `openspec init`.
  recordWrite(`write ${join(submodulePath, LAYOUT.repoTxt)}`, () => {
    mkdirSync(join(submodulePath, SERPENS_DIR), { recursive: true });
    writeFileSync(join(submodulePath, LAYOUT.repoTxt), `${name}\n`, 'utf8');
  });
  // 5b. Repo-local only: the one-line topology file the store-only tools read at hook time
  // (there is no config file then) so `catalog`/`sync-submodules` refuse instead of guessing.
  if (repoLocal) {
    recordWrite(`write ${join(submodulePath, LAYOUT.topology)}`, () => {
      writeFileSync(join(submodulePath, LAYOUT.topology), 'repo-local\n', 'utf8');
    });
  }

  // 6. serpens/adr/ must exist even empty — spns-archive writes serpens/adr/NNNN-<slug>.md
  // and will not create the directory itself, and a bare directory never survives a clone.
  const adrDir = join(submodulePath, LAYOUT.adrDir);
  recordWrite(`mkdir -p ${adrDir}`, () => mkdirSync(adrDir, { recursive: true }));
  recordWrite(`write ${join(adrDir, '.gitkeep')}`, () => writeFileSync(join(adrDir, '.gitkeep'), '', 'utf8'));

  // 7. Generate the index, then run the disposer through the CLI-layer `verify-docs`
  // subcommand (src/cli/verify-docs.mjs) — NOT the vendored verify-docs.sh, which resolves its
  // repo root from its own script location on disk and so always points at the installed
  // package, never at this submodule, once it is no longer copied into a repo's own tools/
  // (reproduced: it fails looking for tools/gen-index.mjs beside the package's own kits/
  // directory). The subcommand reimplements its exact composition — index --check, lint,
  // split-brain — driven by an explicit repoRoot instead.
  const { cmd: indexCmd, args: indexArgs } = resolveTool('index', [], lang);
  const generated = await step(indexCmd, indexArgs);
  if (generated.code !== 0) {
    return fail(`gen-index failed in ${name}:\n${generated.stderr || generated.stdout}`);
  }

  // verify-docs' own index check now also requires the index to be TRACKED, not merely
  // present on disk (fix round 3 — it used to report green on a repository whose
  // committed/staged state had no index at all). That check does not apply HERE: onboardOne
  // never commits the submodule (the operator/agent does, later, in one commit covering every
  // file this whole onboarding pass wrote — repo.txt, the index, lefthook.yml, .gitignore,
  // config.yaml, the instruction-file HARD RULE), and stage5 must stay re-runnable against that
  // same not-yet-committed state (repository-state.sh's own prepare-base gate refuses a dirty
  // tree, so pre-staging here would make a SECOND run of stage5 fail against the first run's
  // own staged-but-uncommitted leftovers). `checkGitTracking: false` skips exactly the new git
  // check while still running index --check, lint and split-brain — the real content gates this
  // step exists for. The git-tracking gate still applies in full to every OTHER caller: the
  // agent's own `serpens-sdd verify-docs`, the pre-commit hook, and CI.
  // `onboarding: true` also relaxes exactly one more check for the same ordering reason: the
  // testing-stack gate now treats an absent `serpens/testing-stack.md` as an error on a spoke, and
  // stage 6 — not this stage — is what writes it. Without the flag, every first install would
  // fail here on a file the installer has not reached yet. A file already on disk is still
  // validated in full.
  const verifyDocs = await runVerifyDocs({
    repoRoot: submodulePath, run, log, lang, checkGitTracking: false, onboarding: true,
  });
  evidence.push(...verifyDocs.evidence);
  if (!verifyDocs.ok) {
    return fail(`verify-docs failed for ${name}:\n${verifyDocs.output}`);
  }

  // 8. lefthook.yml, rendered for the resolved call route, then installed — but ONLY when we
  // own the file we are about to write (gap 8). The shim is always written in this same pass
  // (step 13 below), so the route is always 'shim' — hasNodeModules and repoRoot are irrelevant
  // to the outcome here, only kept as resolveCallRoute's contract.
  const route = resolveCallRoute({ repoRoot: submodulePath, hasNodeModules: false, shimAvailable: true });
  const lefthookPlan = planLefthook(submodulePath);
  const lefthookRendered = renderLefthook(route.invocation, lang);
  if (lefthookPlan.mode === 'write' || lefthookPlan.mode === 'regenerate') {
    recordWrite(`write ${lefthookPlan.path}`, () => writeFileSync(lefthookPlan.path, lefthookRendered, 'utf8'));
    const lefthookInstalled = await step('lefthook', ['install']);
    if (lefthookInstalled.code !== 0) {
      return fail(`lefthook install failed for ${name}:\n${lefthookInstalled.stderr || lefthookInstalled.stdout}`);
    }
  } else {
    // A team config already owns lefthook.yml (or one of its other 14 names). We never touch
    // it, never run `lefthook install` on their behalf, and write ours to a path we own instead.
    mkdirSync(dirname(lefthookPlan.path), { recursive: true });
    recordWrite(`write ${lefthookPlan.path}`, () => writeFileSync(lefthookPlan.path, lefthookRendered, 'utf8'));
    const theirsPath = join(submodulePath, lefthookPlan.theirs);
    evidence.push(
      `⚠ ${theirsPath}: left untouched — a team lefthook config already exists. `
      + `lefthook: 'manual'. Add to it by hand, then re-run \`lefthook install\` yourself:\n`
      + `  extends:\n    - serpens/lefthook.yml`,
    );
  }

  // 9. Seed .gitignore so build output / caches / local settings are never staged by accident.
  // Never overwrite a real one the repository already has.
  const gitignorePath = join(submodulePath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    const src = join(kitDir, 'system-store-template', 'gitignore.template');
    recordWrite(`cp ${src} ${gitignorePath}`, () => copyFileSync(src, gitignorePath));
  }

  // 10. Declare the store in openspec/config.yaml — id AND remote, or neither cross-repo
  // fetch route resolves and check-contract-split-brain.mjs exits 0 without checking anything.
  // Which file OpenSpec would actually READ — `.yaml` wins, else `.yml` (its own
  // resolveConfigFilePath). We used to hardcode `.yaml`, which meant a repository whose real
  // config is `openspec/config.yml` got a new `config.yaml` from us holding only `references:`,
  // and that shadowed their whole config — schema, context pack and rules all invisible to
  // OpenSpec, with no error. See resolveConfigPath in ../openspecconfig.mjs.
  const resolvedConfig = resolveConfigPath(submodulePath, existsSync);
  const configYamlPath = resolvedConfig.path;
  const existingConfigYaml = resolvedConfig.existed ? readFileSync(configYamlPath, 'utf8') : '';
  // `openspec/config.yaml` is OPENSPEC'S file, and in a brownfield repository it holds the
  // user's own `context:` pack (free prose, up to 50KB, injected into every OpenSpec artifact
  // instruction) and their `rules:`. We add one key to it, `references:`, so cross-repo fetch
  // resolves and split-brain has something to check — and we add it through a scanner that
  // refuses rather than guesses. The string-splicing version this replaced destroyed that data:
  // a `context:` whose prose contained the words "Cross-team references:" made
  // `includes('references:')` true while `findIndex` found no such key, so the entry landed at
  // index 0 and the whole document became invalid YAML. `openspec list` then said "No specs
  // found" instead of erroring, so the user lost their context pack SILENTLY.
  // Repo-local: no store exists, so there is nothing to declare — skipped outright, with the
  // same `{action, text}` shape so the context/rules chain below reads the file unchanged.
  const declared = repoLocal
    ? { action: 'skipped', text: undefined }
    : declareStoreReference(existingConfigYaml, config.store.id, config.store.remote);
  if (declared.action === 'skipped') {
    evidence.push(`${configYamlPath}: references: not written — repo-local topology has no system store to declare`);
  } else if (declared.action === 'refused') {
    // Not a failure of onboarding: it is a file we will not risk. Say exactly what to add.
    evidence.push(
      `⚠ ${configYamlPath}: left untouched — ${declared.reason}. `
      + `Add this to it by hand, then re-run:\n${declared.manual}`,
    );
  } else if (declared.action === 'unchanged') {
    evidence.push(`${configYamlPath}: store "${config.store.id}" already declared under references: — not rewritten`);
  } else {
    recordWrite(
      `write ${configYamlPath} (${declared.action} references: entry for ${config.store.id})`,
      () => writeFileSync(configYamlPath, declared.text, 'utf8'),
    );
  }

  // 10b. Fill the other two slots OpenSpec injects: `context:` with the fact-file CATALOG, and
  // `rules:` with the per-artifact orders. Until now both came back `undefined` on every
  // `openspec instructions` call we made — a slot upstream hands us for free, left empty.
  //
  // The catalog is not "read these files": it is one line per file saying what that file answers,
  // so the agent can choose, and so a shop that adds a tenth fact file does not make every
  // artifact instruction pay for ten reads. The ORDER to read one lives in `rules:`, keyed by
  // artifact, because the stages need different facts — `tasks` cannot list a test step without
  // the testing stack, `proposal` needs none of it.
  //
  // Both are written only when the key is absent. In a brownfield repository `context:` holds the
  // user's own project pack and `rules:` their own constraints; those are theirs, and
  // declareContextCatalog/declareArtifactRules report `unchanged` rather than rewriting them.
  //
  // The artifact ids are `spec-driven`'s. A project-local schema may declare different ones;
  // artifactRules() drops any rule whose artifact is not in the list it is given, so passing the
  // wrong list can only ever write FEWER rules, never a rule into the wrong artifact.
  //
  // The two edits CHAIN IN MEMORY rather than re-reading the file between them. A dry run does
  // not write, so re-reading would hand the second edit a document without the first — and then
  // a real run would write a file missing one of the two blocks. The text each step starts from
  // is whatever the previous step produced, which is also what makes the outcome identical
  // whether or not the run is a dry one.
  const SPEC_DRIVEN_ARTIFACTS = ['proposal', 'specs', 'design', 'tasks'];
  let configText = declared.text ?? existingConfigYaml;
  const extraSlots = [];

  const catalogResult = declareContextCatalog(configText, contextCatalog());
  if (catalogResult.action === 'appended') {
    configText = catalogResult.text;
    extraSlots.push('context catalog');
  } else if (catalogResult.action === 'unchanged') {
    evidence.push(`${configYamlPath}: context catalog not written — ${catalogResult.reason}`);
  } else {
    evidence.push(`⚠ ${configYamlPath}: context catalog not written — ${catalogResult.reason}. Add by hand:\n${catalogResult.manual}`);
  }

  // Artifact rules: unlike the catalog, a brownfield `rules:` is not an all-or-nothing refusal
  // (gap 5). `declareArtifactRules` inserts only the ids the caller asked for that the user has
  // NOT already declared — upstream looks rules up per artifact id, so an id we add can never
  // override one of the user's. `perId` is the only way to report that per-id split; `unchanged`
  // now means "every requested id was already the user's", not "a rules: key already existed".
  const rulesResult = declareArtifactRules(configText, artifactRules(SPEC_DRIVEN_ARTIFACTS));
  if (rulesResult.action === 'appended' || rulesResult.action === 'inserted') {
    configText = rulesResult.text;
    extraSlots.push('artifact rules');
    const inserted = Object.entries(rulesResult.perId ?? {}).filter(([, v]) => v === 'inserted').map(([id]) => id);
    const unchanged = Object.entries(rulesResult.perId ?? {}).filter(([, v]) => v === 'unchanged').map(([id]) => id);
    if (rulesResult.action === 'inserted') {
      evidence.push(`${configYamlPath}: rules: inserted for [${inserted.join(', ')}]`
        + (unchanged.length ? `; left unchanged (already the user's) for [${unchanged.join(', ')}]` : ''));
    }
  } else if (rulesResult.action === 'unchanged') {
    evidence.push(`${configYamlPath}: artifact rules not written — ${rulesResult.reason}`);
  } else {
    evidence.push(`⚠ ${configYamlPath}: artifact rules not written — ${rulesResult.reason}. Add by hand:\n${rulesResult.manual}`);
  }
  if (declared.action && declared.action !== 'skipped' && declared.action !== 'unchanged' && declared.action !== 'refused') {
    recordInstalledFile(submodulePath, relative(submodulePath, configYamlPath), resolvedConfig.existed ? 'appended' : 'created');
  }
  if (extraSlots.length) {
    recordWrite(
      `write ${configYamlPath} (${extraSlots.join(' + ')})`,
      () => writeFileSync(configYamlPath, configText, 'utf8'),
    );
    recordInstalledFile(submodulePath, relative(submodulePath, configYamlPath), resolvedConfig.existed ? 'appended' : 'created');
  }

  // 11. Append the disposer HARD RULE to the port instruction file, exactly once.
  const instructionPath = join(submodulePath, port.instruction_file);
  const instructionExistedBefore = existsSync(instructionPath);
  if (appendHardRuleOnce(instructionPath, lang)) {
    evidence.push(`$ append HARD RULE to ${instructionPath} → done`);
    recordInstalledFile(submodulePath, port.instruction_file, instructionExistedBefore ? 'appended' : 'created');
  } else {
    evidence.push(`HARD RULE already present in ${instructionPath} — not duplicated`);
  }

  // 12. The templates the installed commands cite by path.
  const templatesDir = join(submodulePath, LAYOUT.templates);
  recordWrite(`mkdir -p ${templatesDir}`, () => mkdirSync(templatesDir, { recursive: true }));
  // Never overwrite a file we did not write. These three names are generic enough that a
  // repository can legitimately already have one — `templates/research.md` especially — and the
  // unconditional `copyFileSync` here destroyed it. Same class as the `openspec/config.yaml`
  // corruption: writing into a namespace we do not own.
  //
  // "Ours" is decided by CONTENT, not by presence: a file byte-identical to the kit's template,
  // or one carrying the kit's own `serpens-version:` stamp, is a copy of ours and is refreshed.
  // Anything else is the team's and is reported, not touched — so a re-run still upgrades the
  // kit's own templates while a hand-written file survives every install.
  for (const file of SPOKE_TEMPLATES) {
    const src = join(kitDir, 'templates', file);
    const dest = join(templatesDir, file);
    if (!existsSync(dest)) {
      recordWrite(`cp ${src} ${dest}`, () => copyFileSync(src, dest));
      continue;
    }
    const current = readFileSync(dest, 'utf8');
    const shipped = readFileSync(src, 'utf8');
    if (current === shipped) {
      evidence.push(`${dest} already matches the kit template — not rewritten`);
    } else if (current.includes('serpens-version:')) {
      recordWrite(`cp ${src} ${dest}   # refreshing a kit-stamped template`, () => copyFileSync(src, dest));
    } else {
      evidence.push(
        `⚠ ${dest} exists and is not ours — left untouched. The kit's own copy is at ${src}; `
        + 'merge anything you need from it by hand.',
      );
    }
  }

  // 13. The shim — no script copies, ever.
  const shimPath = writeShim(submodulePath, { binPath: BIN_PATH });
  evidence.push(`shim written: ${shimPath}`);

  return { ok: true, evidence, lefthook: lefthookPlan.mode === 'manual' ? 'manual' : lefthookPlan.mode };
}

/**
 * Stage 5 — onboard every registered submodule (docs/SETUP.md §5). Iterates the paths
 * reported by `.gitmodules` and calls `onboardOne` for each. A repository whose gate fails is
 * recorded in `ctx.failures` and skipped, but every OTHER repository is finished first: a
 * partial repository is the one state the daily flow cannot detect, so leaving one
 * un-onboarded and named is right, and leaving one half-onboarded is not. Stage5 still
 * returns `ok: false` when any repository failed, so the run stops before stage 6.
 * @param {{config: object, port: object, run: Function, log?: object, dryRun?: boolean,
 *   storeRoot: string, kitDir: string, home?: string, failures?: Array}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, failures?: Array}>}
 */
export async function stage5(ctx) {
  const { run, storeRoot, dryRun = false } = ctx;
  const evidence = [];

  // Repo-local (step 6, gap 3): no store, no .gitmodules — onboard the one repository directly.
  if (ctx.topology === 'repo-local') {
    const result = await onboardOne(ctx, ctx.repoRoot);
    evidence.push(...result.evidence);
    if (!result.ok) {
      return { ok: false, evidence, error: result.error, exitCode: result.exitCode };
    }
    const lefthookManual = result.lefthook === 'manual'
      ? [{ name: ctx.config.repo.name, submodulePath: ctx.repoRoot }] : [];
    return { ok: true, evidence, lefthookManual };
  }

  let rows;
  try {
    rows = await readGitmodules(storeRoot, { run });
  } catch (err) {
    return { ok: false, evidence, error: `could not read .gitmodules: ${err.message}`, exitCode: err.exitCode ?? 2 };
  }

  if (dryRun) {
    // `.gitmodules` is read (read-only) so the plan lists the REAL repositories, then each
    // repository's plan comes from onboardOne itself — never a hand-written idealised run.
    if (rows.length === 0) {
      evidence.push(`dry-run: no submodule recorded in ${join(storeRoot, '.gitmodules')} yet — stage5 would onboard nothing`);
    }
    for (const row of rows) {
      const result = await onboardOne(ctx, join(storeRoot, 'submodules', row.name));
      evidence.push(...result.evidence);
    }
    return { ok: true, evidence };
  }

  ctx.failures = [];
  const lefthookManual = [];
  let allOk = true;

  for (const row of rows) {
    const submodulePath = join(storeRoot, 'submodules', row.name);
    const result = await onboardOne(ctx, submodulePath);
    evidence.push(`--- onboarding ${row.name} ---`);
    evidence.push(...result.evidence);
    if (!result.ok) {
      allOk = false;
      ctx.failures.push({ name: row.name, submodulePath, error: result.error });
      evidence.push(`✗ ${row.name}: un-onboarded — ${result.error}`);
    } else {
      evidence.push(`✓ ${row.name}: onboarded`);
      if (result.lefthook === 'manual') lefthookManual.push({ name: row.name, submodulePath });
    }
  }

  if (!allOk) {
    const names = ctx.failures.map((f) => f.name).join(', ');
    return {
      ok: false,
      evidence,
      error: `repository(s) left un-onboarded: ${names}`,
      failures: ctx.failures,
    };
  }

  return { ok: true, evidence, lefthookManual };
}
