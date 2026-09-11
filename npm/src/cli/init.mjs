import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateConfig } from '../config.mjs';
import { resolveInputs } from '../resolve.mjs';
import { ask } from '../prompts.mjs';
import { configTemplate } from '../config-template.mjs';
import { loadPort, listPorts } from '../ports.mjs';
import { run as defaultRun, createLog } from '../run.mjs';
import { unfilledCount } from '../portfacts.mjs';
import { unansweredCount } from '../testingstack.mjs';
import { kitPath } from '../integrity.mjs';
import { stage0 } from '../stages/stage0-prereqs.mjs';
import { stage1 } from '../stages/stage1-inventory.mjs';
import { stage3 } from '../stages/stage3-store.mjs';
import { stage4 } from '../stages/stage4-submodules.mjs';
import { stage5 } from '../stages/stage5-onboard.mjs';
import { installCommands } from '../stages/stage6-install.mjs';
import { stage8 } from '../stages/stage8-guards.mjs';
import { stage9 } from '../stages/stage9-accept.mjs';
import { assertOfflineRoutes, callSiteRoots } from '../offline.mjs';

// Execution order is dependency order, NOT the numeric id order docs/SETUP.md lists (0, 1, 3,
// 4, 5, 6, 8, 9). Stage 1 (inventory) resolves the repository row list onto `ctx.repositoryRows`
// (it writes no file at all — see spec-drop-inventory-file-2026-09-11.md §6) by reading
// `.gitmodules` in the store, and stage 4 needs the store to already be a real Git repository to
// materialize submodules into it — and stage 3 is the ONLY stage that creates it. So this
// orchestrator runs 0, 3, 1, 4, 5, 6, 8, 9 — the store is always created (or verified) before
// anything is asked to read or write inside it — while `--only` still selects by the SETUP.md
// stage id, in whatever subset the caller names.
const ALL_STAGES = [
  { id: 0, name: 'prereqs', fn: stage0 },
  { id: 3, name: 'store', fn: stage3 },
  { id: 1, name: 'inventory', fn: stage1 },
  { id: 4, name: 'submodules', fn: stage4 },
  { id: 5, name: 'onboard', fn: stage5 },
  { id: 6, name: 'install', fn: installCommands },
  { id: 8, name: 'guards', fn: stage8 },
  { id: 9, name: 'accept', fn: stage9 },
];

function readFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1) {
    const next = argv[idx + 1];
    if (next !== undefined && !next.startsWith('--')) return next;
    return undefined;
  }
  const prefix = `${flag}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found !== undefined ? found.slice(prefix.length) : undefined;
}

/**
 * Parse `--only`. Returns `{ids: null}` when the flag is absent (meaning "every stage"),
 * `{ids: [...]}` when every named id is a real stage, or `{error}` naming the bad value(s) —
 * an empty `--only ''`, a stage id that doesn't exist (`--only 99`), or a mix (`--only 6,99`)
 * are all refused rather than silently filtering down to a (possibly empty) subset: an empty
 * stage list would otherwise run zero iterations, print the green banner and exit 0 having
 * validated nothing.
 * @param {string[]} argv
 * @returns {{ids: number[]|null, error?: string}}
 */
function parseOnly(argv) {
  const raw = readFlagValue(argv, '--only');
  if (raw === undefined) return { ids: null };
  const validIds = new Set(ALL_STAGES.map((s) => s.id));
  const tokens = raw.split(',').map((s) => s.trim());
  const bad = [];
  const ids = [];
  for (const t of tokens) {
    const n = Number(t);
    if (t === '' || !Number.isInteger(n) || !validIds.has(n)) {
      bad.push(t === '' ? '(empty)' : t);
    } else {
      ids.push(n);
    }
  }
  if (bad.length > 0 || ids.length === 0) {
    return { ids: null, error: `--only '${raw}' names unknown or missing stage id(s): ${bad.length ? bad.join(', ') : '(none given)'} — known ids: ${[...validIds].sort((a, b) => a - b).join(', ')}` };
  }
  return { ids };
}

function selectStages(onlyIds) {
  if (!onlyIds) return ALL_STAGES;
  const wanted = new Set(onlyIds);
  return ALL_STAGES.filter((s) => wanted.has(s.id));
}

/**
 * A log that buffers lines in memory until `attach()` is called with a real path. Needed
 * because the run log lives at `<store>/.serpens-sdd-init-<timestamp>.log`, and on a fresh
 * install the store directory does not exist until stage 3 creates it — nothing may be
 * written to disk before that, so every stage 0 line is held in memory and flushed once the
 * store is real.
 */
function makeBufferedLog() {
  const buffer = [];
  let real = null;
  return {
    line(msg) {
      if (real) real.line(msg);
      else buffer.push({ t: 'line', msg });
    },
    record(result) {
      if (real) real.record(result);
      else buffer.push({ t: 'record', result });
    },
    close() {
      if (real) real.close();
    },
    get attached() {
      return real !== null;
    },
    attach(path) {
      if (real) return;
      real = createLog(path);
      for (const e of buffer) {
        if (e.t === 'line') real.line(e.msg);
        else real.record(e.result);
      }
      buffer.length = 0;
    },
    /**
     * Print every buffered line to stderr instead of disk — used when the run fails before
     * the log was ever attached to a real file (e.g. stage 0 rejects the OpenSpec version
     * before the store, and so the log path, exists). Preserves diagnosis without writing
     * anything. A no-op once `attach()` has run (the real log already owns these lines).
     */
    dumpToStderr() {
      if (real) return;
      for (const e of buffer) {
        if (e.t === 'line') {
          process.stderr.write(`${e.msg}\n`);
        } else {
          const r = e.result;
          process.stderr.write(r.dryRun ? '→ (dry-run, not executed)\n' : `→ exit ${r.code}\n`);
          if (!r.dryRun) {
            if (r.stdout) process.stderr.write(`  stdout: ${r.stdout}\n`);
            if (r.stderr) process.stderr.write(`  stderr: ${r.stderr}\n`);
          }
        }
      }
    },
  };
}

function logPathFor(storeRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(storeRoot, `.serpens-sdd-init-${stamp}.log`);
}

/**
 * Build the refusal checklist (docs/SETUP.md §12 in spirit — the facts no script here can
 * prove): the operator's remaining, human-only follow-up after a green `init`. Printed once,
 * on success, never executed on the operator's behalf.
 * @param {{storeRoot: string, port: object|null, config: object}} ctx
 * @returns {string}
 */
function buildRefusalChecklist({ storeRoot, port, config }) {
  const lines = [];
  lines.push('');
  lines.push('Refusal checklist — serpens-sdd cannot prove these; verify by hand before relying on this install:');
  lines.push('');

  const source = config?.facts?.repository_source ?? 'manual';
  lines.push(
    `1. Repository discovery: repository_source recorded as "${source}"${
      source === 'manual'
        ? ' — no MCP tool was used; confirm the repository list against the forge by hand.'
        : ' — spot-check the MCP-returned repository list against the forge.'
    }`,
  );

  const portFactsPath = join(storeRoot, 'port-facts.md');
  const portFactsUnfilled = existsSync(portFactsPath) ? unfilledCount(readFileSync(portFactsPath, 'utf8')) : null;
  lines.push(
    `2. ${portFactsPath}: ${
      portFactsUnfilled === null ? 'not found' : `${portFactsUnfilled} UNFILLED section(s)`
    } — fill every UNFILLED section by hand (tracker, forge, MCP tool names).`,
  );

  // docs/testing-stack.md lives in each ONBOARDED repository (spec §5 step 6a), never in the
  // directory the CLI was invoked from, so the checklist reports one line per repository that
  // actually has one on disk.
  const testingStackTargets = callSiteRoots(storeRoot).filter((root) => root !== storeRoot);
  if (testingStackTargets.length === 0) {
    lines.push('3. docs/testing-stack.md: no onboarded repository on disk yet — nothing to fill in.');
  } else {
    const parts = testingStackTargets.map((root) => {
      const path = join(root, 'docs', 'testing-stack.md');
      const count = existsSync(path) ? unansweredCount(readFileSync(path, 'utf8')) : null;
      return `${path}: ${count === null ? 'not found' : `${count} unanswered fact(s)`}`;
    });
    lines.push(
      `3. ${parts.join('; ')} — fill in the fast/slow testing tiers, the wiring and debugging `
      + 'boundaries, and every Manual testing access slot by hand. `verify-docs` names each one '
      + 'that is still open; `none` is a complete answer where a slot offers it.',
    );
  }

  lines.push(
    '4. Internal CI wiring (docs/SETUP.md §7): the docs-disposer and catalog stages are a '
    + 'TEMPLATE — adapt them to the real CI and smoke-test before relying on them; nothing here wires it.',
  );

  lines.push(
    `5. Skill inlining: port "${port?.id ?? '(none)'}" reports skills_supported=${port?.skills_supported}`
    + (port?.skills_supported === false
      ? ' — inline the six skill bodies into the installed commands by hand (out of scope for this tool).'
      : ' — skills were copied verbatim; nothing to inline.'),
  );

  lines.push(
    '6. Live proof (no script can prove this): run one `spns-spec` against a throwaway ticket '
    + 'inside the real port, confirm it reaches the interview and writes '
    + 'openspec/changes/<id>/proposal.md, then delete the branch and the change folder.',
  );

  return lines.join('\n');
}

/**
 * `serpens-sdd init` — the single command that joins every stage into one run.
 * Resolves inputs (flag -> config -> env -> prompt -> default -> error), validates the merged
 * config, opens the run log once the store exists, then runs stages `0, 3, 1, 4, 5, 6, 8, 9`
 * (docs/SETUP.md ids, dependency order — see ALL_STAGES) filtered by `--only`, stopping at the
 * first `ok: false`. On success, prints the refusal checklist.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export default async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  // --offline also implies --non-interactive (a prompt is itself a form of waiting on an
  // outside actor). Beyond that it is an ASSERTION, not a mode: after the stages have run it
  // requires spec §7.2's route 1 or route 2 to exist for every generated call site, and fails
  // the install when one would fall through to `npx --no-install` (the route that needs the
  // registry). See src/offline.mjs.
  const nonInteractive = argv.includes('--non-interactive') || argv.includes('--offline');
  const offline = argv.includes('--offline');

  if (argv.includes('--print-config-template')) {
    const lang = readFlagValue(argv, '--lang') ?? 'en';
    // configTemplate is the single source of truth: plain JSON, the same shape --config reads
    // back in, and it round-trips through validateConfig with zero errors (see
    // test/config-template.test.mjs).
    process.stdout.write(configTemplate(lang));
    return 0;
  }

  if (argv.includes('--list-ports')) {
    let ports;
    try {
      ports = listPorts();
    } catch (err) {
      process.stderr.write(`✗ could not list ports: ${err.message}\n`);
      return err.exitCode ?? 2;
    }
    process.stdout.write(`${JSON.stringify(ports.map((p) => ({ id: p.id, label: p.label })), null, 2)}\n`);
    return 0;
  }

  // Validated before anything else touches disk: an empty or unknown --only must never fall
  // through to "select zero stages, run zero iterations, print the green banner".
  const onlyResult = parseOnly(argv);
  if (onlyResult.error) {
    process.stderr.write(`✗ ${onlyResult.error}\n`);
    return 2;
  }

  const configPath = readFlagValue(argv, '--config');
  let fileConfig = {};
  if (configPath) {
    const resolvedConfigPath = resolve(configPath);
    if (!existsSync(resolvedConfigPath)) {
      process.stderr.write(`✗ --config ${configPath}: no such file\n`);
      return 2;
    }
    try {
      fileConfig = JSON.parse(readFileSync(resolvedConfigPath, 'utf8'));
    } catch (err) {
      process.stderr.write(`✗ --config ${configPath}: ${err.message}\n`);
      return 2;
    }
  }

  const tty = process.stdin.isTTY === true;
  const resolved = await resolveInputs({
    argv, config: fileConfig, env: process.env, tty, nonInteractive, ask,
  });
  if (resolved.exitCode) {
    process.stderr.write(`✗ missing required input(s): ${resolved.missing.join(', ')}\n`);
    return resolved.exitCode;
  }

  // resolveInputs only ever produces the flat set of dotted keys in INPUTS — `repositories`
  // and `facts` come from the config file alone, since neither has a flag/env/prompt of its own.
  const merged = {
    ...fileConfig,
    ...resolved.value,
    repositories: Array.isArray(fileConfig.repositories) ? fileConfig.repositories : [],
    facts: fileConfig.facts && typeof fileConfig.facts === 'object' ? fileConfig.facts : {},
  };

  const validated = validateConfig(merged, {
    checkoutRoot: process.cwd(),
    resolveFrom: configPath ? resolve(configPath, '..') : process.cwd(),
  });
  if (!validated.ok) {
    process.stderr.write(`✗ invalid config:\n${validated.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 2;
  }
  const config = validated.value;

  let port = null;
  if (config.port) {
    try {
      port = loadPort({ id: config.port });
    } catch (err) {
      process.stderr.write(`✗ ${err.message}\n`);
      return err.exitCode ?? 2;
    }
  }

  // The directory `init` was invoked from. It is NOT an install target: project-scope installs
  // go to the store and every onboarded submodule (spec §5.4), which is what stage 6 resolves.
  const repoRoot = process.cwd();
  const storeRoot = resolve(config.store.root);

  // The log stays buffered (nothing written to disk) until SOME stage has actually succeeded —
  // never attached up front, even when storeRoot already exists from an earlier run, so a
  // stage 0 failure (e.g. an unsupported OpenSpec version) writes nothing at all. See the
  // attach call inside the loop below.
  const log = makeBufferedLog();

  const ctx = {
    config, port, run: defaultRun, log, dryRun, offline, repoRoot, storeRoot, kitDir: kitPath(config?.lang ?? 'en'),
    // The config FILE this run was given, so that adopting a store's committed id can persist
    // the change instead of reverting on the next run (src/storeregistry.mjs). Undefined when
    // `init` was run without `--config`: there is then no file to persist to.
    ...(configPath ? { configPath: resolve(configPath) } : {}),
  };

  const stages = selectStages(onlyResult.ids);

  log.line(`serpens-sdd init starting — project=${config.project} store=${storeRoot} port=${config.port ?? '(none)'} dryRun=${dryRun}`);

  for (const stage of stages) {
    log.line(`=== stage ${stage.id} (${stage.name}) starting ===`);
    let result;
    try {
      result = await stage.fn(ctx);
    } catch (err) {
      log.line(`=== stage ${stage.id} (${stage.name}) THREW: ${err.message} ===`);
      log.dumpToStderr();
      log.close();
      process.stderr.write(`✗ stage ${stage.id} (${stage.name}) threw: ${err.message}\n`);
      return err.exitCode ?? 1;
    }
    for (const e of result.evidence ?? []) log.line(e);
    // --dry-run prints the plan: every stage's dry-run evidence IS its plan (the commands it
    // would run and the files it would write, derived from the same code paths), and on a dry
    // run there is no store yet to hold a log, so stdout is the only place it can go.
    if (dryRun) {
      process.stdout.write(`=== stage ${stage.id} (${stage.name}) — plan ===\n`);
      for (const e of result.evidence ?? []) process.stdout.write(`${e}\n`);
    }

    // Attach the log to a real file the first time SOME stage has actually succeeded and the
    // store directory exists — normally stage 3 (which creates it), but also covers a re-run
    // or a `--only` subset that starts later against a store already on disk. Never attach
    // before that: a stage 0 failure (e.g. an unsupported OpenSpec version) must write nothing.
    if (!dryRun && result.ok && !log.attached && existsSync(storeRoot)) {
      log.attach(logPathFor(storeRoot));
    }

    if (!result.ok) {
      log.line(`=== stage ${stage.id} (${stage.name}) FAILED: ${result.error} ===`);
      log.dumpToStderr();
      log.close();
      process.stderr.write(`✗ stage ${stage.id} (${stage.name}) failed: ${result.error}\n`);
      return result.exitCode ?? 1;
    }
    log.line(`=== stage ${stage.id} (${stage.name}) OK ===`);
  }

  // Spec §7.2: --offline asserts route 1 or 2 exists for EVERY generated call site. Checked
  // after the stages, because the shim it looks for is what stages 3 and 5 write; a dry run
  // wrote nothing, so there is nothing to assert against and the plan says so instead.
  if (offline) {
    if (dryRun) {
      log.line('--offline: skipped on a dry run (no call site was written to assert against)');
      process.stdout.write('--offline: skipped on a dry run (no call site was written to assert against)\n');
    } else {
      const routes = assertOfflineRoutes({ roots: callSiteRoots(storeRoot) });
      for (const e of routes.evidence) log.line(e);
      if (!routes.ok) {
        log.line('=== --offline assertion FAILED ===');
        log.dumpToStderr();
        log.close();
        process.stderr.write(
          `✗ --offline: no offline call route for ${routes.missing.join(', ')}\n`
          + `${routes.evidence.filter((e) => e.startsWith('✗')).join('\n')}\n`,
        );
        return 3;
      }
      process.stdout.write(`✓ --offline: route 1 or 2 present for all ${routes.evidence.length} call site(s)\n`);
    }
  }

  log.line('serpens-sdd init completed green');
  log.close();

  process.stdout.write('✓ serpens-sdd init completed green\n');
  process.stdout.write(`${buildRefusalChecklist({ storeRoot, port, config })}\n`);
  return 0;
}
