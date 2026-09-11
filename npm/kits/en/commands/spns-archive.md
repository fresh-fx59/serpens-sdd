---
description: Post-merge close-out — fold the delta into living specs, ADR, index (dev flow)
serpens-version: 2026-09-11.1
---
Archive change {{args}}. Follow skill spns-verification (evidence for every step below).
`{{args}}` is `<change-id> [--here | --branch <name>]`. The flag chooses WHERE the archive
commit lands; the rest is the `<change-id>` passed to the archiver. `<openspec>` is the OpenSpec CLI
invocation setup resolved.
0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`.
   Precondition, in every mode: the change's PR is merged. Verify it; if it is not, ask the
   user ONCE — continue here or stop — and follow the answer. Never stop silently.
   Then place yourself. With no flag, ask the user ONCE which of the three, print the
   current branch in the question, and wait for the answer — never pick for them:
   - (1) a fresh `feature/<TICKET>` from the base: run
     `<serpens-sdd> state prepare-base`, then
     `git checkout -b feature/<TICKET>` — recreating the story branch, which the merge usually
     deleted. Step 5 publishes it and opens a PR. The name carries no suffix: `<serpens-sdd> git-naming`
     accepts `feature/ABCD-1234` and nothing else, so a suffixed name fails the pre-push guard and
     the push is rejected.
   - (2) a branch you name: the same, using that name — it must still match `feature/ABCD-1234`.
   - (3) here: stay on the current branch and do NOT run `prepare-base`.
   A flag answers the question in advance and skips it: `--branch <name>` is (2), `--here` is (3).
   Then, in every mode, run `<serpens-sdd> state assert-archivable`;
   stop on any failure. It proves the tree is clean, there are no stashes, and HEAD already
   contains the configured base — so the delta cannot fold into stale specs. Do not assume the
   base is named `main`, `master` or `develop`; the tool resolves it.
   If the change's status shows every artifact `done` OR `skipped` and every task complete, skip
   the per-artifact and per-task confirmations — `skipped` (for example `specs`, under a change
   whose `.openspec.yaml` sets `skip_specs: true`) counts as satisfied there too, and creating a
   skipped artifact is forbidden; the status check already answered them.
1. Run `<serpens-sdd> verify-docs`, then
   `<openspec> validate <change-id> --type change --strict --json`; fix until verify-docs is green
   and the CLI reports `"valid": true`. The CLI is the authority on delta-spec grammar — the lint
   no longer re-checks it. A heading that is not `### Requirement: <text>` verbatim is exactly what
   `<openspec> archive` rejects, and it fails mid-archive, where recovery is manual.
   Only if the delta is semantically valid and the archiver still refuses, ask the user once
   before using its `--no-validate` escalation. Then run `<openspec> archive <change-id> --yes --json`
   — the change id only, never the placement flag. The delta folds into `openspec/specs/`. A
   change whose `.openspec.yaml` sets `skip_specs: true` has no delta to fold — never demand one
   — and the CLI reports `"specsUpdated": false`; that is the expected, successful outcome for
   that change, not a failure.
2. Draft an ADR from the change's decisions (proposal "why" + research.md discoveries + any
   spec amendments) using `templates/adr.md`; write to openspec/adr/NNNN-<slug>.md
   (next free number). ADRs are append-only: never edit an accepted ADR — supersede it.
3. Write the index: `<serpens-sdd> index`. This step is not optional —
   verify-docs only runs `<serpens-sdd> index --check`, which reports drift and writes nothing.
4. Run `<serpens-sdd> verify-docs`; it must be green.
5. COMMIT IT YOURSELF — the operator never runs git for you, and a step that ends with
   uncommitted work is not finished. Stage exactly the files this step produced, BY PATH,
   NAMING THE INDEX FILES EXPLICITLY — `git add openspec/specs/<capability>/... openspec/adr/NNNN-<slug>.md
   openspec/index.json openspec/index.md openspec/repo.txt` (only `repo.txt` if step 3 created it
   for the first time) — never `git add -A` or `git add .`. verify-docs' index check now refuses
   an untracked or unstaged index (`checkIndexInGit`): a missed `git add` is caught, not silent —
   but only for the exact paths staged here, so name them explicitly rather than trusting a
   broader `git add` to catch it for you. Commit as
   `docs(<TICKET>): archive {{args}} living spec and ADR`, then push the branch you are on.
   Default and `--branch` mode: open a PR into the configured base. `--here` mode: the commit
   rides the branch's existing PR. The store catalog picks this up on its next aggregation — no
   manual store edits, ever.
6. Post a one-line completion note through the configured tracker integration. If none exists,
   print the exact note for a human to paste.
