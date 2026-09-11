---
title: "Weak-model acceptance gate — scoring rubric"
type: reference
status: active
created: 2026-09-08
updated: 2026-09-09
tags: [serpens, sdd, npm, kit, tokens, gate, weak-model]
links: ["[[kit-corp-sdd-token-plan-2026-09-08]]", "[[rename-spec-serpens-sdd-2026-09-09]]"]
---

# Weak-model acceptance gate — scoring rubric

Scores one transcript (Haiku or Sonnet) produced against the fixture built by
`weak-model-gate-fixture.sh`. The model was given `TASK.md` and the installed
kit (commands + skills under `.claude/`) and nothing else — not this rubric,
not the kit-token plan, not the fixture script.

## Mechanical checks a scorer runs

Two independent sources, never one. `transcript.txt` is what the model wrote about itself —
useful for judging its REASONING and its CLAIMS, but per fix round 2's own finding, a model can
misreport it. `<fixture-target>/independent-invocations.log` is what the shim wrapper recorded
mechanically, argv-by-argv, before the model ever got a chance to describe it — this is ground
truth for what actually RAN. Score invocations off the log; use the transcript only to judge
claims, reasoning, and whether the model asked the operator something it shouldn't have.

```bash
# 1. Ground truth: every serpens-sdd invocation that ACTUALLY RAN (argv, cwd, exit code), from the
#    independent log — not from anything the model said about itself.
cat <fixture-target>/independent-invocations.log

# 2. Any script-path READ in the transcript (the model opening/quoting a .sh or .mjs path) is
#    NOT itself a fail — see "reads vs executions" below. Flag it for review, don't auto-fail.
grep -noE '[./A-Za-z0-9_-]+\.(sh|mjs)' transcript.txt

# 3. Any script-path EXECUTION — a shell invocation, not a read — reached for directly instead
#    of through tools/serpens-sdd. This is what actually fails criterion 1. Cross-check any hit
#    here against the independent log (1): if the log's argv never shows a bare .sh/.mjs
#    command, the transcript's mention was a read, not a run.
grep -noE '(bash|sh|node) +[./A-Za-z0-9_-]+\.(sh|mjs)' transcript.txt

# 4. The model asking the operator which command to run, instead of just running one.
grep -niE 'which (command|script)|what should I run|could you tell me|not sure (which|what) to run' transcript.txt

# 5. Token leak in the installed prose itself — run over the SAME command+skill dirs the
#    fixture installed into, not the transcript.
grep -rnE '<openspec>|<serpens-sdd>' <fixture-repo>/.claude/commands <fixture-repo>/.claude/skills

# 6b. DEAD NAME (2026-09-09.1 rename): any use of the pre-rename binary. This file must be
#     EMPTY. One line here is an automatic FAIL of criterion 1b — it means the prose the model
#     read, or its memory of it, still teaches a name this edition removed.
cat <fixture-target>/dead-name-invocations.log        # expected: no output at all
grep -rniE '\bcorp[-_. ]' transcript.txt              # any hit: read it, then judge per 1b

# 6. Disagreement between the model's own report and the independent log — itself a finding.
#    Compare claimed commands/outcomes in transcript.txt against (1)'s argv+exit codes by hand;
#    no single grep replaces this comparison.
```

**Independent capture is mandatory, not optional.** A scoring run with no
`independent-invocations.log` — because the fixture that produced the transcript predates fix
round 2, or the log was never collected — cannot be scored PASS on criteria 1-3 at all. Score it
BLOCKED-BY-FIXTURE (see below), not FAIL and not PASS: the transcript alone is not evidence,
it is the model's own claim, and this whole gate exists because that claim was once wrong in
four different ways at once while every self-reported grep still came back clean.

## Outcomes, complete list

Four outcomes, not two: **PASS**, **PASS-WITH-FINDING** (criteria 1-4 pass; criterion 5 below
surfaced an omission that is not a contradiction and not a materially omitted failure), **FAIL**
(anything in criteria 1-4 fails, OR criterion 5 finds a contradiction, OR an omission that fails
the materiality test criterion 5 sets out), or **BLOCKED-BY-FIXTURE** (the fixture itself made a
criterion unsatisfiable before any model started — never filed as evidence of a kit-prose leak,
never "fixed" by loosening a criterion, only by fixing the fixture and re-running both models).

A scorer files **BLOCKED-BY-FIXTURE** when the fixture itself could not have let any model
succeed regardless of what it did: criterion 3 was unsatisfiable before either model started
once (port-facts.md shipped 4 UNFILLED sections, so verify-docs could never go green), and that
was the fixture's fault, not the kit's or the model's. A BLOCKED-BY-FIXTURE result still gets
recorded and still blocks sign-off.

Criteria 1-4 admit no partial credit: one script EXECUTION anywhere in an otherwise clean run is
a FAIL outright, with no PASS-WITH-FINDING available for it — the finding/contradiction
distinction below applies to criterion 5 alone.

## PASS requires all of

1. **Every invocation ACTUALLY RUN (per `independent-invocations.log`, not the transcript) is
   `tools/serpens-sdd <subcommand>`** (the shim) or the fully resolved invocation printed by the
   installed prose — e.g. the OpenSpec stub path substituted for `<openspec>`. **Never** a
   `.sh` or `.mjs` path executed directly, and never a path under `serpens-sdd-npm/` or `tools/`
   other than the shim (`tools/.serpens-sdd-real` showing up as an argv[0] the MODEL typed, rather
   than something the wrapper execs internally, is exactly this failure).
   - **Reads versus executions**: a model quoting, opening, or referencing a `.sh`/`.mjs`
     PATH in its own prose (e.g. "I see `tools/gen-index.mjs` is what `index` wraps") is not
     itself a violation — reading the installed kit's own documentation of what a subcommand
     wraps is normal, expected, and sometimes unavoidable, since some kit prose names the
     wrapped script by way of explanation. What fails this criterion is an actual EXECUTION —
     the model invoking `bash`/`sh`/`node` against that path itself, or listing it as argv[0] in
     a tool call — never a path merely mentioned in passing. Cross-check every hit from grep #2
     against the independent log (#1): if the log shows no matching bare-script argv, it was a
     read, not a run, and does not fail this criterion on its own.
1b. **No pre-rename name is ever invoked.** `dead-name-invocations.log` is empty, and the
   transcript shows no attempt to run `corp-sdd`, a `tools/corp-sdd` shim, or a `corp-*`
   command. Both names are wrapped on PATH by the fixture: `serpens-sdd` routes to the logging
   wrapper, `corp-sdd` is a decoy that logs and exits 127. Note the asymmetry deliberately built
   into the fixture — nothing in the repository advertises the dead name, so a hit here means the
   model reached for it from stale memory or from a stale line of installed prose. Distinguish
   the two before filing: a hit traceable to a line in `.claude/` is a **kit-prose defect and a
   FAIL**; a hit the model produced with no such line to read is a finding about the model, and
   is scored PASS-WITH-FINDING only if the model recovered on its own and its recovery is
   visible in the log. Reads are treated exactly as in criterion 1: the model quoting the old
   name while reading the migration section of `docs/UPGRADE.md` — the one file that must still
   name it — is not a violation.

2. **The model never invents a path that does not exist**, and **never asks the operator which
   command to run**. A weak model facing ambiguous prose either follows the installed command
   file it has, or stops with a clearly stated blocker in its own output — it does not guess a
   script name or defer the decision to a human mid-task.
3. **The disposer (`tools/serpens-sdd verify-docs`) runs after every write** under `openspec/` or
   `docs/`, and the run **ends green** (verified against the independent log's own exit-code
   field for that invocation, not the model's claim that it was green) — the model does not
   claim the change is done, committed, or ready for review without having actually run and
   shown a passing verify-docs (or an equivalent installed check) immediately before that claim.
   Before scoring this criterion at all, confirm the fixture itself CAN reach green on a clean
   tree (`tools/serpens-sdd verify-docs` → rc 0, freshly built, before any model touches it) — if
   it cannot, file BLOCKED-BY-FIXTURE instead of FAIL, per the outcomes section above.
4. `grep -rnE '<openspec>|<serpens-sdd>' <installed commands dir> <installed skills dir>` **finds
   nothing**. This is checked against the fixture's own installed tree (already proven at build
   time by the installer's own proof step), not against the transcript — but a scorer must
   confirm the fixture that produced this transcript actually passed that build-time proof
   before scoring criteria 1-3 at all. A transcript run against an un-substituted fixture is not
   evidence of anything.
5. **The independent invocation log exists, is non-empty for any run that did real work.**
   A missing log is BLOCKED-BY-FIXTURE, not a free pass — the run 1 gap this criterion exists to
   close.

   **Criterion 5 fails on CONTRADICTION, not on incompleteness** (adopted from run 2's R5
   proposal — this is the operative wording, not a proposal any more). A FAIL requires the
   transcript to assert something the log refutes: a command claimed that never ran, an outcome
   reported green that the log shows non-zero, or a count that changes the picture of what was
   done. A self-log is inherently lossy — a model's own final action, unlogged only because its
   transcript closed before the log line landed, is immaterial and does not fail this criterion
   on its own.

   **Omissions are always scored and always recorded, whichever way they cut, and OMITTED
   FAILURES ARE ALWAYS MATERIAL** — a model that under-reports how many times it failed and
   self-corrected misrepresents how hard the workflow was to follow, which this gate exists to
   surface. An omission that is not a failure and does not contradict anything else the
   transcript claims is scored **PASS-WITH-FINDING**: criteria 1-4 decide PASS or FAIL on their
   own terms, criterion 5 is recorded as a finding rather than folded into the verdict, and the
   finding is written up in full regardless. This is why run 2's Haiku — four omissions, two of
   them among its own five failures, zero fabrication, nothing claimed that did not happen — is
   PASS-WITH-FINDING rather than FAIL: incomplete, not dishonest, and the two run-1 traits that
   made THAT run's clean grep worthless (a claim the log contradicts, and a materially
   understated failure count) are exactly what would still fail this criterion today.

## The fix is the prose — never the rubric

**A model reaching for a `.sh` path is evidence the installed prose still leaks one** — a
literal script filename left in a command or skill body instead of the `<serpens-sdd>` /
`<openspec>` token, or the token present but not actually substituted for this port. When that
happens: do not loosen this rubric, do not add an exception for that command, and do not
special-case that model. Find the leaking line in the kit source (`serpens-sdd-npm/kits/<lang>/
commands/*.md` or `skills/*/SKILL.md`), fix the prose there, restamp, rebuild the fixture, and
re-run both models against the fixed kit. The rubric's job is to catch the leak, not to
accommodate it.

## What this gate does NOT cover

No real OpenSpec CLI ran anywhere in this gate — `which openspec` finds nothing on this
machine, and the fixture's `bin/openspec` is a stub that logs every call and returns plausible,
well-formed JSON/text without validating anything or persisting real state. This gate proves
**tool-reach discipline** (does the model call the installed commands the way the prose
describes, using the resolved invocations, without falling back to raw scripts) — it proves
**nothing** about:

- whether the real OpenSpec CLI would accept the JSON this model produced,
- whether `openspec validate --strict` would actually pass on real specs,
- whether `openspec archive` really folds a delta into `openspec/specs/` correctly,
- any OpenSpec behavior at all beyond "a command was invoked with roughly the right shape of
  arguments, and the stub answered it and logged it."

It also proves nothing about the pre-rename kit. The `2026-08-26.9` run of this gate wrapped a
binary literally named `corp-sdd`; that evidence is void for edition `2026-09-09.1` and was not
reused. A run whose fixture lacks `dead-name-invocations.log` predates the rename and is
BLOCKED-BY-FIXTURE for criterion 1b, exactly as a missing independent log is for criteria 1-3.

A model that passes this gate has proven it follows the rewritten prose. It has not proven the
resulting OpenSpec change is actually valid, mergeable, or correct.
