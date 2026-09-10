# Serpens SDD flow

This is the short English workflow reference. Installation is documented only in
[`SETUP.md`](SETUP.md); upgrading an existing workspace only in [`UPGRADE.md`](UPGRADE.md);
daily use only in [`OPERATIONS.md`](OPERATIONS.md).

The same seven stages twice more: [`FLOW-TABLE.md`](FLOW-TABLE.md) is the wide table — per step,
what Serpens SDD performs, the OpenSpec call, the Superpowers discipline, the scripts that actually
run, the exit gate, and the value over vanilla OpenSpec. [`FLOW-SCHEMA.md`](FLOW-SCHEMA.md) is the
one-screen diagram.

## Installation boundary

The installer places `system-store` next to this repository. Product repositories are Git
submodules under `system-store/submodules/`; no clone directory is maintained.

1. Discover project-bound repositories through the available MCP during setup stage 1.
2. If MCP is unavailable, collect the same `name`, `url`, and `baseBranch` inventory manually.
3. Validate the inventory and write `system-store/project-repositories.json`.
4. Run `sync-submodules.sh`; it registers, initializes, and updates only declared submodules.
5. Install the kit's commands, tools, and six self-contained `corp-*` skills.
6. In every onboarded repository, install `templates/testing-stack.md` as `docs/testing-stack.md`
   and fill it in with the team. `spns-tdd` and `spns-debugging` name no framework of their own —
   they read that file, so an empty one leaves both skills without a stack.
7. Replace the single `<openspec>` token in every installed command and skill with the CLI
   invocation `port-facts.md` records for this port.
8. Run the acceptance checks before using the workflow.

MCP improves discovery but is not an installation dependency. Upstream Superpowers is also
optional because the required engineering disciplines are included in the kit.

## Delivery lifecycle

`<openspec>` below is that resolved CLI invocation, and `<change-id>` the OpenSpec change folder.

| Step | Corp command | Required OpenSpec action | Repository-state gate |
|---|---|---|---|
| Specify | `spns-spec` | `<openspec> new change <change-id>`, then `instructions proposal` and `instructions specs` one artifact at a time, then `validate <change-id> --type change --strict --json` until `"valid": true`. | Inspect first; place yourself on an existing `feature/<TICKET>`, or prepare the configured base and cut it. |
| Plan | `spns-plan` | `<openspec> instructions design` and `instructions tasks`, one at a time; nothing else. | `assert-change <TICKET> --checkout` — moves onto an existing story branch, never creates one. |
| Implement | `spns-implement` | `<openspec> instructions apply --change <change-id> --json` for task state only; `validate --strict --json` again on any spec amendment. | `assert-change <TICKET> --checkout --allow-dirty`. |
| Plan tests | `spns-test-plan` | No OpenSpec command. Reads the delta scenarios and the change's `research.md` OBSERVABLE CONTRACT block. | Inspect, plus `assert-change <TICKET> --allow-dirty` on a local change branch. |
| Generate autotests | `spns-autotest` | No OpenSpec command. Reads the approved delta scenarios. | `assert-change <TICKET> --checkout --allow-dirty`. |
| Review | `spns-review` | `<openspec> validate <change-id> --type change --strict --json` and `status --change <change-id> --json` before the deeper code review. | Inspect, plus `assert-change <TICKET> --allow-dirty` on a local story branch. |
| Archive | `spns-archive` | `validate --strict --json`, then `<openspec> archive <change-id> --yes --json` after the pull request is merged. | `prepare-base` (unless `--here`), then `assert-archivable`. |

Every asserting mode of the gate — `prepare-base`, `assert-change`, `assert-archivable` — first
proves the repository owns its own OpenSpec root, and refuses with
`✗ OpenSpec root is not this repository` plus `  ↳ resolved root: <path>` when it does not:
OpenSpec walks UP past `.git` looking for an `openspec/` directory, so a repository that was
never `openspec init`-ed writes every artifact into the store instead. `inspect` stays
non-fatal; it only reports the resolved root on its `openspec_root=` line.

`spns-spec`, `spns-plan`, `spns-implement`, `spns-autotest`, and `spns-archive` each finish their
own Git work: they stage the files they wrote **by path** — never `git add -A` — commit under the
type `check-git-naming.sh` expects, and push. `spns-implement` commits ONCE, when every task box is
ticked, never per task.

Every command derives `REPO_ROOT`, `STORE_ROOT`, and tool paths at runtime. It never depends on a
developer-specific absolute path or on the caller's current directory.

## Proof

Run the nine scripts in `tests/` against both language kits. They cover submodule
synchronization, branch safety, the OpenSpec-root ownership gate, aggregation, indexing, path
derivation, documentation scope, MCP fallback, the explicit `<openspec>` calls, the
`serpens-lint.mjs` checks themselves, the split-brain lint during the cross-repo window, the
kit-edition stamps and manifest, and the absence of clone-era paths.
