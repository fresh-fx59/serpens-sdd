import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTool, findGitRoot } from './tools.mjs';
import { run as defaultRun } from '../run.mjs';
import { unfilledCount } from '../portfacts.mjs';
import { validateTestingStackFile } from '../testingstack.mjs';
import { LAYOUT, HARD_RULE_MARKER } from '../layout.mjs';
import { isOwnedPath } from '../ownership.mjs';

// gen-index.mjs's own --check only proves the regenerated content matches whatever is
// SITTING ON DISK right now — it never asks git anything. That means an agent (or CI, or a
// pre-commit hook running out of order) can generate `serpens/index.{json,md}` (+ `repo.txt`
// on first run), never `git add` them, and still see "index up to date" — green on a
// repository whose committed/staged state has no index at all. Reproduced: `serpens-sdd index`,
// then `serpens-sdd verify-docs` with the index files still `??` in `git status`, passed. Fix:
// after the content check passes, also require every index file gen-index manages to be (a)
// tracked in git's staging index at all, and (b) byte-identical to what's staged there — `git
// show :<path>` is the staged blob, which equals HEAD whenever nothing has been re-staged since
// the last commit. One rule serves all three real callers honestly: an agent must `git add`
// before this goes green (forcing the fix the bug needed); the pre-commit hook already runs
// against staged content, so a properly-staged commit passes and a forgotten `git add` fails
// exactly like the agent case; CI operates on a clean checkout where disk, stage and HEAD all
// agree, so a repository that actually has the index committed passes, and one that doesn't
// (the exact defect) fails instead of reporting a false green.
const INDEX_MANAGED_FILES = [LAYOUT.indexJson, LAYOUT.indexMd, LAYOUT.repoTxt];

/**
 * Fail the index check when a file gen-index.mjs manages is untracked, or tracked but its
 * working-tree content differs from what is staged (equivalently: from HEAD, when nothing has
 * been re-staged since the last commit) — see the comment above `INDEX_MANAGED_FILES`.
 * @param {{repoRoot: string, run: Function, log?: object}} opts
 * @returns {Promise<string[]>} one `✗ ...` message per file with a problem, else []
 */
export async function checkIndexInGit({ repoRoot, run, log }) {
  const problems = [];
  // Only meaningful inside an actual git repository — verify-docs elsewhere already tolerates a
  // non-git root (findGitRoot falls back to cwd unchanged), and a caller with no git repo at
  // all has no "staged/committed" state to compare against in the first place.
  const isRepo = await run('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], { log });
  if (isRepo.code !== 0) return problems;
  const REPO_TXT = LAYOUT.repoTxt;
  for (const rel of INDEX_MANAGED_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) {
      // index.json/index.md: gen-index --check already fails if either is missing entirely
      // (its own drift comparison treats a missing file as empty content, which never equals
      // the regenerated JSON/markdown) — no need to double-report here.
      //
      // repo.txt is DIFFERENT: gen-index.mjs only ever writes it once, on first run, when
      // absent (`if (!existsSync(repoTxt)) writeFileSync(...)`), and `--check` never compares
      // it at all — so a repository whose directory name happens to equal its pinned repo name
      // can lose (or never commit) serpens/repo.txt and both `index --check` AND this loop's
      // old `continue` here stayed green regardless, false-green in exactly the same shape as
      // the index.json/index.md defect this file already fixed once — until a clone into a
      // differently-named directory silently picks up the wrong repo name forever. Catch its
      // absence directly instead of deferring to a content check that never looks at it.
      if (rel === REPO_TXT) {
        problems.push(
          `✗ ${rel}: missing — gen-index.mjs --check never compares this file (it only pins `
          + `identity on first write, never regenerates or diffs it), so a missing repo.txt `
          + `reports green there regardless. Commit it once with \`git add ${rel}\` so a clone `
          + `into a differently-named directory doesn't silently drift onto the wrong repo name.`,
        );
      }
      continue;
    }

    const tracked = await run('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', rel], { log });
    if (tracked.code !== 0) {
      problems.push(
        `✗ ${rel}: untracked — verify-docs' index check only proves the WORKING TREE copy is `
        + `correct, not the repository. Agent: run \`git add ${rel}\` before this can call green. `
        + `Pre-commit hook: this file was generated but never staged for the commit under way. `
        + `CI: the commit under test never checked this file in.`,
      );
      continue;
    }

    const staged = await run('git', ['-C', repoRoot, 'show', `:${rel}`], { log });
    if (staged.code !== 0) {
      problems.push(`✗ ${rel}: tracked, but \`git show :${rel}\` failed — cannot prove the staged copy matches (${(staged.stderr || staged.stdout || 'no output').trim()})`);
      continue;
    }

    const disk = readFileSync(abs, 'utf8');
    if (staged.stdout !== disk) {
      problems.push(
        `✗ ${rel}: the working tree differs from what is staged/committed — this file was `
        + `regenerated after it was last staged. Agent: \`git add ${rel}\` again. Pre-commit `
        + `hook: stage the regenerated file before committing. CI: the checked-out commit's `
        + `index is stale relative to the specs it describes; regenerate and commit it.`,
      );
    }
  }
  return problems;
}

/**
 * The disposer entry point, implemented in the CLI layer rather than wrapped from the vendored
 * `verify-docs.sh`. Every other wrapped script resolves its working root from argv, cwd, or
 * `--repo`; `verify-docs.sh` alone derives it from `dirname "$0"` — its own script location on
 * disk — which assumes it is physically copied into `<repo>/tools/verify-docs.sh`. Wrapped
 * from its real location (the package's own `tools/`), that assumption breaks: it resolves
 * against wherever the package itself lives, never the target repository (reproduced: it
 * fails looking for tools/gen-index.mjs beside the package's own tools/ directory). This
 * reimplements its exact composition — `index --check`, then `lint`, then `split-brain` — each
 * one run against an explicit repoRoot instead, preserving the single-gate contract the agent,
 * the lefthook hook, and CI all call. Also requires (`checkIndexInGit`, above) that the index
 * files gen-index manages are tracked and match what is staged/committed — not just what is on
 * disk — so this cannot report green on a repository the index was never actually added to.
 * `checkGitTracking: false` skips only that git check (content checks still run in full) — the
 * one legitimate caller for that is `onboardOne` (stage5), which runs this BEFORE the operator's
 * own commit, by design, and must stay re-runnable against its own not-yet-committed writes.
 * `onboarding: true` is the other narrow exemption, and it exists for a reproduced ordering
 * bug: `stage5-onboard.mjs` runs this gate on a submodule BEFORE `stage6-install.mjs` writes
 * that submodule's `serpens/testing-stack.md`. Once the file's ABSENCE is an error (below), an
 * unconditional rule would fail every first install at stage 5 — the gate would block the very
 * step that creates the thing it demands. So stage 5 declares itself, and only the absence
 * check relaxes: a testing-stack.md that IS already on disk during onboarding is still
 * validated in full.
 * @param {{repoRoot: string, run?: Function, log?: object, lang?: string,
 *   checkGitTracking?: boolean, onboarding?: boolean}} opts
 * @returns {Promise<{ok: boolean, evidence: string[], output: string}>}
 */
export async function runVerifyDocs({
  repoRoot, run = defaultRun, log, lang = 'en', checkGitTracking = true, onboarding = false,
}) {
  const evidence = [];
  const runOpts = { log, cwd: repoRoot };

  async function step(name, argv = []) {
    const { cmd, args } = resolveTool(name, argv, lang);
    const result = await run(cmd, args, runOpts);
    evidence.push(`$ ${cmd} ${args.join(' ')} → exit ${result.code}`);
    return result;
  }

  let indexCheck = await step('index', ['--check']);

  // Auto-fix (operator decision, 2026-09-23): a plain vanilla `openspec archive <change> --yes`
  // merges a delta into openspec/specs/ but has no idea our generated index exists, so it never
  // regenerates it. That archive commit is not Serpens work (nothing under serpens/ is staged),
  // so the pre-commit hook's `--staged-scope` gate lets it through unchecked — by design. The
  // NEXT commit that touches anything of ours then hits this exact `index --check` drift here,
  // for a reason that has nothing to do with the Serpens work in that commit. Refusing the
  // commit outright would make the operator manually run `serpens-sdd index` before every commit
  // that follows someone else's spec edit — a chore this tool can do for them safely, because
  // regenerating the index is a pure function of openspec/specs/: there is no "wrong" index to
  // preserve, only a stale one to replace. This narrowly targets THIS failure mode — the drift
  // message gen-index.mjs's own `--check` prints — not any other reason `index` could fail (a
  // crash on a malformed spec, a missing openspec/ directory, etc. all fall through unfixed,
  // below). It also covers a hand-edited index/index.md: regenerating overwrites it either way,
  // and that's fine — both are GENERATED files, never hand-authored content worth preserving.
  if (indexCheck.code !== 0) {
    const driftText = `${indexCheck.stdout || ''}${indexCheck.stderr || ''}`;
    if (driftText.includes('✗ index drift')) {
      // Only when the index is already committed: a repo whose index was never generated has not
      // finished install/archive — that is a real failure, not drift from someone else's edit.
      const tracked = await run('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', LAYOUT.indexJson], runOpts);
      if (tracked.code === 0) {
        const regen = await step('index');
        if (regen.code === 0) {
          const addResult = await run(
            'git',
            ['-C', repoRoot, 'add', LAYOUT.indexJson, LAYOUT.indexMd, LAYOUT.repoTxt],
            runOpts,
          );
          if (addResult.code === 0) {
            const recheck = await step('index', ['--check']);
            if (recheck.code === 0) {
              const message = 'index was stale (specs changed outside Serpens) — regenerated and staged';
              evidence.push(message);
              indexCheck = recheck;
            }
            // else: regenerating still doesn't satisfy --check (shouldn't happen — gen-index is
            // deterministic — but if it does, fall through with the recheck's own failure intact
            // via indexCheck staying the ORIGINAL failed result, so nothing is silently swallowed).
          }
          // else: could not stage the regenerated files — fall through, original failure stands.
        }
        // else: regeneration itself failed — fall through, original failure stands (fail hard).
      }
    }
  }

  const lint = await step('lint');
  const splitBrain = await step('split-brain');

  let ok = indexCheck.code === 0 && lint.code === 0 && splitBrain.code === 0;
  let output = [indexCheck.stdout, indexCheck.stderr, lint.stdout, lint.stderr, splitBrain.stdout, splitBrain.stderr]
    .filter(Boolean).join('');
  if (evidence.includes('index was stale (specs changed outside Serpens) — regenerated and staged')) {
    output += 'index was stale (specs changed outside Serpens) — regenerated and staged\n';
  }

  if (checkGitTracking) {
    const indexGitProblems = await checkIndexInGit({ repoRoot, run, log });
    if (indexGitProblems.length > 0) {
      ok = false;
      for (const message of indexGitProblems) {
        evidence.push(message);
        output += `${message}\n`;
      }
    } else {
      evidence.push('✓ index files (that exist) are tracked and match what is staged/committed');
    }
  } else {
    evidence.push('… index git-tracking check skipped (checkGitTracking: false) — content checks above still ran in full');
  }

  // The UNFILLED gate: an install cannot be closed, and the daily flow cannot go green, while
  // `<store>/serpens/port-facts.md` or an onboarded repository's `serpens/testing-stack.md` still carries a
  // section the install could not prove — both are team-authored content stage 6 renders with
  // literal `UNFILLED` markers wherever it could not prove a fact.
  //
  // `port-facts.md` only ever lives at the store root (docs/SETUP.md §3) and is mandatory
  // there — a store whose file was deleted is not "unaffected", it is a gate an operator
  // bypassed by removing the evidence, which is exactly the loophole this gate exists to close.
  // The store is identified by a data signal only it has — never by a flag the caller has to
  // remember to pass. A spoke missing `port-facts.md` (every spoke, always) stays silently fine.
  // Two signals count, per spec-drop-inventory-file-2026-09-11.md §6: OpenSpec's own committed
  // store identity `.openspec-store/store.yaml` (created by the store-registry work, item 3 of
  // that spec) and the legacy `project-repositories.json`. Stage 1 stopped WRITING the legacy
  // file this edition, but never deletes an existing one either, so both remain live signals —
  // dropping the legacy check the moment the file stops being written would silently turn this
  // gate off for every store still carrying one. The legacy check is removed only after an
  // edition has passed with `.openspec-store/store.yaml` alone proven sufficient.
  //
  // `serpens/testing-stack.md` is spoke-only (docs/SETUP.md §5 step 6a copies it into each
  // onboarded repository's own docs/, never into the store). Its absence USED to be
  // "unaffected" everywhere, which was the same evidence-deletion loophole port-facts.md had
  // already closed: `spns-test-plan` and `spns-autotest` now read this file for every fact
  // about the customer's stack, so a spoke without it does not have "no opinion on testing" —
  // it has two commands with nothing to read. Absence is therefore an error in a repository the
  // kit was ONBOARDED into, found by a data signal rather than by a caller flag — a gate you
  // have to remember to ask for is a gate that gets forgotten.
  //
  // The signal is ANY of the artifacts stage 5 installs, not just one. It was keyed on
  // `templates/testing-stack.md` alone, and Codex broke that in one move: delete BOTH
  // testing-stack files and the gate goes quiet — the same evidence-deletion loophole
  // port-facts.md's store rule exists to close. Requiring all of them to disappear together
  // makes the escape hatch honest: a repository with no shim, no lefthook config and no kit
  // templates has had the kit UNINSTALLED, which is a legitimate state this gate should not
  // fail, rather than a gate somebody stepped around by removing one file.
  //
  // Deliberately NOT keyed on `openspec/`: every OpenSpec repository in the world has one,
  // including repositories nobody installed this kit into, and this gate has no business
  // failing those.
  const isStore = existsSync(join(repoRoot, '.openspec-store', 'store.yaml'))
    || existsSync(join(repoRoot, 'project-repositories.json'));
  const ONBOARD_SIGNALS = [
    join(LAYOUT.templates, 'testing-stack.md'), // stage 5 step 12 — the commands cite it by path
    LAYOUT.shim, //                               stage 5 step 13 — the offline call route
    'lefthook.yml', //                            stage 5 step 8  — the pre-commit gate wiring
  ];
  const onboardSignal = ONBOARD_SIGNALS.find((rel) => existsSync(join(repoRoot, rel)));
  const isOnboardedRepo = !isStore && onboardSignal !== undefined;

  function checkUnfilled(relPath, { mandatory = false } = {}) {
    const path = join(repoRoot, relPath);
    if (!existsSync(path)) {
      if (mandatory) {
        ok = false;
        const message = `✗ ${path}: missing — this is the system store (.openspec-store/store.yaml or project-repositories.json is present) and port-facts.md is mandatory here; deleting the evidence file does not clear the gate`;
        evidence.push(message);
        output += `${message}\n`;
      }
      return;
    }
    const count = unfilledCount(readFileSync(path, 'utf8'));
    if (count > 0) {
      ok = false;
      const message = `✗ ${path}: ${count} UNFILLED section(s) remain — the install cannot be closed on unfilled facts`;
      evidence.push(message);
      output += `${message}\n`;
    } else {
      evidence.push(`✓ ${path}: no UNFILLED sections`);
    }
  }
  checkUnfilled(LAYOUT.portFacts, { mandatory: isStore });

  // The testing-stack gate: schema validation, not marker counting. `unfilledCount()` on the
  // raw template returned 0 — only stage 6's rendered wrapper carried a marker — so a team that
  // copied `templates/testing-stack.md` and answered nothing was green. `validateTestingStack`
  // instead requires every anchored section to be present and every slot to hold an answer or
  // an explicit `none`. See src/testingstack.mjs.
  const testingStackRel = LAYOUT.testingStack;
  const testingStackPath = join(repoRoot, testingStackRel);
  if (!existsSync(testingStackPath)) {
    if (isOnboardedRepo && !onboarding) {
      ok = false;
      const message = `✗ ${testingStackPath}: missing — this is an onboarded repository `
        + `(${onboardSignal} is here) and spns-test-plan, spns-autotest, spns-tdd and `
        + 'spns-debugging all read this file for every fact about your stack. Run '
        + '`serpens-sdd init --only 6` to write it from the kit template, then fill it in.';
      evidence.push(message);
      output += `${message}\n`;
    } else {
      evidence.push(`… ${testingStackPath}: absent, and not required here${onboarding ? ' (onboarding: stage 6 writes it)' : ''}`);
    }
  } else {
    const validated = validateTestingStackFile(testingStackPath);
    if (!validated.ok) {
      ok = false;
      for (const problem of validated.problems) {
        evidence.push(problem);
        output += `${problem}\n`;
      }
    } else {
      evidence.push(`✓ ${testingStackPath}: every required section present, every slot answered`);
    }
  }

  if (!ok) {
    evidence.push('✗ verify-docs failed — fix the errors above (each carries a remediation hint), then retry');
    return { ok: false, evidence, output };
  }
  evidence.push('✓ verify-docs passed');
  return { ok: true, evidence, output };
}

/**
 * The `--staged-scope` gate (gap 1, serpens-openspec-coexistence-gaps-2026-09-22.md, step 3,
 * "Trigger layer"). `runVerifyDocs` itself judges the WHOLE repository; a team that runs
 * vanilla OpenSpec beside this kit must never have their own commit blocked by our full gate
 * firing on work we did not create. This decides whether the staged commit touches anything of
 * ours at all, BEFORE the full run — a `git diff --cached --name-only` read, cheap and
 * git-native, no config file needed (this runs from a lefthook hook, which may fire before any
 * config is even read).
 *
 * Owned iff: (a) at least one staged path is ours (`isOwnedPath` — under `serpens/`, or under a
 * `.serpens.yaml`-marked `openspec/changes/<id>/`), OR (b) a staged path sits at the repository
 * ROOT (no `/` in it — a root instruction file, `CLAUDE.md`/`AGENTS.md`/… under whatever name a
 * port uses) and its staged diff (`git diff --cached -- <path>`) contains the HARD RULE marker
 * heading — i.e. the diff touches OUR block, not just any edit to the team's own file.
 *
 * On any git failure (not a repo, `diff` errors), errs OPEN (owned: true) — a hook that cannot
 * even ask git what is staged must run the full gate rather than silently skip it.
 * @param {{repoRoot: string, run?: Function, log?: object}} opts
 * @returns {Promise<{owned: boolean, reason: string}>}
 */
export async function stagedScopeDecision({ repoRoot, run = defaultRun, log }) {
  const staged = await run('git', ['-C', repoRoot, 'diff', '--cached', '--name-only'], { log });
  if (staged.code !== 0) {
    return { owned: true, reason: 'could not list staged paths (git diff --cached failed) — running the full gate' };
  }
  const paths = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (paths.length === 0) {
    return { owned: false, reason: 'no staged path at all' };
  }
  for (const p of paths) {
    if (isOwnedPath(p, repoRoot)) {
      return { owned: true, reason: `${p} is Serpens-owned` };
    }
  }
  for (const p of paths) {
    if (p.includes('/')) continue; // a root instruction file only — not e.g. docs/CLAUDE.md
    // Unified diff context lines carry the marker on every UNRELATED edit to a file that has one
    // — only a genuine +/- line means the staged change touches the block itself.
    const diff = await run('git', ['-C', repoRoot, 'diff', '--cached', '--', p], { log });
    if (diff.code !== 0) continue;
    const touchesBlock = diff.stdout.split('\n').some(
      (line) => /^[+-](?![+-])/.test(line) && line.slice(1).includes(HARD_RULE_MARKER),
    );
    if (touchesBlock) {
      return { owned: true, reason: `${p}'s staged diff touches the HARD RULE block` };
    }
  }
  return { owned: false, reason: 'no Serpens-owned path staged' };
}

/**
 * CLI entry point for `serpens-sdd verify-docs`. Dispatched directly by bin/serpens-sdd.mjs (see
 * buildCommandTable in tools.mjs) rather than through the generic tool-subcommand runner,
 * since this is the one subcommand implemented in the CLI layer instead of wrapped from a
 * vendored script.
 *
 * `--staged-scope` (only argument accepted): the lefthook `serpens-docs` command runs with it —
 * see `stagedScopeDecision` above. The agent's own HARD RULE and CI both still run plain
 * `verify-docs` (no flag), always the full gate.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export default async function main(argv) {
  const repoRoot = findGitRoot(process.cwd());
  if (argv.includes('--staged-scope')) {
    const decision = await stagedScopeDecision({ repoRoot });
    if (!decision.owned) {
      process.stdout.write(`• no Serpens-owned path staged — skipped (${decision.reason})\n`);
      return 0;
    }
  }
  const result = await runVerifyDocs({ repoRoot });
  if (result.output) process.stdout.write(result.output);
  process.stdout.write(`${result.evidence[result.evidence.length - 1]}\n`);
  return result.ok ? 0 : 1;
}
