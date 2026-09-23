---
name: spns-tdd
description: Tiered test-driven development against the repository's own testing stack. Use for implementation work on a Serpens change (spns-* commands or a change with `.serpens.yaml`).
serpens-version: 2026-09-21.1
---
## Iron law
No production code without a failing test first. No exceptions for "trivial" changes — trivial
changes with tests stay trivial; trivial changes without tests become incidents.

## The two tiers
FAST tier — the inner loop, run after EVERY green step, must stay in seconds.
SLOW tier — run at TASK boundaries and before the PR, never inside the micro-loop.

Which test is which, and the command that runs each tier, are facts about THIS repository, not
about this skill. Read `serpens/testing-stack.md` in the repository and follow it. If that file does
not exist, or the facts you need from it are incomplete, stop and ask the team once, then write
it from `templates/testing-stack.md` — never guess a framework or invent a harness class. A file
that exists but answers nothing is the same problem as no file at all; `<serpens-sdd>
verify-docs` names every slot still open.

Two rules hold in every stack:
- A slow-tier suite whose shared context is busted per class turns 2 minutes into 15 and kills
  this discipline. Share the setup; do not scatter per-class overrides.
- Wiring, serialization and configuration bugs surface ONLY in the slow tier. A task touching one
  of those boundaries is not done on fast-tier green alone.

## The cycle (per task in tasks.md)
1. RED: write the test from the task's scenario. Run it. SEE it fail with the expected failure —
   a test that passes immediately tests nothing; stop and fix the test.
2. GREEN: minimal code to pass. Resist adding unrequested behavior.
3. Run the fast tier. Refactor only on green. Re-run.
4. At task end: slow tier for touched areas. Paste the run output into tasks.md as evidence,
   tick the box, overwrite the state header.

## Forbidden moves
Weakening an assertion to pass · deleting/skipping a failing test · asserting implementation
details (private methods, call counts) instead of behavior · marking a task done without pasted
test output · writing tests after the code "to save time" (that is not TDD, that is decoration).
