# Operations

## Daily entry gate

Start inside the selected repository, not at the system-store root:

```bash
export REPO_ROOT="$(git rev-parse --show-toplevel)"
<serpens-sdd> state inspect
```

Before a new story, run `prepare-base`, ask `<serpens-sdd> git-naming --print-contract <TICKET>`
for the branch name, create it from the reported base, publish its upstream, then run
`assert-change <TICKET>`. The branch and commit shapes are the shop's — they live in
`serpens/branching.md` and nothing in this kit restates them. During interrupted
work, use `assert-change <TICKET> --allow-dirty` only after you recognize every
local edit. A non-zero result is a hard stop.

The repository-state tool never resets, cleans, rebases, deletes branches, changes
an unknown dirty tree, or hides local commits. It resolves the base from
`SERPENS_BASE_BRANCH`, local `serpens.baseBranch`, the parent store's `.gitmodules`,
remote `develop`, then the remote default.

`<serpens-sdd> state inspect` prints `dirty=` and `untracked=` as two separate facts, and only
the first one gates anything. `dirty` counts uncommitted changes to TRACKED files
(`--porcelain --untracked-files=no --ignore-submodules=untracked`). Untracked files — local
settings, credential files, build output — are reported once as a warning and block nothing, so
a working repository never has to be tidied before a spns-* command. Inside the store, a
submodule whose own tracked files changed is named in the failure ("uncommitted changes to
TRACKED files inside submodule(s): …") rather than blamed on the store; an untracked file inside
a submodule leaves the store clean.

## Which edition am I running?

The kit is versioned. `VERSION` holds the edition, every shipped command, skill and
tool carries a matching `serpens-version:` stamp, and `MANIFEST.sha256` pins their exact
bytes. To tell a kit file apart from a locally changed copy:

```bash
KV="<serpens-sdd> version"
$KV show      --root "$SERPENS_SDD_ROOT"                     # the edition this kit is
$KV list      --root "$SERPENS_SDD_ROOT"                     # every stamped file and its stamp
$KV check     --root "$SERPENS_SDD_ROOT"                     # fail if any stamp differs from VERSION
$KV verify    --root "$SERPENS_SDD_ROOT"                     # nothing changed since that edition
$KV identify  --root "$SERPENS_SDD_ROOT" <installed-file>    # pristine / MODIFIED / UNSTAMPED
```

`--root <kit-root>` is required in every mode: the tool no longer lives inside the kit it
reports on, so it reads `VERSION` and `MANIFEST.sha256` from wherever `--root` points, not
from beside itself. `identify` hashes the file you name, so it works on an installed
copy at any path — an agent-home command directory included. `UNSTAMPED` means the copy
predates versioning or is your own; `MODIFIED` means it carries a stamp but not those bytes.

## Workflow

1. `spns-spec`: inspect live repositories, then place yourself before creating anything —
   no tracker key means no branch (ask once; never invent one), and an existing story
   branch, checked out or not, is resumed rather than recreated. Only a branch
   that exists nowhere goes through `prepare-base`. Then create the change and ask the
   OpenSpec CLI for `proposal` and `specs`, one artifact at a time.
2. `spns-plan`: assert the story branch and create current design and tasks.
3. `spns-implement`: assert the branch, enter OpenSpec apply, then use Serpens TDD.
4. `spns-review`: inspect state, then run `<openspec> validate <change-id> --type change --strict
   --json` and `<openspec> status --change <change-id> --json` before human review. There is no
   `verify` subcommand in OpenSpec 1.10.
5. `spns-test-plan` and `spns-autotest`: derive checks from approved scenarios.
   `spns-test-plan` is **black-box**: the request or event to send, the expected response, and
   the expected stored rows on the dev stand — posted per `test-plan-posted-to` (from
   `<serpens-sdd> delivery --print-contract`), `same-ticket-comment` by default, never a separate
   test task. `spns-autotest` is the in-code layer.
6. Once `archive-when` (from `<serpens-sdd> delivery --print-contract`) is satisfied — QA's
   sign-off on the dev stand by default (`after-qa-accepted`), or merge into the integration
   branch when set to `after-merge` — `spns-archive`: place the archive commit, then run
   OpenSpec archive.
   With no flag it asks you which of three placements to use and never picks for you; option (1)
   cuts a fresh story branch from the prepared base, named by
   `<serpens-sdd> git-naming --print-contract <TICKET>` — no suffix, because `git-naming` accepts
   the configured shape and nothing else, so a suffixed branch fails the pre-push guard. `--branch <name>` names that branch; `--here` archives on the current
   branch.
   Every mode is gated by `assert-archivable`, which requires a clean tree and a
   HEAD that already contains the configured base.

The exact generated OpenSpec invocations live in `serpens/port-facts.md` and the installed
commands. Re-probe them after every port or OpenSpec upgrade.

## Refresh project bindings

Re-run project-binding discovery for the stored project id. Prefer MCP when its
tool is available; otherwise update the same normalized rows manually. There is
no `project-repositories.json` to edit any more — feed the rows to
`sync-submodules` on stdin instead:

```bash
export STORE_ROOT="$(git rev-parse --show-toplevel)"
printf '%s\t%s\t%s\n' service-a ssh://git@forge/project/service-a.git develop \
  | <serpens-sdd> sync-submodules --repos-from - --store-root "$STORE_ROOT"
git -C "$STORE_ROOT" submodule status
```

A store still carrying a `project-repositories.json` from before this edition
may instead pass `--inventory "$STORE_ROOT/project-repositories.json"`.

New bindings are added. Existing matching bindings are initialized. Missing
bindings are reported but preserved. URL, unsafe-path, and foreign-directory
mismatches stop before mutation.

To refresh registered content after reviewing local state:

```bash
git -C "$STORE_ROOT" submodule foreach --recursive 'git fetch --prune origin'
```

Use each repository's `<serpens-sdd> state prepare-base` to fast-forward safely.
Do not use bulk checkout or reset commands.

## Cross-repository changes

`ticket-topology` (from `<serpens-sdd> delivery --print-contract`) is
`parent-story+child-per-repo` in every shipped shop: use one parent ticket for the system-store
contract and one child ticket per repository (`child-created-by` decides who creates them: `ask`,
`analyst`, or `agent`). Create the contract first. Repository delta specs link the contract
by store id and spec id; they do not restate its field shape. Approval order is
contract first. Implementation and merge order are this estate's `merge-order`, default
producer, consumers, then the store contract. A contract change stops all dependent work.

Regenerate the central catalog after repository indexes are current:

```bash
<serpens-sdd> catalog --strict "$STORE_ROOT"
```

## Recovery table

| State | Meaning | Safe next action |
|---|---|---|
| detached HEAD | no safe story branch | identify the owning remote branch; preserve commits |
| dirty during base preparation | edits may be unique | inspect and deliberately commit or relocate them |
| ahead of upstream | unpublished commits | review and push or move them before switching |
| behind only | safe update available | run `prepare-base` for verified fast-forward |
| ahead and behind | divergence | stop and choose merge or rebase under team policy |
| wrong story branch | work may belong elsewhere | inspect; switch only after preserving local work |
| orphaned binding | inventory no longer lists it | confirm project ownership before manual removal |

## Optional Zoekt index

Zoekt is optional. The workflow works without it. On its dedicated host, install
`zoekt-git-index` and Universal Ctags, then run:

```bash
<serpens-sdd> index-code --store-root "$STORE_ROOT" \
  --index-dir "${SERPENS_ZOEKT_INDEX_DIR:-$STORE_ROOT/.cache/zoekt/index}"
```

The tool reads `.gitmodules`, validates every path before indexing, requires real
Universal Ctags, and reports missing registered submodules. Never maintain a
second repository list for search.

## Operating rules

1. Prompts advise, the disposer and CI enforce. Never fix a red check by weakening it.
2. Caps reject, never trim. The agent regenerates; humans never hand-repair generated files.
3. The central catalog is a routing hint. The repository index outranks it; the
   repository outranks its own index.
4. Specs are durable, plans are disposable. Regenerate design and tasks when in doubt.
5. Every spec-versus-code mismatch becomes a delta. That is the spec base growing,
   not a failure.
6. The same error three times: stop and ask a human.

## Measure adoption

Record these in a `baselines/` note in the store before the first team starts, then
on the same period afterwards. Both are pure Git and need no CI data:

```bash
# merges in the trailing 90 days — deploy-frequency proxy until CI data is wired
git log --merges --since="90 days ago" --format=%cI | wc -l
# archived changes per repository — the adoption counter
ls openspec/changes/archive 2>/dev/null | wc -l
```

Squash-merge repositories have no merge commits: count merged change-request (`forge-word`)
subjects with `git log --grep` instead.

Anti-gaming check, per archived change: the proposal must predate the first
implementation commit on that branch.

```bash
git log --diff-filter=A --format=%ct -- "openspec/changes/<id>/proposal.md" | tail -1
```

A spec written after the code is flow theater; count it as non-adoption.

Ask the team these five questions quarterly, anonymously, at team level, on a 1–5
scale, plus one free-text answer. Use them verbatim so the periods stay comparable:

1. How satisfied are you with your day-to-day development workflow?
2. How often can you work on a task without losing flow to friction or waiting?
3. How would you rate the quality of code review you receive?
4. How much does the SDD flow help versus hinder your work?
5. Would you recommend the flow to a colleague team?

Free text: what one thing should we fix?

## Upgrade

An existing workspace is upgraded by [`docs/UPGRADE.md`](UPGRADE.md), not by
repeating the install. Read it before pulling the new kit.

The short version: inventory every installed file with `<serpens-sdd> version identify --root <kit>`
first, gate each repository with `<serpens-sdd> state prepare-base`, refresh the
store's `serpens/bin/` **and** every spoke's `serpens/bin/`, reinstall commands and skills and
re-resolve every `<openspec>` token from `serpens/port-facts.md`, stop on any
`MODIFIED` copy instead of overwriting it, re-run the negative tests, and commit
each Git repository separately.

Never overwrite the system store from `system-store-template/`, never re-run
`git init` there, and never let an upgrade touch `.gitmodules`, any `openspec/`
tree, or a `project-repositories.json` left over from before this edition.
