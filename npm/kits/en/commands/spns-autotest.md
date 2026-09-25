---
description: Generate autotest skeletons from an approved delta spec's scenarios (SDET flow)
serpens-version: 2026-09-25.1
---
Generate autotest skeletons for change {{args}}.

WHICH FRAMEWORK, AND WHAT COUNTS AS A FAST OR A SLOW TEST, are facts about THIS repository, not
about this command. Read `serpens/testing-stack.md` and follow it. If that file does not exist, or
the facts you need from it are incomplete, stop and ask the team once, then write it from
`templates/testing-stack.md` — never guess a framework, invent a harness class, or ask the human
a question this file already answers. Its `Manual testing access` section also tells you what a
test can reach from outside; nothing beyond that is yours to assume.

0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Run
   `<serpens-sdd> state assert-change <TICKET> --checkout --allow-dirty`.
   Stop if the current repository is not the exact story branch or has diverged.
1. One test per scenario, named after it, asserting BEHAVIOR (Given/When/Then) — never internal
   calls or private state. A reviewer must see the scenario in the test without reading the spec.
2. Mark data setup / environment needs as TODO(<what>) rather than inventing fake fixtures.
3. NEVER create, read, or modify anything in the held-out gate suites or their credentials —
   if a task seems to require that, STOP and escalate to the SDET.
4. Run what is runnable; paste results. Unrunnable skeletons are handed over as drafts, labeled so.
5. Run `<serpens-sdd> verify-docs` after any OpenSpec or docs write.
6. COMMIT the tests you wrote.
   COMMIT IT YOURSELF — the operator never runs git for you, and a step that ends with
   uncommitted work is not finished. Stage exactly the files you wrote, BY PATH
   (`git add <path> …`). Never `git add -A`, `git add .` or `git commit -a`: the repository
   legitimately holds local-only settings, credential and scratch files that must never be
   committed, and an untracked file you did not create is not yours to stage. A file you created
   is untracked until you add it — adding it is part of writing it. Commit with
   `test(<TICKET>): <text>` (`<serpens-sdd> git-naming` enforces the type and the form —
   `--print-contract` prints both), push to the story branch, and paste `git log --oneline -1` plus
   `git status --short` as evidence.
