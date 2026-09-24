# Delivery conventions

**Home:** `system-store/serpens/delivery.md`. Single source of truth for the whole estate.
Repos and agents read it via `serpens-sdd delivery --print-contract` / `--handoff`; they never
restate its values in their own prose.
**Enforced by:** `serpens/bin/serpens-sdd delivery`, and `state assert-archivable` for the
merge-style-keyed archive gate. Prompts advise, checks enforce — never fix a red check by
weakening it.

## What this covers

The forge word (PR vs MR), who opens the pull/merge request, ticket topology, where the plan and
test plan are posted, approval order, merge order and merge style, the review boundary, the
integration and release branch, when archive runs, and where the hand-off goes. Out of scope:
branch/commit shape (`branching.md`), role names, environment names.

## Changing the shape for your shop

The values below are the built-in default — today's kit behaviour, unchanged until you add a
contract block. Copy this, uncomment it, and set your own values:

```markdown
<!-- serpens:section delivery-contract -->
| Field | Value |
|---|---|
| `forge-word`          | PR |
| `pr-opened-by`        | human |
| `ticket-topology`     | parent-story+child-per-repo |
| `child-created-by`    | ask |
| `proposal-approval`   | analyst-in-story |
| `test-plan-posted-to` | same-ticket-comment |
| `merge-order`         | producer,consumers,store-contract |
| `review-may-merge`    | no |
| `integration-branch`  | develop |
| `release-branch`      | master |
| `archive-when`        | after-qa-accepted |
| `merge-style`         | merge |
| `handoff-to`          | chat |
```

- The block must NOT sit inside a fenced code block — a fence hides it, which is what lets the
  example above stay an example.
- Anything wrong inside the block is a hard error naming this file and the line. It never falls
  back to defaults silently.
- Check what is actually in force at any time:

```bash
serpens-sdd delivery --print-contract
serpens-sdd delivery --handoff [--change <change-id>] [--base <branch>]
```

`--handoff` records the pushed tip (T, the last WORK commit — never a hand-off record commit
itself), then commits and pushes THAT RECORD ITSELF, as its own `chore(<TICKET>): record handoff
<sha>` commit — the tree is never left dirty. `--change <change-id>` names which change the
hand-off belongs to; omit it and the tool derives the ticket from the current branch name and
finds the one marked change for it (`state mark-change`). A fix loop (a second hand-off for the
same change, after an earlier squash/merge) appends a new record; the latest wins for the merged
check, and earlier ones are kept for the squash re-edit fallback.

## Settings reference

Every field below: what it controls, why it exists, its allowed values with a one-line meaning
each, and its default.

- **`forge-word`** — the word the kit's prose uses for a change request. Prevents the kit from
  saying "PR" in a shop that calls it "MR".
  - `PR` — pull request wording. **Default.**
  - `MR` — merge request wording.

- **`pr-opened-by`** — who opens the change request. Prevents the agent from attempting a forge
  action (`gh pr create`, `glab mr create`, a forge API call) in a shop where only a human may do
  that.
  - `human` — the agent commits and pushes only; it must never try to create the PR/MR. It prints
    a hand-off (`delivery --handoff`) instead. **Default**, and the shipping author's own shop.
  - `agent` — the agent may open the PR/MR itself.

- **`ticket-topology`** — how a cross-repo change is ticketed. Prevents an agent from inventing
  its own ticket shape per estate.
  - `parent-story+child-per-repo` — one parent story holding the shared contract, one child
    ticket per repository that implements it. **Default**, and the only shipped value —
    `single-ticket` is deferred (see Deferred below), not a live option.

- **`child-created-by`** — who creates the per-repo child tickets under the parent story.
  Prevents the agent from silently deciding this on its own.
  - `ask` — the agent asks the human each time. **Default.**
  - `analyst` — the analyst creates the child tickets; the agent waits for them to exist.
  - `agent` — the agent creates the child tickets itself (requires tracker write access).

- **`proposal-approval`** — who must approve the spec proposal before planning starts. Prevents
  `spns-plan` from starting on an un-approved idea.
  - `analyst-in-story` — the analyst approves the proposal inside the story ticket.
    **Default.**
  - `none` — no gated proposal approval; planning may start immediately.

- **`test-plan-posted-to`** — where the test plan is recorded. Prevents a second, orphaned test
  ticket nobody looks at.
  - `same-ticket-comment` — posted as a comment on the same ticket the work is tracked under.
    **Default.**
  - `print-only` — printed to chat only; no tracker write happens (used when no tracker is
    configured).

- **`merge-order`** — the order repos merge in, for a cross-repo change with a shared contract.
  Prevents a consumer merging ahead of its producer, or the store contract merging before either.
  - a comma-separated permutation of `producer,consumers,store-contract` — same three tokens,
    any order that reflects your shop's actual dependency direction.
  - **Default:** `producer,consumers,store-contract` (producer first, store contract last).

- **`review-may-merge`** — whether the reviewer role may also merge. Kept as a visible, single-
  value field rather than silently assumed, so the boundary is explicit.
  - `no` — the only allowed value; review never merges. **Default**, and the only value shipped
    (any other value is a configuration error, on purpose — this boundary is not a shop's to
    weaken).

- **`integration-branch`** — the branch feature branches merge into (git-flow's `develop`, or a
  shop's own trunk). Feeds the base-branch resolution used by the state-inspection tool and the merge-style-keyed
  archive check.
  - any valid branch name (`git check-ref-format --branch`). **Default when unset:** today's
    detection order — `origin/develop` if it exists, else the remote's symbolic HEAD (the same
    lookup the kit has always used; setting this field only overrides that
    detection, it introduces no new behaviour when left unset).

- **`release-branch`** — the branch a release is cut to (git-flow's `master`/`main`).
  Informational only: no gate reads it today; it feeds hand-off/status text (release PR
  guidance).
  - any valid branch name. **Default:** `master`.

- **`archive-when`** — when `spns-archive`'s step 0 may run at all. Prevents archiving a change
  before the estate's real "it's actually shipped" moment.
  - `after-merge` — archive as soon as the feature branch merges into `integration-branch`.
  - `after-qa-accepted` — archive waits until a tester signs off on the deployed integration
    branch. **Default** — a human must confirm this choice once per estate; the agent asks, never
    assumes, and records the answer.

- **`merge-style`** — how merges land in `integration-branch`, so the archive gate can tell
  "my commits actually landed" from a stale proxy. Required once the merged check is wired — no
  silent default, because the check logic differs per value. Once set, `state assert-archivable`
  requires `--change <change-id>`: the hand-off tip is recorded per CHANGE, never per branch — the
  story branch that carried the hand-off is usually deleted by the time you archive, and archive
  can be run from any branch (often `integration-branch` itself). A hand-off recorded during
  `spns-implement`/`spns-spec` (the change still marked, `openspec/changes/<change-id>/` still
  present) is keyed to that change-id; one recorded later, after `<openspec> archive` has folded
  the change away, falls back to the ticket itself as the key — still never the branch.
  - `merge` — a real merge commit; checked by "the recorded hand-off tip SHA is an ancestor of
    `origin/<integration-branch>`".
  - `squash` — squashed into one commit on the integration branch; checked by path-set identity
    (the tip's changed paths equal the integration branch diff's changed paths), since the
    original commit is gone.
  - `rebase` — replayed commit-by-commit; checked with `git cherry` (every commit from the tip
    already applied, no `+` lines).
  - **No default** — must be set explicitly once your estate wires the merged check.

- **`handoff-to`** — where `delivery --handoff`'s output goes, beyond always being printed to
  chat. Prevents a hand-off from silently vanishing in a shop that expects it on the ticket too.
  - `chat` — printed to chat only. **Default.**
  - `chat+ticket` — also posted as a comment on the ticket (the same ticket
    `test-plan-posted-to` targets). Requires a tracker to be configured; with none configured,
    this errors naming the missing tracker rather than silently falling back to `chat`.

## Deferred (not shipped, not an allowed value today)

- **`ticket-topology=single-ticket`** — no shop has asked for it. The two cases it seemed to
  cover already work without it: a single-repo change never needed a parent/store-contract
  ticket, and a multi-repo change with no genuine shared contract is planned as N independent
  stories, one per repo. A real "one ticket, many repos, no per-repo split" need is a new enum
  value proposed and tested on its own merits, not a resurrection of this one.

## `## Team notes`

Free text below this anchor is shown to the agent as context (estate quirks, hand-off etiquette,
anything a human wants remembered). No gate or test depends on it — the parser ignores it
entirely, exactly like any prose outside the fenced/anchored table.

## Archive: mechanical, whoever opens the PR

Archive's precondition is always verified by `serpens-sdd state assert-archivable --change
<change-id>`, never by reading the forge UI, the tracker, or a PR link. Non-zero exit = not
merged. Who opened the PR/MR does not change the check — it reads git only. Always pass
`--change`: the merge-style-keyed check reads the hand-off tip recorded for that CHANGE, not for
whatever branch you happen to be standing on.

**A refusal is always correct — never route around it.** With `merge-style=merge`/`rebase`, the
check also verifies the recorded tip's hand-off record carries a `Serpens-Handoff-Tip:` commit
trailer only `delivery --handoff` produces; a record without one is rejected as unverifiable,
whether or not its `handoff-tip:` line "looks right". Never hand-edit `.serpens.yaml`, never
fabricate a `handoff-tip:` line, and never hand-write a `chore(<TICKET>): record handoff <sha>`
commit yourself to make a red check green — that is exactly the forgery this trailer exists to
catch, and it is now detected. If a refusal seems wrong, say so to the human with the tool's exact
message; do not work around it.

## Who does what

- **The agent** reads this file's contract via `serpens-sdd delivery --print-contract` before
  every "open the PR" moment, and via `serpens-sdd delivery --handoff` when `pr-opened-by=human`
  — it never assembles the hand-off text itself.
- **DevOps** owns this file. A change here is a change to every repo.
