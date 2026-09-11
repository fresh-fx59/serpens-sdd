import {
  existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool, toolPath } from '../cli/tools.mjs';
import { writeShim, resolveCallRoute, renderLefthook } from '../shim.mjs';
import { resolveScope, assertLintScope } from '../scope.mjs';
import { readGitmodules } from '../inventory.mjs';
import { splitInvocation } from '../invocation.mjs';
import { runVerifyDocs } from '../cli/verify-docs.mjs';
import { declareStoreReference, resolveConfigPath } from '../openspecconfig.mjs';

const BIN_PATH = fileURLToPath(new URL('../../bin/serpens-sdd.mjs', import.meta.url));

// docs/SETUP.md §5 item 4: the templates the installed commands cite by path for a SPOKE
// repository — a subset of the six templates the store gets (no store-contract.md there).
const SPOKE_TEMPLATES = ['adr.md', 'research.md', 'testing-stack.md'];

const HARD_RULE_MARKER = '## HARD RULE — disposer self-check';
const HARD_RULE_BLOCK = `${HARD_RULE_MARKER}
After creating or editing ANY file under openspec/ or docs/, run:
    "$(git rev-parse --show-toplevel)"/tools/serpens-sdd verify-docs
Fix every ✗ (each error carries a remediation hint) and re-run until green
BEFORE reporting work done or proposing a commit. Rejected writes are corrected
by regenerating the content — never by loosening caps or deleting checks.
CIRCUIT BREAKER: if the same error survives 3 fix attempts, STOP and ask a human —
do not keep looping.
`;

/**
 * Append the disposer HARD RULE to a port's instruction file, exactly once. Creates the file
 * if it does not yet exist (a freshly-added submodule has no port scaffold of its own before
 * this).
 * @param {string} path
 */
function appendHardRuleOnce(path) {
  if (!existsSync(path)) {
    writeFileSync(path, HARD_RULE_BLOCK, 'utf8');
    return true;
  }
  const existing = readFileSync(path, 'utf8');
  if (existing.includes(HARD_RULE_MARKER)) return false;
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, `${existing}${sep}${HARD_RULE_BLOCK}`, 'utf8');
  return true;
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
  lines.push(`  $ ${openspec} init${port?.id ? ` --tools ${port.id}` : ''}   # cwd=${submodulePath}`);
  lines.push(`  $ bash ${tool('check-openspec-root.sh')}   # must report ${submodulePath}, not the store`);
  lines.push(`  $ bash ${tool('repository-state.sh')} prepare-base --repo ${submodulePath} --base <.gitmodules branch>`);
  lines.push(`  scope: ${(port?.scope_preference ?? []).join(' -> ')}; on user scope also `
    + '$ git config serpens.agentDir <rel> plus the planted-probe lint proof');
  lines.push(`  $ write ${join(submodulePath, 'openspec', 'repo.txt')}`);
  lines.push(`  $ mkdir -p ${join(submodulePath, 'openspec', 'adr')} and write its .gitkeep`);
  lines.push(`  $ ${indexCmd} ${indexArgs.join(' ')}`);
  lines.push('  $ serpens-sdd verify-docs (index --check, lint, split-brain, then the UNFILLED gate)');
  lines.push(`  $ write ${join(submodulePath, 'lefthook.yml')}   # run: ${route.invocation} …`);
  lines.push('  $ lefthook install');
  lines.push(`  $ cp ${join(kitDir, 'system-store-template', '.gitignore')} ${join(submodulePath, '.gitignore')}   # only when absent`);
  lines.push(`  $ write ${join(submodulePath, 'openspec', 'config.yaml')}   # references: id ${config?.store?.id} + remote ${config?.store?.remote}`);
  lines.push(`  $ append the disposer HARD RULE to ${join(submodulePath, port?.instruction_file ?? '(no instruction_file)')}   # exactly once`);
  for (const file of SPOKE_TEMPLATES) {
    lines.push(`  $ cp ${join(kitDir, 'templates', file)} ${join(submodulePath, 'templates', file)}`);
  }
  lines.push(`  $ write ${join(submodulePath, 'tools', 'serpens-sdd')}   # the shim; no tools/ script copies, ever`);
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

  const name = basename(submodulePath);
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
  let rows;
  try {
    rows = await readGitmodules(storeRoot, { run });
  } catch (err) {
    return fail(`could not read .gitmodules to resolve ${name}'s base branch: ${err.message}`, err.exitCode ?? 2);
  }
  const row = rows.find((r) => r.name === name);
  const base = row?.base_branch;
  if (!base) {
    return fail(`${name}: no base_branch recorded in .gitmodules`, 2);
  }

  const { cmd: openspecCmd, args: openspecBaseArgs } = splitInvocation(config?.openspec?.invocation);

  // 1. Initialize OpenSpec BEFORE `state prepare-base`: an un-onboarded submodule has no
  // openspec/ of its own, so OpenSpec's upward walk resolves to the STORE's root instead —
  // repository-state.sh's own assert modes refuse to run against a repo that isn't its own
  // OpenSpec root (verified: it fails here with exactly that message and points at this fix).
  const initArgs = ['init'];
  if (port?.id) initArgs.push('--tools', port.id);
  const inited = await step(openspecCmd, [...openspecBaseArgs, ...initArgs]);
  if (inited.code !== 0) {
    return fail(`openspec init failed in ${name}:\n${inited.stderr || inited.stdout}`);
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
  const prepared = await step('bash', [toolPath('state', lang), 'prepare-base', '--repo', submodulePath, '--base', base]);
  if (prepared.code !== 0) {
    return fail(`state prepare-base failed for ${name}:\n${prepared.stderr || prepared.stdout}`);
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
  recordWrite(`write ${join(submodulePath, 'openspec', 'repo.txt')}`, () => {
    writeFileSync(join(submodulePath, 'openspec', 'repo.txt'), `${name}\n`, 'utf8');
  });

  // 6. openspec/adr/ must exist even empty — spns-archive writes openspec/adr/NNNN-<slug>.md
  // and will not create the directory itself, and a bare directory never survives a clone.
  const adrDir = join(submodulePath, 'openspec', 'adr');
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
  // testing-stack gate now treats an absent `docs/testing-stack.md` as an error on a spoke, and
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

  // 8. lefthook.yml, rendered for the resolved call route, then installed. The shim is always
  // written in this same pass (step 13 below), so the route is always 'shim' — hasNodeModules
  // and repoRoot are irrelevant to the outcome here, only kept as resolveCallRoute's contract.
  const route = resolveCallRoute({ repoRoot: submodulePath, hasNodeModules: false, shimAvailable: true });
  const lefthookPath = join(submodulePath, 'lefthook.yml');
  recordWrite(`write ${lefthookPath}`, () => writeFileSync(lefthookPath, renderLefthook(route.invocation, lang), 'utf8'));
  const lefthookInstalled = await step('lefthook', ['install']);
  if (lefthookInstalled.code !== 0) {
    return fail(`lefthook install failed for ${name}:\n${lefthookInstalled.stderr || lefthookInstalled.stdout}`);
  }

  // 9. Seed .gitignore so build output / caches / local settings are never staged by accident.
  // Never overwrite a real one the repository already has.
  const gitignorePath = join(submodulePath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    const src = join(kitDir, 'system-store-template', '.gitignore');
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
  const declared = declareStoreReference(existingConfigYaml, config.store.id, config.store.remote);
  if (declared.action === 'refused') {
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

  // 11. Append the disposer HARD RULE to the port instruction file, exactly once.
  const instructionPath = join(submodulePath, port.instruction_file);
  if (appendHardRuleOnce(instructionPath)) {
    evidence.push(`$ append HARD RULE to ${instructionPath} → done`);
  } else {
    evidence.push(`HARD RULE already present in ${instructionPath} — not duplicated`);
  }

  // 12. The templates the installed commands cite by path.
  const templatesDir = join(submodulePath, 'templates');
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

  return { ok: true, evidence };
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

  return { ok: true, evidence };
}
