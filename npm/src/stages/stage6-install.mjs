import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { resolveScope, assertLintScope } from '../scope.mjs';
import { readGitmodules } from '../inventory.mjs';
import { splitInvocation } from '../invocation.mjs';
import { SHIM_INVOCATION } from '../shim.mjs';
import { renderPortFacts } from '../portfacts.mjs';
import { renderTestingStack, upgradeTestingStack } from '../testingstack.mjs';

// The package's own serpensSddEdition is always known, never a guess — same convention as
// src/cli/help.mjs's PACKAGE_EDITION. Read once at module load.
const PACKAGE_EDITION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).serpensSddEdition;

/**
 * Replace both installable tokens in a kit command or skill body with their resolved values.
 * `<openspec>` is the exact OpenSpec CLI invocation resolved in stage 2/3
 * (`config.openspec.invocation`). `<serpens-sdd>` names this package's own invocation for a port
 * that needs to call back into it — no shipped command file carries that token today, so this
 * half of the substitution is a no-op in practice; it exists so a future command referencing it
 * is handled the same way, not specially.
 * @param {string} text
 * @param {{openspec: string, serpensSdd: string}} tokens
 * @returns {string}
 */
export function substituteTokens(text, { openspec, serpensSdd }) {
  return text.replaceAll('<openspec>', openspec).replaceAll('<serpens-sdd>', serpensSdd ?? '');
}

/**
 * Where one kit command file lands for a port, by `command_layout`. Shared by the real install
 * and by `--dry-run`'s plan so the printed destinations are the destinations, not a second
 * description of them. Returns `null` for an unknown layout (the caller decides how to fail).
 * @param {object} port
 * @param {string} commandDir - the resolved `<agentRoot>/<command_dir>`
 * @param {string} file - a kit command filename, e.g. `spns-spec.md`
 * @returns {{path: string, subdir?: string}|null}
 */
export function commandDestination(port, commandDir, file) {
  const name = basename(file, '.md').replace(/^spns-/, '');
  if (port.command_layout === 'flat-prefixed') {
    return { path: join(commandDir, `${port.command_prefix}${name}.${port.command_format}`) };
  }
  if (port.command_layout === 'subdir-unprefixed') {
    const subdir = join(commandDir, port.command_prefix);
    return { path: join(subdir, `${name}.${port.command_format}`), subdir };
  }
  return null;
}

/**
 * Everything stage 6 would write, printed by `--dry-run`. Command destinations come from
 * `commandDestination` and skill names from the kit tree itself (both read-only), so the plan
 * lists the real files. The chosen scope is deliberately NOT decided here: deciding it means
 * running `resolveScope`'s write probe, which would create a directory under `$HOME`.
 * @param {object} ctx - the same ctx `installCommands` receives
 * @returns {string[]}
 */
export function installPlan(ctx) {
  const { config, port, kitDir, storeRoot } = ctx;
  const home = ctx.home ?? homedir();
  const force = config?.port_scope && config.port_scope !== 'auto' ? config.port_scope : undefined;
  const lines = ['dry-run: stage6 would do (nothing below is written):'];

  if (port?.commands_supported !== true || port?.skills_supported !== true) {
    lines.push(`  refuses: port "${port?.id}" reports commands_supported=${port?.commands_supported}, `
      + `skills_supported=${port?.skills_supported} — a real run stops here`);
    return lines;
  }

  const submodulesDir = join(storeRoot, 'submodules');
  const submoduleRoots = existsSync(submodulesDir)
    ? readdirSync(submodulesDir, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => join(submodulesDir, e.name)).sort()
    : [];

  const order = force ? [force] : (port.scope_preference ?? []);
  lines.push(`  scope preference: ${order.join(' -> ')}${force ? ' (forced by --port-scope)' : ''}`);
  const userRoot = join(home, port.agent_dir);
  const projectRoots = [storeRoot, ...submoduleRoots].map((r) => join(r, port.agent_dir));
  if (order.includes('user')) lines.push(`    user candidate:    ${userRoot} (chosen only if a real write probe succeeds)`);
  if (order.includes('project')) lines.push(`    project candidates: ${projectRoots.join(', ')}`);

  const commandFiles = readdirSync(join(kitDir, 'commands')).filter((f) => f.endsWith('.md')).sort();
  const skillNames = readdirSync(join(kitDir, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  lines.push(`  per chosen target <agent-root>, relative to it:`);
  for (const file of commandFiles) {
    const dest = commandDestination(port, port.command_dir, file);
    lines.push(`    $ write <agent-root>/${dest ? dest.path : `(unknown command_layout ${port.command_layout})`}`);
  }
  for (const skillName of skillNames) {
    lines.push(`    $ write <agent-root>/${join(port.skill_dir, skillName, 'SKILL.md')}`);
  }
  lines.push('  $ grep -rnE \'<openspec>|<serpens-sdd>\' <every installed command+skill dir>   # must find nothing');
  if (order.includes('user')) {
    lines.push(`  if user scope wins: $ git -C ${storeRoot} config serpens.agentDir <rel path to ${userRoot}>, then the planted-probe lint proof`);
  }
  for (const root of submoduleRoots) {
    lines.push(`  $ write ${join(root, 'docs', 'testing-stack.md')}   # only when absent; never overwritten`);
  }
  if (submoduleRoots.length === 0) {
    lines.push('  no onboarded submodule on disk — docs/testing-stack.md would be written nowhere');
  }
  lines.push(`  $ write ${join(storeRoot, 'port-facts.md')}   # rendered from what this run proved`);
  return lines;
}

/**
 * Stage 6 — install Serpens commands and skills into the discovered port (docs/SETUP.md §6).
 * Maps each kit command file to a destination by `port.command_layout`
 * (`flat-prefixed` -> `<prefix><name>.<format>`, `subdir-unprefixed` ->
 * `<prefix>/<name>.<format>`), copies the six skills verbatim (by directory name) when
 * `skills_supported`, substitutes both tokens in every copy, then proves the substitution with
 * a real grep over the installed command directory — a hit there means the install is not done,
 * whatever the file listing says.
 *
 * A port with `commands_supported: false` stops with an error naming the port, rather than
 * inventing a location. A port with `skills_supported: false` stops too: inlining six skill
 * bodies into the command text is prose rewriting, not copying, and no script here may attempt
 * it (YAGNI — this is out of scope by design, not an oversight).
 * Once the install is actually proven, it also renders `<storeRoot>/port-facts.md` from
 * exactly what was proven here — the resolved OpenSpec invocation, the port, the chosen scope,
 * `git config serpens.agentDir`, the kit edition, and the store id/root/repository_source — and
 * writes it over whatever copy is there (the raw, still-templated copy stage 3 installed, or an
 * earlier run's rendering). Only stage 6 can write the real facts: the port entry, the chosen
 * scope, `serpens.agentDir`, and the store path do not exist until this stage runs.
 * @param {{config: object, port: object, run: Function, log?: object, dryRun?: boolean,
 *   storeRoot: string, kitDir: string, home?: string, edition?: string}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function installCommands(ctx) {
  const { config, port, run, log, kitDir, storeRoot, dryRun = false } = ctx;
  const lang = config?.lang ?? 'en';
  const evidence = [];

  function fail(error, exitCode = 2) {
    return { ok: false, evidence, error, exitCode };
  }
  function recordWrite(description, fn) {
    fn();
    evidence.push(`$ ${description} → done`);
  }

  if (dryRun) {
    // The scope DECISION cannot be taken here: `resolveScope`'s user-scope check is a real
    // write-then-delete probe that would create `$HOME/<agent_dir>`, and --dry-run must touch
    // nothing. So the plan prints the preference order and the candidate roots for each, plus
    // the exact per-target destinations (through `commandDestination`, the same function the
    // real install uses) once a scope is chosen.
    for (const line of installPlan(ctx)) evidence.push(line);
    return { ok: true, evidence };
  }

  if (port?.commands_supported !== true) {
    return fail(`port "${port?.id}" does not support installed commands (commands_supported: false) — refusing to guess a destination`);
  }
  if (port?.skills_supported !== true) {
    return fail(`port "${port?.id}" does not support skills (skills_supported: false) — inlining six skill bodies into the commands is prose rewriting, not copying, and is out of scope here`);
  }

  const home = ctx.home ?? homedir();
  const force = config?.port_scope && config.port_scope !== 'auto' ? config.port_scope : undefined;

  // Project scope is `<repo>/<agent_dir>` **in the store and in every onboarded submodule**
  // (spec §5.4) — never the directory the CLI happened to be invoked from. Resolving against
  // `ctx.repoRoot` (which is `process.cwd()`) put the whole install wherever the operator
  // stood, so an agent working in the store or a spoke saw no spns-* commands at all on a
  // project-scope-only port. The scope DECISION is taken once, against the store (the one
  // repository that always exists by the time this stage runs); user scope then installs once
  // into `$HOME/<agent_dir>`, project scope installs into every project root.
  const submoduleRoots = [];
  try {
    const rows = await readGitmodules(storeRoot, { run });
    for (const row of rows) {
      const path = join(storeRoot, 'submodules', row.name);
      if (existsSync(path)) submoduleRoots.push(path);
    }
  } catch (err) {
    return fail(`could not read .gitmodules to resolve the project-scope install targets: ${err.message}`, err.exitCode ?? 2);
  }
  const projectRoots = [storeRoot, ...submoduleRoots];

  let scopeResult;
  try {
    scopeResult = resolveScope(port, { home, repoRoot: storeRoot, force });
  } catch (err) {
    return fail(`could not resolve port scope for "${port?.id}": ${err.message}`, err.exitCode ?? 3);
  }
  evidence.push(`scope resolved: ${scopeResult.reason}`);
  const agentRoots = scopeResult.scope === 'user'
    ? [scopeResult.agentRoot]
    : projectRoots.map((root) => join(root, port.agent_dir));
  evidence.push(`install target(s): ${agentRoots.join(', ')}`);

  const { cmd: openspecCmd, args: openspecArgs } = splitInvocation(config?.openspec?.invocation);
  const openspecToken = [openspecCmd, ...openspecArgs].filter(Boolean).join(' ');
  // The default MUST be the shim this install has already written (stages 3 and 5), not a bare
  // `serpens-sdd`: nothing puts the package on PATH in a devDependency or `npx` shop, and stage 5
  // writes the hooks through the same `SHIM_INVOCATION`. A bare `serpens-sdd` here made the two
  // halves of one install disagree — the hooks ran and every installed command died with
  // `serpens-sdd: command not found`. `config.serpens_sdd.invocation` overrides it for a shop that
  // genuinely calls the package another way (spec §3).
  const serpensSddToken = config?.serpens_sdd?.invocation ?? SHIM_INVOCATION;
  const tokens = { openspec: openspecToken, serpensSdd: serpensSddToken };

  // 1 + 2. Commands and skills, into every resolved target. Skills are copied verbatim by
  // directory name, never merged or inlined.
  const srcCommandDir = join(kitDir, 'commands');
  const commandFiles = readdirSync(srcCommandDir).filter((f) => f.endsWith('.md')).sort();
  const srcSkillsDir = join(kitDir, 'skills');
  const skillNames = readdirSync(srcSkillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const proofDirs = [];
  for (const agentRoot of agentRoots) {
    const commandDir = join(agentRoot, port.command_dir);
    recordWrite(`mkdir -p ${commandDir}`, () => mkdirSync(commandDir, { recursive: true }));
    for (const file of commandFiles) {
      const raw = readFileSync(join(srcCommandDir, file), 'utf8');
      const substituted = substituteTokens(raw, tokens);
      const dest = commandDestination(port, commandDir, file);
      if (!dest) {
        return fail(`unknown command_layout "${port.command_layout}" for port "${port.id}"`);
      }
      if (dest.subdir) mkdirSync(dest.subdir, { recursive: true });
      recordWrite(`write ${dest.path}`, () => writeFileSync(dest.path, substituted, 'utf8'));
    }

    const skillsRoot = join(agentRoot, port.skill_dir);
    for (const skillName of skillNames) {
      const srcSkillFile = join(srcSkillsDir, skillName, 'SKILL.md');
      if (!existsSync(srcSkillFile)) continue;
      const raw = readFileSync(srcSkillFile, 'utf8');
      const substituted = substituteTokens(raw, tokens);
      const destDir = join(skillsRoot, skillName);
      recordWrite(`mkdir -p ${destDir}`, () => mkdirSync(destDir, { recursive: true }));
      const destFile = join(destDir, 'SKILL.md');
      recordWrite(`write ${destFile}`, () => writeFileSync(destFile, substituted, 'utf8'));
    }
    proofDirs.push(commandDir, skillsRoot);
  }

  // 3. The proof: neither token may survive in ANY installed directory — commands or skills,
  // in every target. A leftover token in a SKILL.md would otherwise ship silently, since
  // skills are substituted the same way but were never covered by a command-dir-only proof.
  const proof = await run('grep', ['-rnE', '<openspec>|<serpens-sdd>', ...proofDirs], { log });
  evidence.push(`$ grep -rnE '<openspec>|<serpens-sdd>' ${proofDirs.join(' ')} → exit ${proof.code}`);
  if (proof.code === 0) {
    return fail(`unresolved token(s) remain in ${proofDirs.join(' or ')}:\n${proof.stdout}`);
  }
  if (proof.code > 1) {
    return fail(`token proof (grep) failed with exit ${proof.code}: ${proof.stderr || proof.stdout}`);
  }

  // 3b. Spec §5.5: on a user-scope install `git config serpens.agentDir` must be set in the store
  // AND in every submodule (stage 5 does each submodule as it onboards it; the store has no
  // onboarding pass of its own, so it is done here) — and then PROVEN, by the same
  // planted-probe route stage 5 uses, because a gate that cannot be shown active is failed.
  if (scopeResult.scope === 'user') {
    const agentDirRel = relative(storeRoot, scopeResult.agentRoot);
    const configured = await run('git', ['-C', storeRoot, 'config', 'serpens.agentDir', agentDirRel], { log });
    evidence.push(`$ git -C ${storeRoot} config serpens.agentDir ${agentDirRel} → exit ${configured.code}`);
    if (configured.code !== 0) {
      return fail(`could not set serpens.agentDir in the store:\n${configured.stderr}`, 1);
    }
    const lintProof = await assertLintScope({
      repoRoot: storeRoot, agentRoot: scopeResult.agentRoot, run, lang,
    });
    evidence.push(`$ assertLintScope(store) → ${lintProof.ok ? 'ok' : 'failed'}`);
    if (!lintProof.ok) {
      return fail(`serpens.agentDir was set in the store but assertLintScope could not prove it: ${lintProof.error}`, 1);
    }
  }

  // 4. docs/SETUP.md §5 step 6a: `docs/testing-stack.md` in EACH onboarded repository — not in
  // the CLI's working directory, and (per verify-docs' own store/spoke rule) not in the store.
  // Controller-ruled into this stage rather than stage 5: it is the same class of
  // team-authored, UNFILLED-gated content as port-facts.md, not mechanical onboarding.
  // Re-runnable: never overwrite a copy the team has already started filling in.
  if (submoduleRoots.length === 0) {
    evidence.push('no onboarded submodule on disk — docs/testing-stack.md was not written anywhere');
  }
  for (const root of submoduleRoots) {
    const testingStackDest = join(root, 'docs', 'testing-stack.md');
    const templatePath = join(kitDir, 'templates', 'testing-stack.md');
    const templateText = readFileSync(templatePath, 'utf8');
    if (!existsSync(testingStackDest)) {
      const rendered = renderTestingStack(templateText);
      recordWrite(`mkdir -p ${join(root, 'docs')}`, () => mkdirSync(join(root, 'docs'), { recursive: true }));
      recordWrite(`write ${testingStackDest}`, () => writeFileSync(testingStackDest, rendered, 'utf8'));
    } else {
      // The UPGRADE path. Never overwriting an existing file is right — it holds the team's own
      // answers — but on its own it stranded every repository filled in under an older edition:
      // a section added later would never appear, and the file would fail the new gate with no
      // route forward but hand-editing. So append the sections and slot rows this edition
      // requires and the file does not have, verbatim from the template and therefore still
      // marked UNFILLED, and touch nothing that is already answered.
      const existing = readFileSync(testingStackDest, 'utf8');
      const upgraded = upgradeTestingStack(existing, templateText);
      if (upgraded.changed) {
        recordWrite(
          `append ${upgraded.appended.join(', ')} to ${testingStackDest}`,
          () => writeFileSync(testingStackDest, upgraded.text, 'utf8'),
        );
        evidence.push(`${testingStackDest} already present — kept every answer, appended unanswered: ${upgraded.appended.join(', ')}`);
      } else {
        evidence.push(`${testingStackDest} already present and schema-current — not overwritten`);
      }
    }
  }

  // 5. Render the store's port-facts.md from what THIS run actually proved, and write it over
  // whatever was there — the raw template stage 3 installed, or an earlier run's rendering.
  // Controller ruling: only stage 6 can produce the real facts (port, scope, serpens.agentDir and
  // the store path all resolve here, not in stage 3), so stage 6 is the one write site.
  if (storeRoot) {
    const edition = ctx.edition ?? PACKAGE_EDITION;
    const repositorySource = config?.facts?.repository_source ?? 'manual';
    const rendered = renderPortFacts({
      openspec: openspecToken,
      port: port.id,
      scope: scopeResult.scope,
      agentDir: agentRoots.join(', '),
      edition,
      storeId: config?.store?.id,
      storeRoot,
      repositorySource,
    });
    const portFactsDest = join(storeRoot, 'port-facts.md');
    recordWrite(`write ${portFactsDest}`, () => writeFileSync(portFactsDest, rendered, 'utf8'));
  } else {
    evidence.push('no storeRoot in ctx — port-facts.md was not rendered (nothing to prove the store path against)');
  }

  return { ok: true, evidence };
}
