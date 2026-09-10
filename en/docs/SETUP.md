# Setup task for the installation agent

Run these stages after pulling or upgrading `serpens-sdd`. Stop on every failed gate.
Record commands and outputs in your project handover. Never delete, reset, clean,
rebase, force-checkout, or rewrite an existing repository during setup.

## 0. Prerequisites, required inputs, and durable roots

Prove the toolchain before anything else. Each line must print a version; a miss
stops the install, because the failure otherwise lands mid-stage 3 with a
half-populated store:

```bash
git --version        # >= 2.13, for `submodule --branch`
node --version       # >= 18, runs the .mjs disposers
lefthook version     # install through the approved internal channel first
```

- `@fresh-fx59/serpens-sdd` is installed and `serpens-sdd version` prints edition `2026-09-10.1`.
  Node >= 18. Nothing in this procedure copies a script into a repository.

The OpenSpec CLI is pinned and internal. The package is `@fission-ai/openspec`;
the bare name `openspec` on the public registry is an unrelated empty `0.0.0`
placeholder and will silently install nothing usable. Record the pinned version
in `port-facts.md` and prove it once:

```bash
npx @fission-ai/openspec@<pinned-version> --version
```

On a restricted network, resolve that package through the approved internal
mirror and note the resolved registry in your handover.

Obtain `<project-id>`, the corporate agent port name, the pinned OpenSpec package
version, the system-store remote URL and approved base branch, and internal forge
credentials. From the `serpens-sdd` checkout:

```bash
export SERPENS_SDD_ROOT="$(git rev-parse --show-toplevel)"
export SERPENS_WORKSPACE_ROOT="$(cd "$SERPENS_SDD_ROOT/.." && pwd -P)"
export SERPENS_SYSTEM_STORE_ROOT="${SERPENS_SYSTEM_STORE_ROOT:-$SERPENS_WORKSPACE_ROOT/system-store}"
test -d "$SERPENS_SDD_ROOT/system-store-template"
test "$SERPENS_SYSTEM_STORE_ROOT" != "$SERPENS_SDD_ROOT"
```

These variables replace machine-specific paths. Keep `system-store` beside
`serpens-sdd`, never inside it.

`<serpens-sdd> index-code` additionally needs **Universal Ctags** (`ctags --version` must print
`Universal Ctags`; BSD ctags is rejected by brand on purpose, because `sym:` search dies
silently on it) and the Zoekt indexer. Both are optional: skip code search and the rest of
the kit works.
## 1. Discover repositories for `<project-id>`

This is the first setup action after resolving roots. Enumerate available MCP
tools and, when a project-binding tool exists, call it now with `<project-id>`.
Include only repositories bound to that project.
Normalize its result to this schema:

```json
{
  "schema_version": 1,
  "project": "<project-id>",
  "repository_source": "mcp",
  "repositories": [
    {"name": "service-a", "url": "ssh://git@forge/project/service-a.git", "base_branch": "develop"}
  ]
}
```

Manual fallback: if MCP is absent, inaccessible, or does not expose repository
bindings, copy `config/project-repositories.json.example`, set
`repository_source` to `manual`, and fill the same fields from the forge project.
Installation continues normally; report which source was used.

For each repository, use the base branch returned by MCP when present. Otherwise
prefer `develop` when that remote branch exists, then use the remote symbolic
default branch. Never infer the base from the current checkout. Validate safe,
unique names, non-empty URLs, and valid Git branch names before writing anything.

## 2. Discover the agent port before installing

Probe the real port and write evidence to a copy of `templates/port-facts.md`:

1. configuration directory and project instruction filename;
2. command directory, file format, invocation syntax, and argument token;
3. skill directory and whether project-scoped skills load automatically;
4. the exact OpenSpec CLI invocation, proven by running it — the workflow uses CLI
   subcommands (`new change`, `status`, `instructions`, `validate`, `archive`), not the
   agent slash commands, which vary by version and profile;
5. MCP tool names for project repository bindings, tracker, wiki, and code search;
6. hook support, context limits, and agent version.

Do not assume any agent-home directory name, slash command, or MCP tool name — this kit
names none of them, on purpose: the same kit installs onto ports whose homes and instruction
files are called different things. Initialize OpenSpec once in temporary data with the pinned
internal package, then inspect the generated files.

Two of those facts are read back by the tooling, so record them where the machine can find
them, not only in prose:

```bash
git -C "$REPO" config serpens.agentDir "<the agent home you found, e.g. .acme>"
```

`<serpens-sdd> lint` resolves the agent home in this order: `SERPENS_AGENT_DIR`, then
`git config serpens.agentDir`, then the single dot-directory at the repository root that contains
a `skills/` subdirectory. It exits 1 rather than guess when it finds more than one. The port's
project instruction file — the `AGENTS.md` analogue, whatever this port calls it — needs no
configuration: the lint picks up every ALL-CAPS `.md` at the repository root except the usual
project files (README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, NOTICE).
Record both names in `port-facts.md` (P1) so a human reading the note knows what they are.

The installed commands call the OpenSpec **CLI**, never a generated slash command.
Slash commands differ between versions and profiles — OpenSpec 1.10's core profile
ships `propose, explore, apply, update, sync, archive` and has no `new`, `continue` or
`verify` at all — while these six CLI calls are stable and machine-readable. Record ONE
token, the exact invocation of the pinned package:

```text
<openspec>
```

Resolve it to whatever runs on this machine, for example `npx @fission-ai/openspec@<pinned-version>`
or an internal wrapper on PATH, and prove the calls the workflow uses:

```bash
<openspec> new change spns-probe
<openspec> status --change spns-probe --json
<openspec> instructions proposal --change spns-probe --json
<openspec> instructions specs --change spns-probe --json
<openspec> instructions apply --change spns-probe --json
<openspec> validate spns-probe --type change --strict --json
<openspec> archive --help
<openspec> store --help
<openspec> show --help
<openspec> list --help
```

The store-scoped calls the cross-repo path needs cannot be proven until a store exists, so
prove them at the end of stage 3 instead, against the registered store:
`store register`, `store list`, `show <change-id> --type change --store <id> --json --deltas-only`,
`show <spec-id> --type spec --store <id>`, `list --specs --store <id>`, and
`instructions specs --change <id> --store <id> --json`. Record every proven call with its
output in `port-facts.md`.

Delete the probe change afterwards. Record the resolved token and the six proven calls
in `port-facts.md`.

Upstream Superpowers is not required. Use the self-contained `skills/spns-*`
files. If the port has no skill mechanism, inline each referenced skill body into
the installed command and remove its `Follow skill ...` sentence.

## 3. Create or verify the sibling system store

Three cases, and the machine decides which one you are in — never guess, and never
ask the operator something Git can answer:

```bash
git ls-remote --heads "<system-store-remote-url>" "<system-store-base-branch>"
```

**The store already exists on the remote** (the probe printed a ref) — you are the
second developer or later. Clone it; do not create anything:

```bash
test ! -e "$SERPENS_SYSTEM_STORE_ROOT"
git clone --branch "<system-store-base-branch>" --single-branch "<system-store-remote-url>" "$SERPENS_SYSTEM_STORE_ROOT"
<serpens-sdd> state prepare-base --repo "$SERPENS_SYSTEM_STORE_ROOT" --base "<system-store-base-branch>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch "<system-store-base-branch>"
```

Running the template path here would `git init` a second, unrelated history against
a remote that already holds the project's store. That is the one mistake in this
stage that costs a rewrite rather than a retry.

**The project is explicitly creating a new empty store** (the probe printed nothing,
and this is the first install anywhere) — start from the shipped template:

```bash
test ! -e "$SERPENS_SYSTEM_STORE_ROOT"
cp -R "$SERPENS_SDD_ROOT/system-store-template" "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" init -b "<system-store-base-branch>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" remote add origin "<system-store-remote-url>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch "<system-store-base-branch>"
```

**The store is already on this machine** — do not copy or clone over it. Prove it is
an independent Git root, then gate its branch and worktree before touching the
inventory or the installed files:

```bash
test "$(git -C "$SERPENS_SYSTEM_STORE_ROOT" rev-parse --show-toplevel)" = "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" status --short --branch
<serpens-sdd> state prepare-base --repo "$SERPENS_SYSTEM_STORE_ROOT" --base "<system-store-base-branch>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch "<system-store-base-branch>"
```

The state gate refuses dirty worktrees, detached HEAD, unpushed commits on the base
branch, wrong upstreams, and divergence. It only performs a verified fast-forward.
A stash and commits on other local branches are reported, never blocked and never
touched — only `assert-archivable` treats a stash as a hard stop.

Place the normalized stage-1 result at
`$SERPENS_SYSTEM_STORE_ROOT/project-repositories.json`. Write the shim and copy the
templates without removing project-owned files:

```bash
# The shim: one generated file replaces the eleven copies. `serpens-sdd init` writes it during this
# stage (the `writeShim()` call in `stage3()`, src/stages/stage3-store.mjs — a function name, not a
# line number, so this citation cannot rot). An operator running the stages by hand proves it with:
test -x "$SERPENS_SYSTEM_STORE_ROOT/tools/serpens-sdd" && "$SERPENS_SYSTEM_STORE_ROOT/tools/serpens-sdd" version
install -m 0644 "$SERPENS_SDD_ROOT/templates/port-facts.md" "$SERPENS_SYSTEM_STORE_ROOT/port-facts.md"
install -m 0644 "$SERPENS_SDD_ROOT/templates/conventions-branching.md" "$SERPENS_SYSTEM_STORE_ROOT/conventions/branching.md"
mkdir -p "$SERPENS_SYSTEM_STORE_ROOT/templates"
install -m 0644 "$SERPENS_SDD_ROOT/templates/store-contract.md"  "$SERPENS_SYSTEM_STORE_ROOT/templates/"
install -m 0644 "$SERPENS_SDD_ROOT/templates/testing-stack.md"   "$SERPENS_SYSTEM_STORE_ROOT/templates/"
install -m 0644 "$SERPENS_SDD_ROOT/templates/research.md"        "$SERPENS_SYSTEM_STORE_ROOT/templates/"
install -m 0644 "$SERPENS_SDD_ROOT/templates/adr.md"             "$SERPENS_SYSTEM_STORE_ROOT/templates/"
```

Initialize OpenSpec in the store using the exact pinned package and port discovered
in stage 2. Run the copied root check, then register the absolute store path under
a stable `<store-id>` with the pinned OpenSpec CLI. Prove that `openspec store list`
returns that id and exact path. Do not run another OpenSpec command until its root
is verified.

Ids are a contract, not a label: cross-repo links resolve by id, so two agents
installing the same project must produce the same string. Use `<project-id>-store`
for `<store-id>` and the repository name from stage 1 for each repo id, both
lower-case kebab-case. Record both in `port-facts.md`.

## 4. Materialize project repositories as submodules

```bash
<serpens-sdd> sync-submodules \
  --inventory "$SERPENS_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule status
git -C "$SERPENS_SYSTEM_STORE_ROOT" diff -- .gitmodules
```

The sync is additive and repeatable. It records every base branch in `.gitmodules`,
rejects URL or path mismatches, and reports removed bindings as preserved orphans.
Resolve an orphan manually only after confirming its project binding and local work.

## 5. Onboard every registered submodule

For each path reported by `.gitmodules`:

1. run the root-derived `<serpens-sdd> state prepare-base` and resolve every stop;
2. initialize OpenSpec in that repository with the pinned package and discovered port;
3. run `<serpens-sdd> openspec-root` and prove the reported root is that submodule;
4. the shim replaces the spoke tool copies: `serpens-sdd init` writes it into this submodule
   (the `writeShim()` call in `onboardOne()`, `src/stages/stage5-onboard.mjs`), never by hand. Prove it the same way as the
   store: `test -x "$submodule/tools/serpens-sdd" && "$submodule/tools/serpens-sdd" version`. Copy
   only the templates the installed commands cite by path -- `adr.md` (spns-archive), `research.md`
   and `testing-stack.md` -- into its `templates/` directory. A command that names a template the
   repository does not have is a dead instruction;
5. copy `config/lefthook.yml.example` to `lefthook.yml` **and substitute the token in the copy**
   — the example carries four literal `<serpens-sdd>` tokens, and stage 6's substitution pass covers
   only the installed command and skill directories, never this file. A `lefthook.yml` that still
   reads `run: <serpens-sdd> verify-docs` fails EVERY commit in the repository:

   ```bash
   shim='"$(git rev-parse --show-toplevel)"/tools/serpens-sdd'   # the resolved invocation, as in stage 6
   sed "s|<serpens-sdd>|$shim|g" "$SERPENS_SDD_ROOT/config/lefthook.yml.example" > "$submodule/lefthook.yml"
   grep -n '<serpens-sdd>' "$submodule/lefthook.yml" && exit 1 || true   # must find nothing
   ```

   then install lefthook through the approved internal channel and run `lefthook install`;
6. add a stable repository id at `openspec/repo.txt`, create `openspec/adr/` (with a
   `.gitkeep`, so it survives a clone — `spns-archive` writes
   `openspec/adr/NNNN-<slug>.md` and will not create the directory for you), generate its
   index, and run the root-derived `<serpens-sdd> verify-docs`;
6a. copy `templates/testing-stack.md` to that repository's `docs/testing-stack.md` and
   fill it in with the team. FIVE sections, all required: the fast and slow tiers with the
   command that runs each, the wiring boundaries only the slow tier catches, the debugging
   boundary order, and `Manual testing access` — the twelve slots naming what a tester can
   send, produce, query and observe from outside. `spns-tdd`, `spns-debugging`,
   `spns-test-plan` and `spns-autotest` name no framework, transport, store or query language
   of their own; they read this file, so an unanswered one leaves four commands with nothing
   to work from. `<serpens-sdd> verify-docs` fails while any section is missing or any slot
   unanswered, and names each one. Where a slot offers `none`, `none` is a COMPLETE answer —
   "this repository has no such surface" — and it is not the same as leaving the slot blank.
   An answer that is the same across the whole estate belongs in ONE document: name it in the
   `estate-reference` slot and answer `inherit` in every slot it covers, so thirty repositories
   do not each carry a copy that drifts. `inherit` is only accepted while `estate-reference`
   names a document. Keep the slot table at exactly three columns — a fourth column of your own
   puts the answer where the gate cannot find it, so put your notes under the table.
   Keep the `<!-- serpens:section ... -->` comments: they are how the gate finds a section
   whose heading you reworded, and how a later edition appends a new section without touching
   an answer you already wrote;
6b. make that repository's `.gitignore` honest before the first run: build output, language
   caches (`__pycache__/`, `*.py[cod]`, `target/`, `build/`, `node_modules/`) and local-only
   settings belong there. Copy `system-store-template/.gitignore` as a starting point. Untracked
   files never block a gate, but an ignored file is invisible to every gate AND can never be
   staged by accident — which is what you want for a settings file holding a password;
7. declare the store in that repository's `openspec/config.yaml` so a spoke can
   link the shared contract instead of restating it:

   ```yaml
   references:
     - <store-id>
   ```

   Without this block neither fetch route resolves — the lines `spns-spec` writes into
   every cross-repo delta — and `<serpens-sdd> split-brain` exits 0 without checking
   anything, so a pasted contract shape goes unnoticed.

   Declare the remote too, not just the id, when the CLI accepts it:

   ```yaml
   references:
     - id: <store-id>
       remote: <store-clone-url>
   ```

   With the remote present, a machine that has not registered the store gets a pasteable
   `git clone … && openspec store register … --id <store-id>` instead of a bare failure.

   Two routes, never one. A living spec resolves with
   `openspec show <spec-id> --type spec --store <store-id>`, but ONLY after the contract change
   is archived. While that change is open — which is the whole cross-repo window, since the
   contract merges last — the contract exists only inside its change folder and is read with
   `openspec show <change-id> --type change --store <store-id> --json --deltas-only`. Verified
   against the CLI on 2026-08-26: the spec route exits 1 with
   `Spec '<id>' not found at <store>/openspec/specs/<id>/spec.md` before the archive, and the
   change route exits 1 with `Change "<id>" not found` after it. `openspec context` prints only
   the spec recipe, so it cannot be trusted during the open window.

Initialize every submodule's OpenSpec root before invoking generated commands from
inside it. This prevents the parent store root from capturing repository changes.

If one submodule cannot be onboarded, finish the others, leave that repository
un-onboarded rather than half-onboarded, and name it in the handover with the
failing gate and its output. A partial repository is the one state the daily flow
cannot detect.

Append the write-boundary rule to the project instruction file that stage 2 proved
the port reads, in every onboarded repository and in the store:

```markdown
## HARD RULE — disposer self-check
After creating or editing ANY file under openspec/ or docs/, run:
    <serpens-sdd> verify-docs
Fix every ✗ (each error carries a remediation hint) and re-run until green
BEFORE reporting work done or proposing a commit. Rejected writes are corrected
by regenerating the content — never by loosening caps or deleting checks.
CIRCUIT BREAKER: if the same error survives 3 fix attempts, STOP and ask a human —
do not keep looping.
```

One **command** gates all three actors: the agent after a write, the human at
pre-commit through lefthook, and CI as the backstop.

## 6. Install Serpens commands and skills

Copy `skills/spns-*` into the project-scoped skill directory discovered in stage 2.
Copy `commands/spns-*.md` into the discovered command directory. Adapt only the
port wrapper, frontmatter, and `{{args}}` token where required.

Replace every `<openspec>` token in the installed copies with the resolved invocation from
`port-facts.md`, and every `<serpens-sdd>` token with the shim invocation from stage 3/5 — literally
`"$(git rev-parse --show-toplevel)"/tools/serpens-sdd`, the repository's own committed shim, which is
also the exact string stage 5 writes into `lefthook.yml`, so the hooks and the commands can never
disagree. This is the DEFAULT, applied when nothing is configured; a shop that reaches the package
another way sets `serpens_sdd.invocation` in the config file (or `--serpens-sdd-invocation`), and
`resolveCallRoute()` names the fallback routes for a repository with no shim. Never substitute a
bare `serpens-sdd`: it is on PATH only in a global install.
The command bodies must call `new change` and per-artifact `instructions`
during `spns-spec`, `instructions design`/`instructions tasks` during `spns-plan`,
`instructions apply` during `spns-implement`, `validate` and `status` during `spns-review`,
and `archive` during `spns-archive`.

```bash
grep -rnE '<openspec>|<serpens-sdd>' "<installed-command-dir>" "<installed-skill-dir>" && exit 1 || true
```

If skills are unsupported, inline their bodies now and prove no unavailable skill
reference remains. This fallback still installs the complete workflow without
Superpowers.

## 7. Wire the CI backstop

TEMPLATE — adapt to the internal CI and smoke-test it before relying on it. Every
spoke repository runs the same disposer the agent and the hook run. The CI image needs
`@fresh-fx59/serpens-sdd` installed globally, OR the job must call the repository's own
committed shim, `./tools/serpens-sdd` — the same file the `<serpens-sdd>` token already
resolves to — because a fresh checkout has the shim file but no global install
unless one is arranged:

```groovy
stage('docs-disposer') { steps { sh '<serpens-sdd> verify-docs' } }
```

The system store runs the catalog job nightly and on spoke merges:

```groovy
stage('catalog') {
  steps {
    sh '<serpens-sdd> sync-submodules --inventory project-repositories.json --store-root "$(git rev-parse --show-toplevel)"'
    sh '<serpens-sdd> catalog --strict'   // a red repo fails the build, loudly
    sh 'git add catalog.json catalog.md && git diff --cached --quiet || git commit -m "chore(<TICKET>): refresh catalog" && git push'
  }
}
```

Keep contract-test, schema-compatibility, and migration-lint jobs in separate
credential-scoped pipelines; the agent-facing job must not share their credentials.

## 8. Prove hooks and guards

First prove the shim itself resolves — a broken shim invalidates every guard below it:

```bash
<serpens-sdd> version
```

Then run all tools against temporary bad inputs before using a live change:

- a bad OpenSpec root must fail;
- a duplicated shared contract shape must fail the split-brain check;
- a bad branch and mismatched ticket commit must fail naming checks;
- `git config core.hooksPath` must be empty or point to this repository's hooks;
- a deliberate bad temporary commit must be rejected by the installed hook.

Never weaken a guard to make this stage green.

## 9. Final acceptance

After the last edit, prove the shim resolves and run sync again to prove idempotence:

```bash
<serpens-sdd> version                       # the shim resolves; prints the PACKAGE's edition (see below)
<serpens-sdd> sync-submodules --inventory project-repositories.json --store-root "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" status --short --branch
git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule status
```

`<serpens-sdd> version` proves the shim resolves and reports the edition of the package it reaches.
It does NOT prove the shim itself is current: the shim is a two-line `exec` of an absolute path
into the installed package, so a shim written by an older edition prints the same string as a fresh
one. To prove the shim is the one this install wrote, compare its exec target with the package that
is installed now:

```bash
installed_bin=$(node -e 'console.log(require.resolve("@fresh-fx59/serpens-sdd/bin/serpens-sdd.mjs"))' 2>/dev/null \
  || readlink -f "$(command -v serpens-sdd)")
for shim in "$SERPENS_SYSTEM_STORE_ROOT/tools/serpens-sdd" \
    $(git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule --quiet foreach 'echo "$toplevel/$sm_path/tools/serpens-sdd"'); do
  grep -q 'serpens-sdd shim' "$shim" || { echo "✗ $shim is missing or not a generated shim"; continue; }
  grep -qF "$installed_bin" "$shim" || { echo "✗ $shim routes to another install"; continue; }
  printf '%s -> ' "$shim"; "$shim" version
done
```

Also verify each submodule's OpenSpec root, configured base branch, current state,
hooks, docs checks, installed commands, and skills. Commit the store and each
repository separately. Report repository source (`mcp` or `manual`) and paste all
fresh evidence.

Files on disk are not a working install. Invoke one Serpens command inside the port
itself — run `spns-spec` against a throwaway ticket in one onboarded repository,
confirm it reaches the interview and writes `openspec/changes/<id>/proposal.md`,
then delete the branch and the change folder. An install that has never executed a
command in the real port is unproven, whatever the file listing says.

Close the install only when every line holds:

- [ ] store live: sync + `<serpens-sdd> catalog --strict` green in the nightly CI job;
- [ ] each onboarded repository: disposer green in pre-commit and in CI, index and
      `repo.txt` committed;
- [ ] commands and skills installed, no `<openspec>` and no `<serpens-sdd>` token left;
- [ ] `tools/serpens-sdd` exists in the store and in every submodule, and no `tools/*.sh` does;
- [ ] one Serpens command executed end-to-end in the port;
- [ ] named champion per team and a named harness owner who owns the pins, the
      catalog job, and the port re-probes;
- [ ] the exception path written down: any story may skip the flow, with the reason
      recorded in the tracker.
