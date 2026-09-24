---
description: Post-merge close-out — fold the delta into living specs, ADR, index (dev flow)
serpens-version: 2026-09-23.1
---
Archive change {{args}}. Follow skill spns-verification (evidence for every step below).
`{{args}}` is `<change-id> [--here | --branch <name>]`. The flag chooses WHERE the archive
commit lands; the rest is the `<change-id>` passed to the archiver. `<openspec>` is the OpenSpec CLI
invocation setup resolved.
0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Run `<serpens-sdd> delivery --print-contract`
   to read this estate's `pr-opened-by`. Then check `$REPO_ROOT/.serpens.yaml` for an
   `archive-when-confirmed:` line; if there is none, ask the user ONCE which this estate uses —
   `after-merge` (archive as soon as the feature branch merges to the integration branch) or
   `after-qa-accepted` (wait for the tester's sign-off on the dev stand first) — then run
   `<serpens-sdd> delivery --confirm-archive-when <value>` to record the answer; never ask again
   for this estate. `archive-when` gates WHEN you run this command at all, not what it checks
   below.
   Precondition, every mode: a human has opened and merged the change request (`forge-word`,
   from the same contract). Verify it with `<serpens-sdd> state assert-archivable --change
   <change-id>` — never by reading the forge UI, the tracker, or a change-request link; "merged"
   is judged ONLY by this command's exit code. Always pass `--change <change-id>` (the same
   `<change-id>` from `{{args}}`): the hand-off tip this checks is recorded per CHANGE, never per
   branch — the story branch that had the hand-off is usually deleted by the time you archive,
   and you may be standing on any branch right now (often the integration branch itself). Run it
   ONCE, right here, on whatever branch you are on now — BEFORE you create or switch to any other
   branch. With `merge-style` configured it proves the recorded hand-off tip reached
   `origin/<integration-branch>` (merge/rebase/squash-keyed); otherwise it proves the tree is
   clean, there are no stashes, and HEAD already contains the configured base. Do not assume the
   base is named `main`, `master` or `develop`; the tool resolves it.
   - `pr-opened-by=human` (default): non-zero exit = not merged. STOP and tell the human exactly
     which branch still needs merging — paste `<serpens-sdd> delivery --handoff --change
     <change-id>`'s output verbatim. Do NOT open or merge it yourself.
   - `pr-opened-by=agent`: non-zero exit = not merged. Ask the user ONCE — continue or stop — and
     follow the answer. Never stop silently.
   A refusal here is ALWAYS a correct refusal — the change genuinely is not (yet) verifiably
   merged, or a real `Serpens-Handoff-Tip` record is missing or does not check out. NEVER write or
   edit `.serpens.yaml` by hand to make this pass, never fabricate a `handoff-tip:` line, and
   never hand-craft a `chore(<TICKET>): record handoff <sha>` commit yourself — that record is
   `delivery --handoff`'s output alone, stamped with a trailer only the tool can produce, and a
   hand-written one is now detected and rejected. If the refusal seems wrong, STOP and say so to
   the human with the tool's exact message; do not route around it.
   Then place yourself for the close-out commit. With no flag, ask the user ONCE which of the
   three, print the current branch in the question, and wait for the answer — never pick for
   them. The one exception: run `<serpens-sdd> mode`; only if it prints `unattended`, do not ask —
   take (1), say so in one line, and go on. Never decide that mode yourself.
   - (1) a fresh story branch from the base (the close-out mechanism, no extra questions beyond
     this one regardless of `archive-when` or `merge-style`): run
     `<serpens-sdd> state prepare-base` — the SAME base-branching mechanism every other command
     uses, resolved from this estate's `integration-branch` — ask
     `<serpens-sdd> git-naming --print-contract <TICKET>` for the name (`branch-example`), then
     `git checkout -b "$BRANCH"` — recreating the story branch, which the merge usually
     deleted. Step 5 pushes it and hands off per `pr-opened-by`. Use the printed name verbatim: the
     shape is the shop's, it lives in `serpens/branching.md`, and `<serpens-sdd> git-naming` accepts
     that and nothing else, so a name you assembled yourself — or one with a description suffix —
     fails the pre-push guard and the push is rejected.
   - (2) a branch you name: the same, using that name — it must still match what
     `--print-contract` reports.
   - (3) here: stay on the current branch and do NOT run `prepare-base`.
   A flag answers the question in advance and skips it: `--branch <name>` is (2), `--here` is (3).
   Do NOT run `state assert-archivable` again after this point. The proof above stands for the
   rest of this command, because it is keyed by `<change-id>`, not by branch — re-running it here
   would check the SAME already-proven change again, which is redundant at best; never run
   `delivery --handoff --change <change-id>` again for THIS change just to "re-arm" it, and never
   commit or push just to turn a check green.
   If the change's status shows every artifact `done` OR `skipped` and every task complete, skip
   the per-artifact and per-task confirmations — `skipped` (for example `specs`, under a change
   whose `.openspec.yaml` sets `skip_specs: true`) counts as satisfied there too, and creating a
   skipped artifact is forbidden; the status check already answered them.
0. SCHEMA GATE, first, always. Run `<serpens-sdd> check-schema`. If it exits non-zero, STOP — do not read further, do not create anything — and report its output verbatim to the analyst; it names the unsupported schema, exactly where it was found, and that support is a deferred follow-up (see spec-skipspecs-and-custom-schemas-2026-09-11.md item 4b).

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
   spec amendments) using `serpens/templates/adr.md`; write to serpens/adr/NNNN-<slug>.md
   (next free number). ADRs are append-only: never edit an accepted ADR — supersede it.
3. Write the index: `<serpens-sdd> index`. This step is not optional —
   verify-docs only runs `<serpens-sdd> index --check`, which reports drift and writes nothing.
4. Run `<serpens-sdd> verify-docs`; it must be green.
5. COMMIT IT YOURSELF — the operator never runs git for you, and a step that ends with
   uncommitted work is not finished. Stage exactly the files this step produced, BY PATH,
   NAMING THE INDEX FILES EXPLICITLY — `git add openspec/specs/<capability>/... serpens/adr/NNNN-<slug>.md
   serpens/index.json serpens/index.md serpens/repo.txt` (only `repo.txt` if step 3 created it
   for the first time) — never `git add -A` or `git add .`. verify-docs' index check now refuses
   an untracked or unstaged index (`checkIndexInGit`): a missed `git add` is caught, not silent —
   but only for the exact paths staged here, so name them explicitly rather than trusting a
   broader `git add` to catch it for you. Commit as
   `docs(<TICKET>): archive {{args}} living spec and ADR`, then push the branch you are on.
   `--here` mode: the commit rides the branch's existing change request. Default and `--branch`
   mode: push, then, if `pr-opened-by=human`: run `<serpens-sdd> delivery --handoff` and paste
   its output to the human verbatim; do NOT create the change request. `delivery --handoff`
   records this push's tip and commits + pushes that record ITSELF, as its own
   `chore(<TICKET>): record handoff <sha>` commit — never leave the tree dirty by editing
   `.serpens.yaml` yourself, and never re-run any check to make that commit "count". If
   `pr-opened-by=agent`: open it. The store catalog picks this up on its next aggregation — no
   manual store edits, ever.
6. Post a one-line completion note through the configured tracker integration. If none exists,
   print the exact note for a human to paste.
