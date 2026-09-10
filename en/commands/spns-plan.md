---
description: Generate design + tasks for an approved change, against TODAY's code (dev flow)
serpens-version: 2026-09-10.1
---
Plan change {{args}}. Follow skills spns-drill-down (all system facts) and spns-verification.
`{{args}}` is the `<change-id>`; `<openspec>` is the OpenSpec CLI invocation setup resolved.
Precondition: proposal + delta spec exist and are approved — if not, STOP
and say which is missing.
0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Run
   `<serpens-sdd> state assert-change <TICKET> --checkout`; stop on failure.
   `--checkout` switches to the story branch when you are elsewhere and it already exists, locally or
   on origin. It never creates one: "does not exist locally or on origin" means run `spns-spec` first.
   Then ask the CLI for ONE artifact at a time. The artifact ids are fixed by the schema, and
   `<openspec> status --change <change-id> --json` lists them with their paths and state; for
   `spec-driven` they are `proposal`, `specs`, `design`, `tasks`. `spns-spec` created the first two;
   you create only these:
   ```bash
   <openspec> instructions design --change <change-id> --json
   <openspec> instructions tasks  --change <change-id> --json
   ```
   Each call returns the guidance and the exact output path for that artifact; write it, then run the
   next. Write no other artifact and do not continue into implementation.
1. Read the delta spec, research.md, and the living specs it modifies. Read the CURRENT code of
   the affected modules (use spns-drill-down; append new verified facts to research.md).
2. Write design.md: approach, files/classes to touch, integration points, risky areas flagged
   with why, and — one line per acceptance scenario — which observable surface implements it
   (endpoint, topic, table). That line is what `spns-test-plan` follows from spec to stand.
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
   `docs(<TICKET>): <text>` (`<serpens-sdd> git-naming` enforces the type), push to
   `origin/feature/<TICKET>`, and paste `git log --oneline -1` plus
   `git status --short` as evidence.
6. Present the plan to the developer for approval. Do not start implementing.
