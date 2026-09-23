---
description: Implement the current change task-by-task under TDD discipline (dev flow)
serpens-version: 2026-09-23.1
---
Implement change {{args}}.
`{{args}}` is the `<change-id>`; `<openspec>` is the OpenSpec CLI invocation setup resolved.
Discipline: follow skills spns-tdd (all coding), spns-verification (all done-claims),
spns-debugging (any unexpected failure), spns-drill-down (any fact about the system).
0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Run
   `<serpens-sdd> state assert-change <TICKET> --checkout --allow-dirty`.
   It switches to the story branch if you are elsewhere and it exists; it never creates one.
   Stop on the wrong branch, missing upstream, or divergence. Then run
   `<openspec> instructions apply --change <change-id> --json` to read the machine's task state —
   `state`, `progress`, `tasks`, `contextFiles`. An artifact reported `skipped` (for example
   `specs`, under a change whose `.openspec.yaml` sets `skip_specs: true`) already counts as
   satisfied there — never create it. A `blocked` state means something ELSE is genuinely missing:
   stop and run `spns-plan`. Use it for state only; the Serpens TDD cycle below is the
   implementation authority, and no OpenSpec guidance overrides it.
0. SCHEMA GATE, first, always. Run `<serpens-sdd> check-schema`. If it exits non-zero, STOP — do not read further, do not create anything — and report its output verbatim to the analyst; it names the unsupported schema, exactly where it was found, and that support is a deferred follow-up (see spec-skipspecs-and-custom-schemas-2026-09-11.md item 4b).

1. Read tasks.md state header + research.md FIRST — resume, never re-derive.
2. If design.md/tasks.md are missing or stale (index digest changed): regenerate them
   now against current code (plans are disposable, specs are durable).
3. Per task: write the failing test from the spec scenario (fast unit tier; slow
   integration tier only at task boundaries) → implement → run → record evidence in
   tasks.md → tick the checkbox → overwrite the state header. Do NOT commit per task.
4. On spec/code mismatch STOP and classify: (a) spec incomplete, or an acceptance scenario no longer
   observable as written — when a delta spec exists, draft an amendment to it on this branch, run
   `<openspec> validate <change-id> --type change --strict --json` on the amended delta and fix
   until `"valid": true`, notify analyst via tracker, wait; when the change declares
   `skip_specs: true` there IS no delta to amend, and creating one is forbidden — notify the
   analyst via tracker instead and wait, same as above; (b) code surprising but
   spec right → regenerate tasks, note in research.md; (c) unimplementable → halt, escalate.
5. After every file write under openspec/ or docs/, run
   `<serpens-sdd> verify-docs`.
6. COMMIT THE WHOLE CHANGE, once, when every box is ticked — not per task. The operator never
   runs git for you, and an implementation that ends with uncommitted work is not finished.
   Stage exactly the files this change produced, BY PATH (`git add <path> …`). Never
   `git add -A`, `git add .` or `git commit -a`: the repository legitimately holds local-only
   settings, credential and scratch files that must never be committed, and an untracked file you
   did not create is not yours to stage. A file you created is untracked until you add it —
   adding it is part of writing it. The commit subject form and the allowed types are the shop's,
   not yours: `<serpens-sdd> git-naming --print-contract <TICKET>` prints `commit-form`,
   `commit-types` and a ready `commit-example`. Write the subject in that form (`feat` for a
   feature, `fix` for a defect), push to the story branch. Then, per `<serpens-sdd>
   delivery --print-contract`: if `pr-opened-by=human`, run `<serpens-sdd> delivery --handoff`
   and paste its output to the human verbatim — do NOT create the change request. If `agent`,
   open or update it. Paste `git log --oneline -1` plus `git status --short` as evidence.
7. Done = all boxes ticked + full test suite green + verify-docs green + the work committed and
   pushed. Never claim
   done without pasted evidence of the last test run.
