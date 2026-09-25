---
description: Draft the delta spec(s) for a story via interview; fan out across repos when needed (analyst flow)
serpens-version: 2026-09-25.1
---
You are drafting the spec for story {{args}}.
`<change-id>` is the OpenSpec change folder name; `<openspec>` is the OpenSpec CLI invocation setup
resolved.
Follow skills spns-drill-down (all system facts) and spns-verification (all done-claims).
ONE repository (the usual case): steps 0-3 are the whole command — stop reading at the
`## CROSS-REPO` line. Read each part of this file once; do not re-read what you already have.

0. SCHEMA GATE, first, always. Run `<serpens-sdd> check-schema`. If it exits non-zero, STOP — do not read further, do not create anything — and report its output verbatim to the analyst; it names the unsupported schema, exactly where it was found, and that support is a deferred follow-up (see spec-skipspecs-and-custom-schemas-2026-09-11.md item 4b).

1. READ + INTERVIEW, once. Fetch the story, wiki pages, and attachments through the configured
   tracker/wiki integration. If it is unavailable, use the user-provided export and mark missing
   evidence; never invent it. In every selected repository, set
   `REPO_ROOT="$(git rev-parse --show-toplevel)"` and run
   `<serpens-sdd> state inspect` before trusting local code. Read
   serpens/index.md and ONLY the living specs the story touches; follow
   spns-drill-down (central catalog → repo index → live files; repo wins; ≤3 hops). Verify every
   contract fact against live code. Interview the analyst — ONE question at a time,
   multiple-choice preferred — until requirements and Given/When/Then scenarios are unambiguous.
   Answer from the story, the repository and live code first; ask only what none of them answers.
   Then run `<serpens-sdd> mode`. Never decide this yourself — only its output counts.
   - It prints `attended` (the default): interview the analyst as above and WAIT for each answer.
   - Only if it prints `unattended`: do not stop to ask. Pick the most conservative answer the
     story supports, write each one into the proposal as `Assumption: <question> -> <answer
     chosen>`, and go on to step 2. In that mode an open question never ends the run; only a
     gate below that tells you to STOP does.
   Every scenario must name what a tester SENDS and what they OBSERVE from outside the running system
   — a request, an event, a row, a status code. A requirement checkable only from inside is either
   reworded into an observable one now, while it is a sentence, or handed to `spns-autotest` and said
   so out loud. This is the cheapest moment in the whole flow to find it.
   Interview ONCE at story level even if several repos are involved: the requirements are shared,
   so interviewing per repo asks the same questions N times and invites N different answers.

2. DECIDE THE SHAPE, then CONFIRM before creating anything.
   Count the repos the story touches.
   - ONE repo → single-repo path. Go to step 3.
   - MORE THAN ONE repo → is there a genuine shared contract (a shape or protocol crossing the
     boundary)? If NOT, say "not a cross-repo change; this is N independent stories" and stop —
     do not fan out. If YES, go to step 4.
   Before creating any ticket, branch, commit or change request, state the plan and WAIT for the
   analyst: which repos, which is the producer, which tickets already exist, which you would
   create, and how many change requests (`forge-word` from `<serpens-sdd> delivery
   --print-contract`) this will open. Never fan out silently. Only if `<serpens-sdd> mode`
   printed `unattended`: print the plan and continue on the single-repo path without waiting; a
   multi-repo fan-out still needs a human — report it as your blocker. Otherwise WAIT.

3. SINGLE REPO. Place yourself BEFORE creating anything.
   a. TICKET GATE. The branch name is built from a real tracker key. If `{{args}}` carries none
      and the story has none, there is nothing to name the branch after: ask the user ONCE —
      (1) create the ticket now through the tracker integration, (2) they give you the key,
      (3) draft the spec with NO branch and NO change folder, and say plainly it cannot be handed
      over until a ticket exists. NEVER invent a key, never use the story title, never name a
      branch after a placeholder such as `NO-TICKET`.
   b. THE BRANCH NAME IS NOT YOURS TO INVENT. Ask for it — the shape is the shop's, it lives in
      `serpens/branching.md`, and the pre-push hook enforces exactly what this prints:
      ```bash
      BRANCH=$(<serpens-sdd> git-naming --print-contract <TICKET> | awk -F'\t' '$1=="branch-example"{print $2}')
      ```
      Use `$BRANCH` verbatim everywhere below. Never assemble a branch name yourself, never assume any
      prefix, and never add a description suffix — a name you invented fails the
      pre-push guard and the push is rejected. A non-zero exit here means the shop's conventions
      file is broken: report it and stop, rather than falling back to a guess.
   c. WHERE YOU ARE. The branch may already exist, and you may already be on it. Look first:
      ```bash
      git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD
      git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH" && echo local
      git -C "$REPO_ROOT" ls-remote --heads origin "$BRANCH"
      ```
      - ALREADY ON `$BRANCH` → do NOT run `prepare-base`; it checks out the base and would
        take you off your work. Run `assert-change <TICKET> --allow-dirty` and continue here. If
        `openspec/changes/<change-id>/` already exists, RESUME it — never re-create it, never
        `<openspec> new change` a second time.
      - EXISTS LOCALLY, you are elsewhere → `git checkout "$BRANCH"`, then `assert-change
        <TICKET> --allow-dirty`, then resume as above.
      - EXISTS ON ORIGIN ONLY → `git fetch origin`, then
        `git checkout -b "$BRANCH" --track "origin/$BRANCH"`, then `assert-change`.
      - NOWHERE → run `<serpens-sdd> state prepare-base`; stop on failure.
        Create `$BRANCH` from the prepared configured base, publish its upstream with
        `git push -u origin "$BRANCH"`, then run
        `<serpens-sdd> state assert-change <TICKET>`.
      Ask the user ONE question, printing the state you found, whenever it is contradictory: local and
      remote have diverged, the local branch tracks something other than `origin/$BRANCH`, or
      the existing change folder belongs to a different ticket. Do not guess which one wins.
   c. Run `<openspec> new change <change-id>` — skip it when the change folder already exists.
      Then run `<serpens-sdd> state mark-change <change-id> --ticket <TICKET>` — idempotent, so a
      resumed change without a marker gets one. Then ask the CLI for ONE artifact at a time; `<openspec> status --change <change-id> --json`
      is the authority on which artifacts this schema needs and their state — never assume the id
      list is fixed. This command owns `proposal` and `specs`, the two `spns-plan` does not touch:
      ```bash
      <openspec> instructions proposal --change <change-id> --json
      ```
      Then check `specs`' reported state before touching it. `skipped` means this change's
      `.openspec.yaml` sets `skip_specs: true` — a legitimate "no spec-level behavior change";
      treat it as satisfied and do NOT create a delta spec (upstream's own validator rejects a
      `skip_specs` change that carries spec files). Any other state runs:
      ```bash
      <openspec> instructions specs --change <change-id> --json
      ```
      Each call returns the guidance and the exact output path for that artifact; write it, then run
      the next. Stop when `proposal.md` exists and `specs` is `done` or `skipped` — `design` and
      `tasks` belong to `spns-plan`, which asks for them the same way. Append verified facts to
      research.md as pointers (path#Lx-Ly + one-line finding).
      Split the tester's facts by who owns them. Facts this change DEFINES — a new surface, a new
      field, a new destination, the error contract — are normative: they belong in the delta spec, in
      the requirement text and its scenarios, where they are reviewed and archived. Facts the change
      only DISCOVERS about the system as it already is go to research.md under a heading
      `## OBSERVABLE CONTRACT`, as pointers.
      WHAT THAT BLOCK CONTAINS is a fact about THIS repository, not about this command. Read ONLY
      the `Manual testing access` section of `serpens/testing-stack.md` — exactly
      `sed -n '/^## Manual testing access/,$p' serpens/testing-stack.md` — and follow it: record one pointer per
      slot the repository actually answers — the parts `request-idiom` names for a direct call, what
      `event-addressing` and `event-payload-format` name for a message, the records and fields
      `data-stores` names, and where `error-routing` says a rejection lands. A slot answered `none`
      contributes nothing to this block; do not invent an entry for it, and never name a protocol,
      store or payload format that file did not name. If the file is missing or the facts you need
      from it are incomplete, stop and ask the team once, then write it from
      `templates/testing-stack.md`. One pointer per fact. `spns-test-plan` renders the tester's
      payloads from the spec's scenarios and this block, so a missing entry costs the tester a guess.
      Do NOT create design.md or tasks.md — planning happens at pull time.
   In the delta spec the STRUCTURE keywords stay English — `## ADDED|MODIFIED|REMOVED|RENAMED
   Requirements` and `### Requirement: <text>` — because openspec hard-codes them; the requirement
   text and the scenario headings may be Russian (`#### Сценарий: …` is valid: upstream counts any
   level-4 heading). Every ADDED or MODIFIED requirement needs at least one scenario, and its text
   should carry SHALL or MUST.
   Run `<serpens-sdd> verify-docs`; fix until green. serpens-lint covers only what the
   CLI is blind to: a requirement outside any delta section, a `### ` heading that is not
   `### Requirement:` beside a good one, the missing `## Why` / `## What Changes` in proposal.md,
   plus SHALL/MUST and observability as warnings. The scenario rule and the rest of the delta
   grammar belong to the CLI, so verify-docs green is NOT enough on its own:
   `<openspec> validate <change-id> --type change --strict --json`. Fix until `"valid": true`;
   never hand over a change the CLI rejects.
   HANDOVER (do this yourself — the analyst never touches git): stage the change folder BY PATH
   (`git add openspec/changes/<change-id>`), never `git add -A` — the repository holds local-only
   settings and credential files that are not yours to commit, and a file you created is untracked
   until you add it. Commit `docs(<TICKET>): <text>`, push. Then, per `<serpens-sdd> delivery
   --print-contract`: if `pr-opened-by=human`, run `<serpens-sdd> delivery --handoff --change
   <change-id>` and paste its output to the human verbatim — do NOT create the change request. If
   `agent`, open (or update) it. Post the spec summary + the handoff (or the change-request link) back to the
   story. VERIFY before reporting: paste the evidence — verify-docs green, `"valid": true`, the
   pushed commit, and the handoff output (or the change-request link). Never claim done without
   it. Done.

## CROSS-REPO — only when step 2 found more than one repository (steps 4-9)

4. CROSS-REPO — TICKETS FIRST, driven by what already exists.
   `ticket-topology` (from `<serpens-sdd> delivery --print-contract`) is
   `parent-story+child-per-repo` in every shipped shop: look at the child tickets attached to the
   parent story.
   - Children already exist → use them. Map each child to its repo. If a repo has no child, or a
     child names no repo, STOP and ask the analyst — never guess an owner.
   - No children exist → follow `child-created-by`: `ask` (default) — ask the analyst "N repos are
     involved; shall I create one child story per repo, or will you?" and follow the answer;
     `analyst` — tell the analyst which N child tickets are needed and wait, never create them
     yourself; `agent` — create the N child tickets yourself through the tracker integration, one
     per repo, and say so. If someone else creates them, wait and re-read.
   The PARENT story is the store-contract ticket — it does not get a child of its own.

5. CONTRACT FIRST. WHERE YOU STAND DECIDES WHERE THE FILES LAND. Every path below is
   resolved by `git rev-parse --show-toplevel`, and a registered submodule is its own git root —
   so `cd` first, then resolve. You start this command in the SYSTEM STORE: `cd` to it if you are
   not there, set
   `STORE_ROOT="$(git rev-parse --show-toplevel)"`, then run
   `<serpens-sdd> state prepare-base`. Get the store branch name for the parent ticket the same
   way as in step 3b (`git-naming --print-contract <parent-ticket>`), then create and publish it
   and run
   `<serpens-sdd> state assert-change <parent-ticket>`. Run
   `<openspec> new change <contract-change-id>` (skip it when the folder already exists), then
   `<serpens-sdd> state mark-change <contract-change-id> --ticket <parent-ticket>` — idempotent, so
   a resumed change without a marker gets one. Then
   `<openspec> instructions proposal --change <contract-change-id> --json`. Before you touch
   `specs`, read its reported state in `<openspec> status --change <contract-change-id> --json`:
   `skipped` means this change's `.openspec.yaml` sets `skip_specs: true` — it is SATISFIED, and
   creating a delta spec is forbidden (upstream's own validator rejects a `skip_specs` change
   that carries spec files). A store contract with no delta defines no shape, so stop and ask the
   analyst rather than writing one. Any other state runs
   `<openspec> instructions specs --change <contract-change-id> --json`, one at a time, until its
   proposal and contract delta exist. They land in the STORE's own
   `openspec/changes/<contract-change-id>/` — proposal.md, the contract delta spec and research.md
   all belong to the store, on the parent ticket's branch. Use `store-contract.md`; shape facts
   live there and nowhere else.
   The contract proposal MUST carry a literal `## Why` heading and a literal `## What Changes`
   heading. This is not style: without `## Why`, every spoke's fetch line dies with
   `{"code":"show_error","message":"Change must have a Why section"}` — while
   `validate --strict` still reports `"valid": true`, `status` and `list` still work, and no gate
   in this kit notices. A contract nobody can read is worse than one that fails loudly, so prove
   it yourself before you push:
   ```bash
   <openspec> show <contract-change-id> --type change --store <store-id> --json --deltas-only
   ```
   It must print `"deltaCount"` and the requirement text. No flag bypasses a missing `## Why` —
   `--requirements-only`, `--no-scenarios` and the deprecated `change show` all fail the same way. Run `<serpens-sdd> verify-docs` and
   `<openspec> validate <contract-change-id> --type change --strict --json`; fix until both are
   green and `"valid": true`. Then commit, push. Per `<serpens-sdd> delivery --print-contract`:
   if `pr-opened-by=human`, run `<serpens-sdd> delivery --handoff --change <contract-change-id>`
   and paste its output to the human verbatim — do NOT create the store change request. If
   `agent`, open it. Post its link
   (or the handoff) on the parent story.

6. PER REPO, one at a time. Each child ticket owns exactly one repository, and its artifacts live
   INSIDE that repository, never in the store:
   a. Enter the submodule first — `cd "$STORE_ROOT/submodules/<repo>"` — and only then set
      `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Verify it: `REPO_ROOT` must be the submodule
      path, not `STORE_ROOT`. If they are equal you are still in the store and every artifact would
      land in the wrong repository — stop and cd. Place yourself exactly as in steps 3b-3c, using
      the child ticket: ask `git-naming --print-contract <child-ticket>` for the name, and if you
      are already on it skip `prepare-base` and resume;
      if the branch exists locally or on origin, check it out; only when it exists nowhere run
      `<serpens-sdd> state prepare-base`, create and publish it. Finish with
      `<serpens-sdd> state assert-change <child-ticket>`. The child tickets
      come from step 4, so the ticket gate is already satisfied here.
   b. Run `<openspec> new change <change-id>` from inside the submodule, so the change folder is
      that repository's own `openspec/changes/<change-id>/` (skip when it exists), then run
      `<serpens-sdd> state mark-change <change-id> --ticket <child-ticket>` — idempotent, so a
      resumed change without a marker gets one. Then, one artifact at a time,
      `<openspec> instructions proposal --change <change-id> --json` first. Then read `specs`'
      reported state in `<openspec> status --change <change-id> --json` BEFORE you touch it:
      `skipped` means this child's `.openspec.yaml` sets `skip_specs: true` — a legitimate "no
      spec-level behavior change", typically a behaviour-preserving consumer refactor. Treat it
      as SATISFIED, create NO delta spec (upstream's validator rejects a `skip_specs` change that
      carries spec files), and put the contract pointers below in research.md instead. A resumed
      branch is the common case here: `new change` above is skipped when the folder already
      exists, so never infer "missing" from a folder you did not just create. Any other state
      runs `<openspec> instructions specs --change <change-id> --json` — those two only — until
      the proposal and that repo's OWN delta spec exist. The delta LINKS the store
      contract — never restates the shape — and carries BOTH fetch lines, because the two routes
      never overlap: the store contract merges LAST (this estate's `merge-order` from
      `<serpens-sdd> delivery --print-contract` ends in `store-contract`), so while it is open it
      exists only inside its change folder, and archiving it deletes that folder the moment the
      spec route starts working.
      Write both, labelled, and record the contract CHANGE id next to the spec id — during the open
      window the spec id alone cannot resolve anything:
      ```text
      contract: <contract-spec-id> in store <store-id> (change <contract-change-id>)
      while the contract change is open:
        <openspec> show <contract-change-id> --type change --store <store-id> --json --deltas-only
      after the contract change is archived:
        <openspec> show <contract-spec-id> --type spec --store <store-id>
      which window am I in: <openspec> list --specs --store <store-id> — the spec id absent means open
      if the CLI refuses (a broken contract proposal, an unregistered store), read the file —
      but read the contract's own specs state first; skipped means there is no delta to read:
        <openspec> status --change <contract-change-id> --store <store-id> --json  # specs skipped => no delta exists; ask the analyst, never create one
        <openspec> instructions specs --change <contract-change-id> --store <store-id> --json  # prints changeDir
        cat <changeDir>/specs/<contract-spec-id>/spec.md
      ```
      `--json` is mandatory on the change route: without it the CLI prints proposal.md only, omits
      the delta silently and still exits 0. Never use `<openspec> change show` or
      `<openspec> spec show` here — the noun-first forms have no `--store` flag and resolve against
      the spoke instead.
      Append verified facts to research.md as pointers. No design.md, no tasks.md.
      Split the tester's facts and write the `## OBSERVABLE CONTRACT` block in research.md exactly
      as step 3c says — from THIS repository's `serpens/testing-stack.md`, one pointer per fact.
   c. Run `<serpens-sdd> verify-docs`; fix until green. The split-brain lint must pass; if it
      fires you restated a contract fact — delete it and link instead. Then run
      `<openspec> validate <change-id> --type change --strict --json`; fix until `"valid": true`.
   d. Stage the change folder by path, commit as `docs(<child-ticket>): <text>`, push. Then, per
      `<serpens-sdd> delivery --print-contract`: if `pr-opened-by=human`, run `<serpens-sdd>
      delivery --handoff --change <change-id>` and paste its output to the human verbatim — do
      NOT create the change request; post that handoff to the ticket. If `agent`, open it and post
      the link to the ticket. Never `git add -A`; never leave the step uncommitted.

7. GATES. On every implementation child record: approval order (contract first — a fixed kit
   rule), implementation order (producer first), merge order (this estate's `merge-order` from
   `<serpens-sdd> delivery --print-contract`, default `producer,consumers,store-contract`), and
   that a contract change stops work in all repos. Mark each child blocked by the parent.

8. On the parent story, post the ticket → repo → role map and the intended merge window
   (`link-posted-to` — the same place the handoff and test plan land).

9. VERIFY before reporting: every child is linked and mapped to a repo; every repo has a branch, a
   pushed commit, and an open change request OR a handoff printed when `pr-opened-by=human`;
   verify-docs green and openspec `validate --strict` reporting `"valid": true` in each. Paste the
   evidence.
   Never claim done without it.
