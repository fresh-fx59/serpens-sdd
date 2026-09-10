---
name: spns-verification
description: Verification before completion — no done-claims without fresh evidence. Use before reporting ANY work finished.
serpens-version: 2026-09-10.1
---
## The rule
Every claim of completion, for every kind of work, carries EVIDENCE produced AFTER the last edit:
- code → the actual test-run output (fast + slow tier as applicable)
- docs/specs → the `<serpens-sdd> verify-docs` green output
- config/infra → the command that proves the new state (service status, curl, pipeline run)
"Should work", "looks right", "the change is straightforward" are not evidence. If you cannot
produce evidence, the honest report is "implemented but unverified because <reason>" — never "done".

## Before you say done — the gate
1. Re-read the task/spec requirement you claim to satisfy. Does the evidence actually cover it,
   or something adjacent?
2. Did anything change after your last verification run? If yes, re-run. Evidence expires on edit.
3. Are all tasks.md boxes you ticked backed by evidence lines? Header updated?
4. `REPO_ROOT="$(git rev-parse --show-toplevel)"`; then run
   `<serpens-sdd> verify-docs` — green?

## Failure honesty
If tests fail: report the failure with output — never bury it, never "mostly passing".
If you weakened anything to get green: that is a red flag, undo it and report the conflict.
CIRCUIT BREAKER: the same error surviving 3 fix attempts → STOP, write up observations, ask a human.
