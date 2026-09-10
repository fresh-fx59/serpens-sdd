---
description: Structured pre-review of a diff before humans spend time (any role)
serpens-version: 2026-09-10.1
---
Review the diff of {{args}} (branch/PR/change). Follow skill spns-code-review throughout.
`<change-id>` is the OpenSpec change under review; `<openspec>` is the OpenSpec CLI invocation setup
resolved.
Review in this order, report findings by severity
(blocker / serious / minor), each with file:line and a concrete fix:
0. REPOSITORY STATE: set `REPO_ROOT="$(git rev-parse --show-toplevel)"` and run
   `<serpens-sdd> state inspect`. For a checked-out local story branch,
   also run `<serpens-sdd> state assert-change <TICKET> --allow-dirty`.
1. COVERAGE, from the machine first: run `<openspec> validate <change-id> --type change --strict --json`
   and `<openspec> status --change <change-id> --json` (add `--store <store-id>` when the change
   lives in the store). Read both and carry them into your findings: a validation ERROR or an
   incomplete task is a blocker; a WARNING is at least a serious finding. They check that the
   artifacts and tasks are complete — never that a test ran — so the pasted test-run evidence
   from spns-implement is still required. If this is not an OpenSpec change, say so in one line
   and start at 2.
2. SPEC CONFORMANCE: does the diff implement exactly the delta spec — nothing missing, nothing
   beyond scope? Unrequested changes are findings, however good they look.
3. ACCEPTANCE: every ADDED/MODIFIED requirement's scenarios name what a tester sends and observes
   from outside. If the built system contradicts one, the diff must carry the spec amendment that
   fixes it — an expectation quietly corrected in a tracker comment instead is a serious finding.
4. TEST HONESTY: does each new test assert SCENARIO behavior (would it fail if the feature broke)?
   Flag tests that assert implementation details, tests weakened to pass, and scenarios with no test.
5. CORRECTNESS: bugs, edge cases from the scenarios, error handling, concurrency on shared state.
6. DISPOSER: run `<serpens-sdd> verify-docs`; any red is a blocker finding.
Do NOT approve or merge anything — output findings only; humans decide. If the diff is clean,
say so in one line; do not invent findings to look thorough.
