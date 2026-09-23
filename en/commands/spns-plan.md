---
description: Generate design + tasks for an approved change, against TODAY's code (dev flow)
serpens-version: 2026-09-23.1
---
Plan change {{args}}. Follow skills spns-drill-down (all system facts) and spns-verification.
`{{args}}` is the `<change-id>`; `<openspec>` is the OpenSpec CLI invocation setup resolved.
Preconditions — TWO independent conditions, both required. Neither substitutes for the other.
(a) ARTIFACTS READY. `<openspec> status --change <change-id> --json` must report `design` as
`ready` (or already `done`) — never `blocked`. An artifact behind it reported `skipped` (for
example `specs`, under a change whose `.openspec.yaml` sets `skip_specs: true`) counts as
satisfied, never missing — creating a `skipped` artifact is forbidden, upstream refuses it. If
`design` is `blocked`, STOP and name the artifact its `missingDeps` names, and that artifact's
own reported state.
(b) PROPOSAL APPROVED. The proposal for this change must be APPROVED by the analyst. Artifact
status is readiness — whether dependencies are met — and never records a human's approval; the
CLI cannot tell you this, so check the story. If the proposal is not approved, STOP and say so.
0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Run
   `<serpens-sdd> state assert-change <TICKET> --checkout`; stop on failure.
   `--checkout` switches to the story branch when you are elsewhere and it already exists, locally or
   on origin. It never creates one: "does not exist locally or on origin" means run `spns-spec` first.
   Then ask the CLI for ONE artifact at a time. `<openspec> status --change <change-id> --json` is
   the authority on which artifacts this schema needs and their state — never assume the id list
   is fixed; this command owns exactly `design` and `tasks`, the two `spns-spec` does not create.
   An artifact whose reported status is `skipped` needs no file — creating one is forbidden
   (upstream refuses a `skip_specs` change that carries spec files) — so read status before
   assuming anything is missing:
   ```bash
   <openspec> instructions design --change <change-id> --json
   <openspec> instructions tasks  --change <change-id> --json
   ```
   Each call returns the guidance and the exact output path for that artifact; write it, then run the
   next. Write no other artifact and do not continue into implementation.
0. SCHEMA GATE, first, always. Run `<serpens-sdd> check-schema`. If it exits non-zero, STOP — do not read further, do not create anything — and report its output verbatim to the analyst; it names the unsupported schema, exactly where it was found, and that support is a deferred follow-up (see spec-skipspecs-and-custom-schemas-2026-09-11.md item 4b).

1. Read the delta spec (a `skip_specs` change has none — skip this source, never create it),
   research.md, and the living specs it modifies. Read the CURRENT code of
   the affected modules (use spns-drill-down; append new verified facts to research.md).
2. Write design.md: approach, files/classes to touch, integration points, risky areas flagged
   with why, and — one line per acceptance scenario — which observable surface implements it
   (the surfaces and stores `serpens/testing-stack.md` names). That line is what `spns-test-plan`
   follows from spec to stand.
    Keep it under 200 lines — it is disposable; depth lives in the code and spec.
3. Write tasks.md: state header line first ("As of YYYY-MM-DD — stage 1 (planned), next: task 1"),
   then checkboxed tasks. Each task = one red-green cycle a reviewer could verify alone: names the
   scenario it implements, the test to write, the code area. Order: risky/unknown tasks FIRST.
4. Run `<serpens-sdd> verify-docs`; it must be green before handover.
5. COMMIT design.md and tasks.md.
   COMMIT IT YOURSELF — the operator never runs git for you, and a step that ends with
   uncommitted work is not finished. Stage exactly the files you wrote, BY PATH
   (`git add <path> …`). Never `git add -A`, `git add .` or `git commit -a`: the repository
   legitimately holds local-only settings, credential and scratch files that must never be
   committed, and an untracked file you did not create is not yours to stage. A file you created
   is untracked until you add it — adding it is part of writing it. Commit with
   `docs(<TICKET>): <text>` (`<serpens-sdd> git-naming` enforces the type and the form —
   `--print-contract` prints both), push to the story branch, and paste `git log --oneline -1` plus
   `git status --short` as evidence.
6. Present the plan to the developer for approval. Do not start implementing.
