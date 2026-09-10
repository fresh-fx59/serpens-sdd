# Migration runbook — public `corp-sdd` @ `71de101` → current kit edition

Audience: the installation agent running inside the corporate environment.
You are migrating an installation made from the public repo commit `71de101`
(2026-08-05, `sync-repos: adopt clones that already exist; add a guarded clean-up step`)
to the current Corp SDD kit.

This is **not** `docs/UPGRADE.md`. That runbook assumes the workspace is already a
system store with Git submodules. `71de101` has no store, no submodules, no `VERSION`,
no `UPGRADE.md`; it has `clones/`, `repos.json` and `sync-repos.sh`. Stages 1–6 below
have no runbook anywhere else. From stage 7 onward the shipped `docs/UPGRADE.md` and
`docs/SETUP.md` become the authority and are referenced by stage number.

Rules for the whole run:

- Stop on every failed gate. Do not continue past a red check.
- Never `rm -rf`, `git reset`, `git clean`, `git rebase`, `git checkout -f`, or
  force-push anything in this migration. Nothing here deletes a clone.
- Record every command and its real output in your handover note as you run it,
  not at the end.
- Where a step says "expected output", a different output is a stop.

Placeholders you must resolve before starting, and keep resolved throughout:

| Token | Meaning |
|---|---|
| `<OLD_ROOT>` | the existing `corp-sdd` checkout at `71de101` |
| `<NEW_KIT>` | the unpacked current kit (the directory containing `VERSION` and `MANIFEST.sha256`) |
| `<project-id>` | the corporate project id |
| `<store-remote-url>` | the system-store Git remote |
| `<store-base-branch>` | the store's approved base branch |
| `<pinned-version>` | the pinned `@fission-ai/openspec` version |
| `<TICKET>` | a real tracker key for the migration commits |

---

## Stage 0 — Preflight inventory. Record before touching anything.

### 0.1 Prove the toolchain

```bash
git --version        # >= 2.13 — `submodule add -b` needs it
node --version       # >= 18   — runs the .mjs disposers
lefthook version
npx @fission-ai/openspec@<pinned-version> --version
```

Expected: five version strings. Any miss stops the migration here.
The package is `@fission-ai/openspec`. The bare name `openspec` on the public
registry is an unrelated empty `0.0.0` placeholder and installs nothing usable
(`docs/SETUP.md` §0).

`index-all.sh` additionally needs two **optional** prerequisites: **Universal Ctags**
(`ctags --version` must print `Universal Ctags` — BSD ctags is rejected by brand on purpose,
because `sym:` search dies silently on it) and the **Zoekt** indexer. Skip code search and the
rest of the kit works; neither miss stops the migration.

### 0.2 Name both editions

```bash
export OLD_ROOT="<OLD_ROOT>"
export NEW_KIT="<NEW_KIT>"
test -f "$NEW_KIT/VERSION" && cat "$NEW_KIT/VERSION"
bash "$NEW_KIT/scripts/tools/kit-version.sh" verify
git -C "$OLD_ROOT" rev-parse HEAD
test -f "$OLD_ROOT/VERSION" && echo "UNEXPECTED: old checkout has a VERSION" || echo "old checkout is pre-versioning, as expected"
```

Expected:
- `cat VERSION` prints the new edition (at the time this runbook was written:
  `2026-08-26.7`). Use whatever the file says; do not hardcode it below.
- `kit-version.sh verify` prints `✓ 24 file(s) match <edition>` and exits 0.
  **A kit that fails its own manifest is not a release — re-unpack it and stop.**
- `rev-parse HEAD` prints `71de101…`.
- The last line prints `old checkout is pre-versioning, as expected`.

### 0.3 Record the old layout exactly as it is

`71de101` ships an `en/` and a `ru/` copy of everything. Find which one the
installation uses and where its data lives:

```bash
git -C "$OLD_ROOT" ls-tree -r 71de101 --name-only | sed -n '1,120p'
find "$OLD_ROOT" -maxdepth 3 -name repos.json -not -path '*/node_modules/*'
```

For every `repos.json` found, record it and resolve its clones directory. The old
`sync-repos.sh` does `cd "$(dirname "$0")/.."` first, then reads
`clones_dir` relative to **that** directory:

```bash
export REPOS_JSON="<path printed above>"
export OLD_TOOLS_PARENT="$(cd "$(dirname "$REPOS_JSON")" && pwd -P)"
node -e "console.log(require('$REPOS_JSON').clones_dir)"
export CLONES_DIR="$(cd "$OLD_TOOLS_PARENT/$(node -e "console.log(require('$REPOS_JSON').clones_dir)")" && pwd -P)"
echo "$CLONES_DIR"
ls -1 "$CLONES_DIR"
```

Expected: `clones_dir` prints `../clones` in the shipped example
(`en/config/repos.json.example`); the installation may have changed it. `ls -1`
must list one directory per configured repository.

### 0.4 The pre-migration inventory — this is the step that cannot be redone later

For **every** directory under `$CLONES_DIR`, record all of the following. After
adoption a moved clone looks exactly like one that was always there, so an
unrecorded stash or unpushed branch becomes invisible.

```bash
for d in "$CLONES_DIR"/*; do
  [ -d "$d/.git" ] || { echo "== $d :: NOT A GIT CLONE"; continue; }
  echo "===== $d"
  echo "-- origin:";        git -C "$d" remote -v
  echo "-- HEAD:";          git -C "$d" rev-parse --abbrev-ref HEAD; git -C "$d" rev-parse HEAD
  echo "-- branches:";      git -C "$d" branch -vv
  echo "-- unpushed:";      git -C "$d" log --branches --not --remotes --oneline
  echo "-- worktree:";      git -C "$d" status --porcelain
  echo "-- stashes:";       git -C "$d" stash list
  echo "-- submodules:";    git -C "$d" config -f .gitmodules --get-regexp '^submodule\.' 2>/dev/null || echo none
done 2>&1 | tee ~/corp-sdd-migration-preflight.txt
```

Expected: a block per clone. Paste this whole file into the handover **before**
stage 2. Explicitly flag in the handover:

- any clone whose `-- unpushed:` block is non-empty;
- any clone whose `-- stashes:` block is non-empty;
- any clone with `-- worktree:` output (dirty tree);
- any directory that printed `NOT A GIT CLONE`;
- any clone whose `origin` differs from the URL in `repos.json` — this is the trap
  stage 2 turns on.

### 0.5 Record every hand-edited file in the old install

`71de101` predates `corp-version:` stamps, so `kit-version.sh identify` will report
every old file as `UNSTAMPED`. That verdict tells you nothing there. Use Git instead:

```bash
git -C "$OLD_ROOT" status --porcelain
git -C "$OLD_ROOT" diff 71de101 --stat
git -C "$OLD_ROOT" stash list
git -C "$OLD_ROOT" log --branches --not --remotes --oneline
```

Expected: ideally four empty outputs. Every non-empty line is a local change to the
old kit. For each one, record the file, the diff, and a keep-or-replace decision with
a named human, exactly as `docs/UPGRADE.md` §6 requires. Local changes are not carried
forward automatically by anything below.

Also inventory the currently installed commands and skills, wherever the port keeps
them (you will discover that directory formally in stage 5):

```bash
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify "<current-command-dir>"/corp-*.md || true
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify "<current-skill-dir>"/corp-*/SKILL.md || true
```

Expected on a `71de101` install: every line reads
`UNSTAMPED — predates versioning or is your own copy` and the command exits 1.
That is correct here, not a failure. Record the listing.

### 0.6 Freeze the old install

Do not delete it. Keep `$OLD_ROOT`, `$REPOS_JSON` and `$CLONES_DIR` on disk until the
stage 10 acceptance checklist is green — they are the only rollback for stages 1–6.

---

## Stage 1 — Create the sibling system store

The old layout has no store. Create one now; every later stage writes into it.

```bash
export CORP_SDD_ROOT="$(cd "$NEW_KIT" && git rev-parse --show-toplevel 2>/dev/null || echo "$NEW_KIT")"
export CORP_WORKSPACE_ROOT="$(cd "$CORP_SDD_ROOT/.." && pwd -P)"
export CORP_SYSTEM_STORE_ROOT="${CORP_SYSTEM_STORE_ROOT:-$CORP_WORKSPACE_ROOT/system-store}"
test -d "$CORP_SDD_ROOT/system-store-template"
test "$CORP_SYSTEM_STORE_ROOT" != "$CORP_SDD_ROOT"
```

Expected: both `test` lines exit 0 silently. The store must live **beside** the kit,
never inside it (`docs/SETUP.md` §0).

Ask Git which of the two cases you are in — never guess, never ask the operator:

```bash
git ls-remote --heads "<store-remote-url>" "<store-base-branch>"
```

**Case A — the probe printed a ref.** Another developer already created the store.
Clone it; create nothing:

```bash
test ! -e "$CORP_SYSTEM_STORE_ROOT"
git clone --branch "<store-base-branch>" --single-branch "<store-remote-url>" "$CORP_SYSTEM_STORE_ROOT"
bash "$CORP_SDD_ROOT/scripts/tools/repository-state.sh" prepare-base \
  --repo "$CORP_SYSTEM_STORE_ROOT" --base "<store-base-branch>"
git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch "<store-base-branch>"
```

**Case B — the probe printed nothing** and this is the first install anywhere:

```bash
test ! -e "$CORP_SYSTEM_STORE_ROOT"
cp -R "$CORP_SDD_ROOT/system-store-template" "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" init -b "<store-base-branch>"
git -C "$CORP_SYSTEM_STORE_ROOT" remote add origin "<store-remote-url>"
git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch "<store-base-branch>"
```

Running Case B against a remote that already holds a store creates a second,
unrelated history and costs a rewrite rather than a retry (`docs/SETUP.md` §3).

Verify either case:

```bash
test "$(git -C "$CORP_SYSTEM_STORE_ROOT" rev-parse --show-toplevel)" = "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch
git -C "$CORP_SYSTEM_STORE_ROOT" status --short --branch
```

Expected: the `test` exits 0; `config` prints `<store-base-branch>`; `status` prints
a branch line and a clean or template-only worktree.

Install the store tools now — this is the copy list from `docs/SETUP.md` §3, and it
is identical to `docs/UPGRADE.md` §3:

```bash
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/sync-submodules.sh"            "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/repository-state.sh"           "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/index-all.sh"                  "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/verify-docs.sh"                "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/check-git-naming.sh"           "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/check-openspec-root.sh"        "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/aggregate-index.mjs"           "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/gen-index.mjs"                 "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/corp-lint.mjs"                 "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/check-contract-split-brain.mjs" "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/templates/port-facts.md"                     "$CORP_SYSTEM_STORE_ROOT/port-facts.md"
install -m 0644 "$CORP_SDD_ROOT/templates/conventions-branching.md"          "$CORP_SYSTEM_STORE_ROOT/conventions/branching.md"
```

Note: `port-facts.md` is installed as an **unfilled template** and must be FILLED IN — stage 5.1
probes the real port — **before the stage-12 final verification**. `corp-lint.mjs` now ERRORS on a
`port-facts.md` whose P-rows still hold the placeholder `...`, or whose header still says
`<port name + version> (probed YYYY-MM-DD)`, so an untouched copy fails `verify-docs.sh`.

Note: `sync-repos.sh` from the old kit is **not** in this list and must not be copied.
It is replaced, not upgraded (stage 2).

Verify:

```bash
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh"
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/repository-state.sh"
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify \
  "$CORP_SYSTEM_STORE_ROOT"/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/tools/*.mjs
```

Expected: `bash -n` silent, exit 0; every `identify` line reads
`pristine <new edition>  (kit path scripts/tools/…)` and the command exits 0.

---

## Stage 2 — Adopt `clones/` into submodules, in place, without re-cloning

Nothing in the kit migrates the old clones. Left alone they simply stop being read by
any tool — unpushed branches, stashes and all. This stage moves the real checkouts.

### 2.0 What changes, and why the old command no longer works

Old (`71de101`, `en/scripts/tools/sync-repos.sh`), plain sibling clones, adoption by
directory presence:

```
# --- present: ADOPT it — prove it is the right repo before pulling anything -------------
have=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
```

New (`scripts/tools/sync-submodules.sh`), submodules registered in `.gitmodules`,
and a directory that is *not* registered is a hard stop:

```
  elif [ -e "$STORE_ROOT/$expected_path" ] && [ -z "$registered_path" ]; then
    echo "✗ $name: target exists but is not a registered submodule" >&2
```

That inversion is why the move must be finished with an explicit `git submodule add`
before `sync-submodules.sh` is ever run.

### 2.1 Prove each clone's real origin FIRST

**The trap:** `git submodule add` records the URL you pass on the command line and
never inspects the checkout's own `origin`. A mismatch leaves `.gitmodules` and the
working copy pointing at different remotes, and **no gate in the kit catches it.**
So read the truth off each clone before you type any URL:

```bash
for d in "$CLONES_DIR"/*; do
  [ -d "$d/.git" ] || continue
  printf '%s\t%s\n' "$(basename "$d")" "$(git -C "$d" remote get-url origin)"
done
```

Expected: one `name<TAB>url` line per clone. Compare each line against `repos.json`:

```bash
node -e "const c=require('$REPOS_JSON');for(const r of c.repos)console.log(r.name+'\t'+r.url)"
```

Expected: the two listings agree, name for name. For any disagreement, stop and decide
with a named human **which URL is correct** before proceeding. The URL you carry into
step 2.3 is the one you decided is correct — and if the clone's `origin` is the wrong
one, fix the clone first:

```bash
git -C "$CLONES_DIR/<name>" remote set-url origin "<correct-url>"
git -C "$CLONES_DIR/<name>" remote get-url origin
```

### 2.2 Move the checkouts — `mv`, never copy, never re-clone

```bash
mkdir -p "$CORP_SYSTEM_STORE_ROOT/submodules"
mv "$CLONES_DIR/<name>" "$CORP_SYSTEM_STORE_ROOT/submodules/<name>"
test -d "$CORP_SYSTEM_STORE_ROOT/submodules/<name>/.git"
```

Expected: the `test` exits 0. Repeat per repository. The whole-directory variant
(`mv "$CLONES_DIR" "$CORP_SYSTEM_STORE_ROOT/submodules"`) is equivalent and also
verified, provided `$CLONES_DIR` contains nothing but the clones.

### 2.3 Register each moved checkout as a submodule

Run from the store root, once per repository, with the branch each repository is
based on:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule add --name "<name>" -b "<base-branch>" \
  "<url>" "submodules/<name>"
```

Expected output line:

```
Adding existing repo at 'submodules/<name>' to the index
```

That message is the proof of adoption: no network round-trip, no second clone.
If instead Git starts cloning, the directory was not moved into place — stop.

`--name "<name>"` is not optional: it pins the `.gitmodules` section name to the
repository name, which is the id `sync-submodules.sh`, `.gitmodules` and the catalog
all key on.

### 2.4 Prove nothing was lost

For each adopted repository, diff against the stage-0.4 record:

```bash
d="$CORP_SYSTEM_STORE_ROOT/submodules/<name>"
git -C "$d" remote -v
git -C "$d" branch -vv
git -C "$d" log --branches --not --remotes --oneline
git -C "$d" stash list
git -C "$d" status --porcelain
```

Expected: byte-for-byte the same branches, unpushed commits, stashes and dirty files
that `~/corp-sdd-migration-preflight.txt` recorded for that clone. Any difference is a
stop.

Then prove the registration and the URL agreement:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" config -f .gitmodules --get-regexp '^submodule\.'
git -C "$CORP_SYSTEM_STORE_ROOT" submodule status
```

Expected: for every repository, a `submodule.<name>.path = submodules/<name>`,
a `submodule.<name>.url` equal to the checkout's real `origin`, and a
`submodule.<name>.branch` equal to its base branch. `submodule status` lists every
repository with a commit SHA and no leading `-` (uninitialized) or `+` (pointer
mismatch you did not intend).

Cross-check each recorded URL against the live checkout one final time — this is the
only check that catches the 2.1 trap after the fact:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet \
  'echo "$name  gitmodules=$(git -C "$toplevel" config -f .gitmodules --get submodule.$name.url)  origin=$(git remote get-url origin)"'
```

Expected: `gitmodules=` and `origin=` are the same repository on every line.

### 2.5 Leave the old directory alone

Do not delete `$CLONES_DIR`. After 2.2 it is empty or holds only things that were
never in `repos.json` — and those are exactly where someone's only copy of a branch
can be hiding. Record what remains in the handover and hand the decision to a human.

---

## Stage 3 — `repos.json` → `project-repositories.json`

Old (`71de101`, `en/config/repos.json.example`), verbatim:

```json
{
  "clones_dir": "../clones",
  "repos": [
    {
      "name": "pilot-repo-a",
      "url": "ssh://git@your-forge/org/pilot-repo-a.git"
    },
    {
      "name": "pilot-repo-b",
      "url": "ssh://git@your-forge/org/pilot-repo-b.git"
    }
  ]
}
```

New (`config/project-repositories.json.example`), verbatim:

```json
{
  "schema_version": 1,
  "project": "<project-id>",
  "repository_source": "manual",
  "repositories": [
    {
      "name": "<repository-name>",
      "url": "ssh://git@<forge>/<project>/<repository>.git",
      "base_branch": "develop"
    }
  ]
}
```

Field by field:

| Old field | New field | Conversion |
|---|---|---|
| `clones_dir` | *(none)* | **Dropped.** The location is fixed: `submodules/<name>` under the store root. `sync-submodules.sh` computes `expected_path="submodules/$name"` and rejects any other registered path. |
| *(none)* | `schema_version` | **Required, must be the integer `1`.** `sync-submodules.sh` exits 2 on anything else: `✗ inventory requires schema_version 1 and a non-empty project`. |
| *(none)* | `project` | **Required, non-empty string.** Set it to `<project-id>`. |
| *(none)* | `repository_source` | Set to `"mcp"` if you produced the list from a project-binding MCP tool, `"manual"` if you converted `repos.json` by hand. A hand conversion of `71de101` is `"manual"` unless you re-derive it from MCP in stage 3.3. |
| `repos[]` | `repositories[]` | Renamed array. |
| `repos[].name` | `repositories[].name` | Unchanged, but now validated against `/^[a-z0-9][a-z0-9._-]*$/` and required unique. |
| `repos[].url` | `repositories[].url` | Unchanged, but now required non-empty and must contain no whitespace. |
| *(none)* | `repositories[].base_branch` | **Required, new, and there is no default.** Must pass `git check-ref-format --branch`. |

### 3.1 Fill `base_branch` from the remote, not from the checkout

Never infer the base from whatever branch the clone happens to sit on
(`docs/SETUP.md` §1). Per repository, prefer `develop` when that remote branch
exists, otherwise the remote symbolic default:

```bash
d="$CORP_SYSTEM_STORE_ROOT/submodules/<name>"
git -C "$d" ls-remote --heads origin develop
git -C "$d" remote show origin | sed -n 's/.*HEAD branch: //p'
```

Expected: the first prints a ref if `develop` exists; the second prints the default
branch name. Use `develop` when present, otherwise the printed default.

### 3.2 Write the file

Place it at the store root, at the exact path every tool and CI job expects:

```bash
cat > "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" <<'JSON'
{
  "schema_version": 1,
  "project": "<project-id>",
  "repository_source": "manual",
  "repositories": [
    {"name": "<name>", "url": "<url>", "base_branch": "<base-branch>"}
  ]
}
JSON
node -e "JSON.parse(require('fs').readFileSync('$CORP_SYSTEM_STORE_ROOT/project-repositories.json','utf8'))" && echo "valid JSON"
```

Expected: `valid JSON`.

### 3.3 Optional — re-derive from MCP instead of converting by hand

Enumerate the available MCP tools; if a project-binding tool exists, call it with
`<project-id>`, include only repositories bound to that project, and normalize its
result into the same schema with `"repository_source": "mcp"`. Report which source
you used. Either path is acceptable; the file shape is identical.

### 3.4 Prove the inventory reconciles against the adopted submodules

```bash
bash "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh" \
  --inventory "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$CORP_SYSTEM_STORE_ROOT"
```

Expected: one `✓ <name> (registered)` line per adopted repository, then
`✓ reconciled <N> project-bound submodule(s) in <store>/submodules`, exit 0.

Failure modes and what they mean:

- `✗ <name>: target exists but is not a registered submodule` — stage 2.3 was not run
  for that repository. Go back and run `submodule add`.
- `✗ <name>: registered URL does not match project inventory` — `.gitmodules` and
  `project-repositories.json` disagree. Resolve with a human; do not edit blindly.
- `✗ <name>: registered path is '<x>', expected 'submodules/<name>'` — the checkout is
  in the wrong place. Move it.
- `⚠ orphaned submodule binding: <name> (<path>) — absent from inventory; preserved` —
  a repository registered but not listed. It is never deleted. Confirm its project
  binding before touching it.

Then confirm idempotence:

```bash
bash "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh" \
  --inventory "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" diff -- .gitmodules
```

Expected: identical output to the first run, and an **empty** `.gitmodules` diff.

Finally, delete the obsolete config so nothing reads it again — but only after the
above is green, and record it in the handover:

```bash
git -C "$OLD_ROOT" mv "$REPOS_JSON" "$REPOS_JSON.superseded" 2>/dev/null \
  || mv "$REPOS_JSON" "$REPOS_JSON.superseded"
```

Expected: the file is renamed, not removed.

---

## Stage 4 — Gate every repository before the first copy

Each repository below is a separate Git repository, committed separately, so each is
gated separately (`docs/UPGRADE.md` §1):

```bash
bash "$CORP_SDD_ROOT/scripts/tools/repository-state.sh" prepare-base \
  --repo "$CORP_SYSTEM_STORE_ROOT" --base "$(git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch)"
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      bash "$CORP_SDD_ROOT/scripts/tools/repository-state.sh" prepare-base --repo "$repo"
    done
```

Expected: a state block per repository and exit 0 for each. The gate refuses dirty
worktrees, detached HEAD, unpushed commits on the base branch, wrong upstreams, and
divergence; it only performs a verified fast-forward. It never resets, cleans,
rebases, deletes a branch or touches a stash. A stash and commits on *other* local
branches are reported as warnings, not blocks — only `assert-archivable` treats a
stash as a hard stop.

Resolve every stop with the owner of that work. A repository that cannot be gated is
**skipped whole** and named in the handover with the failing gate and its output. A
half-migrated repository is the one state the daily flow cannot detect.

Do not create a shared "migration" branch across repositories. Each repository gets
its own commit on its own base.

---

## Stage 5 — Discover the agent home; never name it

The kit names no agent-home directory, no slash command and no MCP tool, on purpose:
the same kit installs onto ports whose homes and instruction files are called
different things (`docs/SETUP.md` §2).

### 5.1 Discover it

Probe the real port and record the answers in the store's `port-facts.md`
(installed in stage 1 from `templates/port-facts.md`):

1. configuration directory and project instruction filename;
2. command directory, file format, invocation syntax, and argument token;
3. skill directory, and whether project-scoped skills load automatically;
4. the exact OpenSpec CLI invocation, **proven by running it** (stage 6);
5. MCP tool names for project repository bindings, tracker, wiki, and code search;
6. hook support, context limits, and agent version.

To find the home mechanically, initialize OpenSpec once in a temporary directory with
the pinned internal package and inspect which dot-directory it generates files into.

### 5.2 Make the discovery machine-readable

Two of those facts are read back by tooling, so they must be recorded where the
machine looks, not only in prose. Per repository, including the store:

```bash
git -C "<repo>" config corp.agentDir "<the agent home you found, e.g. .acme>"
git -C "<repo>" config --get corp.agentDir
```

Expected: the second line echoes the directory you set.

`corp-lint.mjs` resolves the agent home in this order, and the header of the file
states it verbatim:

```
// it is CORP_AGENT_DIR, else `git config corp.agentDir`, else the one dot-directory at the
// repository root that contains a `skills/` subdirectory.
```

If more than one root dot-directory contains `skills/`, the lint **exits 1 rather than
guess** and prints:

```
   ↳ set CORP_AGENT_DIR or `git config corp.agentDir <dir>` so the lint knows which one to read
```

`CORP_AGENT_DIR` in the environment overrides the Git config; use the Git config for
the durable answer so a fresh shell is still correct.

The port's project instruction file — the `AGENTS.md` analogue, whatever this port
calls it — needs no configuration: the lint picks up every ALL-CAPS `.md` at the
repository root except README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY,
CODE_OF_CONDUCT and NOTICE. Record both names in `port-facts.md`.

Note on the old install: `71de101`'s `corp-lint.mjs` hard-coded `.qwen/`. If your port
is not `.qwen`, the old lint's agent-directory rule and its 250-line skill cap were
passing **vacuously** on your install. Expect the new lint to report skill-file length
errors that the old one never raised — but only for `corp-*` skills: the cap regex is
`<agent-dir>/skills/corp-[^/]+/…`, so a port's own skills shipped under the same
directory (two of them exceed 300 lines on a stock `openspec init`) are exempt, because
capping a file this kit neither writes nor may edit turns a fresh install red with no
sanctioned fix. Regenerate the content of a `corp-*` skill; never raise the cap.

### 5.3 Ids are a contract

Use `<project-id>-store` for `<store-id>` and the stage-3 repository name for each
repository id, both lower-case kebab-case, and record both in `port-facts.md`. A
migration never renames an id that is already in use — cross-repo links resolve by id
and would break silently.

---

## Stage 6 — Resolve `<openspec>` and prove the six calls

The installed commands call the OpenSpec **CLI**, never a generated slash command.
Slash commands differ between versions and profiles — OpenSpec 1.10's core profile
ships `propose, explore, apply, update, sync, archive` and has no `new`, `continue` or
`verify` at all. The six CLI calls below are stable and machine-readable.

The kit ships exactly **one** token, spelled `<openspec>`. Resolve it to whatever runs
on this machine — for example `npx @fission-ai/openspec@<pinned-version>`, or an
internal wrapper on `PATH`.

Prove all six, in a throwaway repository with OpenSpec initialized:

```bash
export OPENSPEC="npx @fission-ai/openspec@<pinned-version>"   # or your resolved invocation
$OPENSPEC new change corp-probe
$OPENSPEC status --change corp-probe --json
$OPENSPEC instructions proposal --change corp-probe --json
$OPENSPEC instructions apply --change corp-probe --json
$OPENSPEC validate corp-probe --type change --strict --json
$OPENSPEC archive --help
```

Expected:
- `new change` creates `openspec/changes/corp-probe/`;
- `status --json` prints JSON listing the artifact ids with their paths and state;
- each `instructions … --json` prints JSON containing the guidance and the exact
  output path for that artifact;
- `validate … --json` prints JSON with a `valid` field;
- `archive --help` prints usage and exits 0.

Delete the probe change afterwards. Record the resolved token and all six proven
calls in `port-facts.md`. Which command uses which:

| Command | CLI calls it must contain after resolution |
|---|---|
| `corp-spec` | `new change`, `instructions proposal`, `instructions specs`, `validate --type change --strict --json` |
| `corp-plan` | `instructions design`, `instructions tasks` |
| `corp-implement` | `instructions apply` |
| `corp-review` | `validate`, `status` |
| `corp-archive` | `validate --type change --strict --json`, `archive <change-id> --yes --json` |

---

## Stage 7 — Install the new tools into every repository

Each onboarded repository carries seven spoke tools. Copy them from the store's
freshly updated `tools/`, one repository at a time, skipping any repository stage 4
could not gate:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      mkdir -p "$repo/tools"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/repository-state.sh"            "$repo/tools/"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/verify-docs.sh"                 "$repo/tools/"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/check-openspec-root.sh"         "$repo/tools/"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/check-git-naming.sh"            "$repo/tools/"
      install -m 0644 "$CORP_SYSTEM_STORE_ROOT/tools/corp-lint.mjs"                  "$repo/tools/"
      install -m 0644 "$CORP_SYSTEM_STORE_ROOT/tools/gen-index.mjs"                  "$repo/tools/"
      install -m 0644 "$CORP_SYSTEM_STORE_ROOT/tools/check-contract-split-brain.mjs" "$repo/tools/"
      bash -n "$repo/tools/verify-docs.sh"
    done
```

`aggregate-index.mjs`, `index-all.sh` and `sync-submodules.sh` are **store-only**. A
spoke that grows them starts maintaining a second repository list.

Delete the old `sync-repos.sh` wherever the old install left a copy — it is replaced,
not upgraded:

```bash
find "$CORP_SYSTEM_STORE_ROOT" "$CORP_SYSTEM_STORE_ROOT"/submodules -maxdepth 3 -name sync-repos.sh
```

Expected: no output. If a copy exists, `git rm` it in that repository and record it.

Per-repository OpenSpec and hooks (`docs/SETUP.md` §5), for each submodule:

1. initialize OpenSpec in that repository with the pinned package and discovered port;
2. run `bash "$repo/tools/check-openspec-root.sh"` and prove the reported root is that
   submodule, not the store. Expected: the printed root equals `$repo`. This matters
   here more than in a fresh install: OpenSpec walks up past `.git`, and the new layout
   puts every repository *inside* a store that has its own `openspec/`;
3. add a stable repository id at `openspec/repo.txt` (the stage-3 repository name), and create
   `openspec/adr/` with a `.gitkeep` so it survives a clone — `corp-archive` writes
   `openspec/adr/NNNN-<slug>.md` and will not create the directory for you;
4. copy `config/lefthook.yml.example` to `lefthook.yml`, install lefthook through the
   approved internal channel, then run `lefthook install` in that repository;
5. declare the store in `openspec/config.yaml`:

   ```yaml
   references:
     - <store-id>
   ```

   Without this block neither fetch route resolves — the lines `corp-spec` writes into
   every cross-repo delta — and `check-contract-split-brain.mjs` exits 0 without checking
   anything, so a pasted contract shape goes unnoticed. **Two routes, never one**, because
   the store contract merges LAST: while its change is open the contract exists only inside
   its change folder, and archiving it deletes that folder the moment the spec route starts
   working. Every spoke delta carries BOTH, labelled:

   ```text
   while the contract change is open:
     <openspec> show <contract-change-id> --type change --store <store-id> --json --deltas-only
   after the contract change is archived:
     <openspec> show <contract-spec-id> --type spec --store <store-id>
   which window am I in: <openspec> list --specs --store <store-id> — the spec id absent means open
   if the CLI refuses (a broken contract proposal, an unregistered store), read the file:
     <openspec> instructions specs --change <contract-change-id> --store <store-id> --json  # prints changeDir
     cat <changeDir>/specs/<contract-spec-id>/spec.md
   ```

   Measured against the CLI on 2026-08-26: the spec route exits 1 with
   `Spec '<id>' not found at <store>/openspec/specs/<id>/spec.md` before the archive, and the
   change route exits 1 with `Change "<id>" not found` after it. `--json` is mandatory on the
   change route: without it the CLI prints proposal.md only, omits the delta silently and
   still exits 0. `openspec context` prints only the spec recipe, so it cannot be trusted
   during the open window;
6. generate the index: `node "$repo/tools/gen-index.mjs"`.

Append the write-boundary rule to the project instruction file that stage 5 proved the
port reads, in every onboarded repository and in the store:

```markdown
## HARD RULE — disposer self-check
After creating or editing ANY file under openspec/ or docs/, run:
    bash "$(git rev-parse --show-toplevel)/tools/verify-docs.sh"
Fix every ✗ (each error carries a remediation hint) and re-run until green
BEFORE reporting work done or proposing a commit. Rejected writes are corrected
by regenerating the content — never by loosening caps or deleting checks.
CIRCUIT BREAKER: if the same error survives 3 fix attempts, STOP and ask a human —
do not keep looping.
```

Verify the stage:

```bash
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify \
  "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.mjs
```

Expected: every line `pristine <new edition>`, exit 0.

---

## Stage 8 — Install commands, skills, templates and config into the agent home

### 8.1 Copy

Copy `skills/corp-*` into the project-scoped skill directory recorded in
`port-facts.md`, and `commands/corp-*.md` into the recorded command directory. Adapt
only the port wrapper, the frontmatter, and the `{{args}}` token.

The new kit ships **six** skills; `71de101` shipped five. `corp-repository-state` is
new and has no old counterpart:

```
corp-code-review  corp-debugging  corp-drill-down
corp-repository-state (NEW)  corp-tdd  corp-verification
```

Copy the templates the commands reference into the store:

```bash
install -m 0644 "$CORP_SDD_ROOT/templates/adr.md"            "$CORP_SYSTEM_STORE_ROOT/templates/adr.md"
install -m 0644 "$CORP_SDD_ROOT/templates/research.md"       "$CORP_SYSTEM_STORE_ROOT/templates/research.md"
install -m 0644 "$CORP_SDD_ROOT/templates/store-contract.md" "$CORP_SYSTEM_STORE_ROOT/templates/store-contract.md"
```

(`adr.md`, `conventions-branching.md` and `research.md` are byte-identical to
`71de101`; `port-facts.md` and `store-contract.md` changed and were already installed
in stage 1 / are installed here.)

### 8.2 Resolve every `<openspec>` token — mandatory, not optional

A fresh command file ships **unresolved** placeholders. Replace every `<openspec>`
token in the installed copies with the invocation you proved in stage 6. Then gate it:

```bash
grep -rn '<openspec>' "<installed-command-dir>" && exit 1 || true
grep -rn '<openspec>' "<installed-skill-dir>"   && exit 1 || true
```

Expected: no matches. A non-empty result means the migration left a command that
cannot run.

Also prove the old vocabulary is gone. `71de101`'s `corp-archive` says:

```
1. Run the OpenSpec archive step (opsx archive) — delta folds into openspec/specs/.
```

and `corp-spec` step 3 says "via the opsx workflow". Neither string may survive:

```bash
grep -rn 'opsx' "<installed-command-dir>" "<installed-skill-dir>" && exit 1 || true
```

Expected: no matches.

### 8.3 If the port has no skill mechanism

Inline each referenced skill body into the installed command and remove its
`Follow skill …` sentence, then prove no unavailable skill reference remains. This
fallback installs the complete workflow without upstream Superpowers, which is not
required by this kit.

### 8.4 Behaviour changes to announce to the team

These are command semantics that changed between `71de101` and the current edition.
They break muscle memory, not files:

- **`corp-plan` now gates the branch.** New step 0:
  `bash "$REPO_ROOT/tools/repository-state.sh" assert-change <TICKET> --checkout`,
  **without** `--allow-dirty`. A dirty worktree now stops planning. Old `corp-plan`
  had no step 0 at all.
- **`corp-archive` changed argument form, placement, gate and commit message.**
  Old: `Precondition: … you are on updated main` and
  `5. Commit ("archive <change-id>: living spec + ADR + index")`.
  New: `{{args}}` is `<change-id> [--here | --branch <name>]`, the default cuts a fresh
  **unsuffixed** `feature/<TICKET>` from the prepared base — the merge usually deleted the
  story branch, so the name is free. It carries no suffix because `check-git-naming.sh`
  accepts `^feature/ABCD-1234$` and nothing else: `feature/ABCD-1234-archive` fails the
  pre-push guard and the push is rejected. Every mode runs
  `assert-archivable`, and the commit message is
  `docs(<TICKET>): archive {{args}} living spec and ADR`. The old
  `archive <id>: …` subject is now **rejected** by `check-git-naming.sh`.
- **`corp-plan` and `corp-spec` now commit by path.** `git add <path>`; never
  `git add -A`, `git add .` or `git commit -a`.
- **`corp-test-plan` is a rewrite** (11 → 71 lines) and is now black-box: the request
  or asynchronous message to send, the expected response, and the expected database rows on the
  dev stand — posted as a comment on the same ticket, never as a separate test task.
- **`index-all.sh` moved its default Zoekt index directory** to
  `${CORP_ZOEKT_INDEX_DIR:-$STORE_ROOT/.cache/zoekt/index}`. Re-point any cron or CI
  job that hardcoded the old path.

---

## Stage 9 — Install `templates/` and fill in `docs/testing-stack.md` in every repository

This file is new in the current kit and has no counterpart in `71de101`. It is not
optional: `corp-tdd` and `corp-debugging` name no framework of their own — they read
this file, so an empty one leaves both skills without a stack. The same loop installs the
templates the commands cite BY PATH — `docs/SETUP.md` §5 step 4 now copies `adr.md`
(`corp-archive`), `research.md` and `testing-stack.md` into every repository's `templates/`,
and `docs/UPGRADE.md` stage 4a does the same on an upgrade. A command that names a template
the repository does not have is a dead instruction.

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      mkdir -p "$repo/docs" "$repo/templates"
      install -m 0644 "$CORP_SDD_ROOT/templates/adr.md"           "$repo/templates/"
      install -m 0644 "$CORP_SDD_ROOT/templates/research.md"      "$repo/templates/"
      install -m 0644 "$CORP_SDD_ROOT/templates/testing-stack.md" "$repo/templates/"
      test -f "$repo/docs/testing-stack.md" \
        || install -m 0644 "$CORP_SDD_ROOT/templates/testing-stack.md" "$repo/docs/testing-stack.md"
    done
```

Expected: `adr.md`, `research.md` and `testing-stack.md` in every repository's `templates/`,
and a `docs/testing-stack.md` in every repository; an existing one is never overwritten.

Fill each one in **with the team**, from what the build actually runs — not from what
the team intends to use. The template has four sections, and every one must be
answered:

1. **FAST tier** table — per component: what a fast test is here, and the command that
   runs *only* those. Must stay in seconds; `corp-tdd` runs it after every green step.
2. **SLOW tier** table — per component: what a slow test is here, and the command that
   runs *only* those. Run at task boundaries and before the PR, never inside the
   micro-loop.
3. **Wiring bugs** — name the boundaries in this stack that ONLY the slow tier catches
   (dependency injection, serialization, configuration profiles). A task touching one
   of them is not done on fast-tier green alone.
4. **Debugging boundary order** — the chain `corp-debugging` walks from symptom to
   cause, innermost first: failing unit → its direct inputs → serialization/config
   boundaries → stored state → upstream systems, with the concrete technologies named
   at each step.

Also set the header date: `# Testing stack — <repository name> (recorded YYYY-MM-DD)`.

Verify per repository:

```bash
grep -n '^| \.\.\. ' "$repo/docs/testing-stack.md" && echo "UNFILLED PLACEHOLDER ROWS" || echo "no placeholder rows"
grep -c 'YYYY-MM-DD' "$repo/docs/testing-stack.md"
bash "$repo/tools/verify-docs.sh"
```

Expected: `no placeholder rows`; `0` for the date grep; `verify-docs.sh` green.
An entry nobody can run is worse than an empty line — paste the real command output
for one fast-tier and one slow-tier command per repository into the handover.

---

## Stage 9b — Give every repository an honest `.gitignore`

`docs/SETUP.md` §5 step 6b is also new: before the first run, each repository's
`.gitignore` must cover build output, language caches (`__pycache__/`, `*.py[cod]`,
`target/`, `build/`, `node_modules/`) and local-only settings.
`system-store-template/.gitignore` is the starting point. Untracked files never block a
gate, but an ignored file is invisible to every gate AND can never be staged by accident —
which is exactly what you want for a settings file holding a password.

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      test -f "$repo/.gitignore" \
        || install -m 0644 "$CORP_SDD_ROOT/system-store-template/.gitignore" "$repo/.gitignore"
    done
```

Expected: a `.gitignore` in every repository. Merge into an existing one — never replace
it, and never let this step drop a rule the team already relies on.

---

## Stage 10 — Fix in-flight delta specs

Any change folder that existed before the migration was written against the old
`corp-lint.mjs` delta rule. The authority moved: the new lint deliberately dropped the
four checks OpenSpec itself makes, and the CLI is now the grammar authority. Some
specs that pass today will fail.

Find them:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      ls -1 "$repo/openspec/changes" 2>/dev/null | grep -v '^archive$' | while read -r id; do
        echo "== $repo :: $id"
        ( cd "$repo" && $OPENSPEC validate "$id" --type change --strict --json )
      done
    done
```

Expected end state: `"valid": true` for every change. Fix each failure at its cause:

| Symptom | Cause | Fix |
|---|---|---|
| lint: `heading "### <x>" (line N) is not a requirement heading` | a `### ` heading that is not `### Requirement:` | Use `### Requirement: <text>` **verbatim**. Upstream logs INFO only, keeps `valid: true`, and silently **drops that requirement from the deltas** — it never reaches the living spec. Only the `<text>` may be Russian. |
| lint: `requirement "<x>" (line N) sits outside a delta section` | requirement above the first `## ADDED\|MODIFIED\|REMOVED\|RENAMED Requirements` | Move it under a delta section. Upstream drops it silently with `valid=true`; this error is the only thing between you and a lost requirement. |
| lint: `no "## Why" section` (proposal.md) | the proposal carries no literal `## Why` heading | Add one. Without it the change route every cross-repo spoke uses — `<openspec> show <change-id> --type change --store <store-id> --json --deltas-only` — fails with `{"code":"show_error","message":"Change must have a Why section"}` while `validate --strict` still reports `"valid": true`. No flag bypasses it. New hard error in `corp-lint.mjs` (check 4b); old proposals written without it now go red. |
| lint: `no "## What Changes" section` (proposal.md) | the proposal carries no literal `## What Changes` heading | Add one beside `## Why` — the schema expects the pair. New hard error in `corp-lint.mjs` (check 4b). |
| CLI: missing delta section / no requirement in a delta section | no `## ADDED Requirements` etc. | Add the section header. `DELTA_SECTION` is `/^##\s+(ADDED\|MODIFIED\|REMOVED\|RENAMED)\s+Requirements\s*$/im`. |
| CLI: ADDED/MODIFIED requirement with no scenario | no level-4 heading under it | Add at least one. Any `####` heading counts, including `#### Сценарий: …`. |
| lint: `MODIFIED targets capability "<id>", which has no living spec` | a `MODIFIED`/`REMOVED`/`RENAMED` delta whose capability has no `openspec/specs/<id>/spec.md` | Use `## ADDED Requirements` for a capability that has no living spec yet, or fix the capability directory name. `validate --strict` reports `"valid": true` here; `openspec archive` then fails post-merge with `archive_spec_update_failed: "<id>: target spec does not exist; only ADDED requirements are allowed for new specs. MODIFIED and RENAMED operations require an existing spec."` New hard error in `corp-lint.mjs`. |
| lint warning: `requirement "<x>" states no SHALL/MUST` | normative verb missing | Put SHALL or MUST in the requirement text. |
| lint warning: `requirement "<x>" names no observable surface` | nothing a black-box tester can send or observe | Name the endpoint, topic, table, status code or query in a scenario. A requirement checkable only from inside belongs to `corp-autotest`, not `corp-test-plan`. |

The structure keywords stay English — `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`
and `### Requirement:` — because OpenSpec hard-codes them. Requirement text and
scenario headings may be Russian.

Never fix a red check by weakening it. Caps reject, never trim: regenerate the
content.

Per repository, both gates must be green together:

```bash
bash "$repo/tools/verify-docs.sh"
( cd "$repo" && $OPENSPEC validate "<change-id>" --type change --strict --json )
```

---

## Stage 11 — Prove the guards

New tool bytes mean the guards are unproven. Run each against a **temporary bad
input**, in the store and in one representative spoke (`docs/SETUP.md` §8):

1. a bad OpenSpec root must fail `check-openspec-root.sh`;
2. a duplicated shared contract shape must fail `check-contract-split-brain.mjs`;
3. a bad branch name and a mismatched ticket commit must fail `check-git-naming.sh`;
4. `git -C "<repo>" config core.hooksPath` must be empty or point at that
   repository's hooks;
5. a deliberate bad temporary commit must be rejected by the installed lefthook hook;
6. a repository that does not own its own OpenSpec root must be refused by every
   asserting mode of `repository-state.sh` — `prepare-base`, `assert-change` and
   `assert-archivable` — with `✗ OpenSpec root is not this repository` followed by
   `  ↳ resolved root: <path>`. `inspect` stays non-fatal: it only prints the new
   `openspec_root=` line, so a not-yet-onboarded repository can still be looked at;
7. the bad branch name of item 3 must be refused at **pre-commit**, not only at
   pre-push. `config/lefthook.yml.example` runs `check-git-naming.sh --branch` at both,
   because lefthook skips a pre-push command when the push carries no files it can list
   — exactly the push that publishes a brand-new branch, the first time the name
   matters. A commit always has staged files, so the pre-commit copy cannot be skipped.

Expected: every one of the seven is **red** (item 6 red in the asserting modes only).
A green negative test means the guard is not wired. Never weaken a guard to make this
stage pass.

---

## Stage 12 — Final verification checklist

Run every line and paste the real output into the handover.

```bash
# 1. the kit you installed from is intact
bash "$NEW_KIT/scripts/tools/kit-version.sh" show
bash "$NEW_KIT/scripts/tools/kit-version.sh" verify
```
Expected: the edition string; then `✓ 24 file(s) match <edition>`, exit 0.

```bash
# 2. every installed file is pristine at the new edition
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify \
  "$CORP_SYSTEM_STORE_ROOT"/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/tools/*.mjs \
  "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.mjs \
  "<installed-command-dir>"/corp-*.md
```
Expected: every tool line reads `pristine <edition>  (kit path scripts/tools/…)`,
exit 0.
**The command files are the exception:** after stage 8.2 resolved `<openspec>` they
are edited by design and will report
`stamped <edition> but MODIFIED (bytes not in this kit edition)`. That is the correct
result for a resolved command; note it in the handover so the next upgrade does not
re-litigate it. A command that reports `pristine` still contains an unresolved token —
go back to stage 8.2.

```bash
# 3. the disposer is green everywhere
bash "$CORP_SYSTEM_STORE_ROOT/tools/verify-docs.sh"
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do echo "== $repo"; bash "$repo/tools/verify-docs.sh"; done
```
Expected: no `✗` lines anywhere, exit 0 for each. `verify-docs.sh` composes
`gen-index.mjs --check`, `corp-lint.mjs` and `check-contract-split-brain.mjs`; each
error carries a remediation hint. Note that `--check` reports index drift and writes
nothing — if it reports drift, run `node "$repo/tools/gen-index.mjs"` and re-run.

```bash
# 4. every in-flight change validates
( cd "<repo>" && $OPENSPEC validate "<change-id>" --type change --strict --json )
```
Expected: JSON with `"valid": true` for every change in every repository.

```bash
# 5. the submodule layer is stable and idempotent
bash "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh" \
  --inventory "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" diff -- .gitmodules
git -C "$CORP_SYSTEM_STORE_ROOT" submodule status
node "$CORP_SYSTEM_STORE_ROOT/tools/aggregate-index.mjs" --strict "$CORP_SYSTEM_STORE_ROOT"
```
Expected: `✓ <name> (registered)` per repository plus
`✓ reconciled <N> project-bound submodule(s) …`; an **empty** `.gitmodules` diff;
one clean `submodule status` line per repository; `aggregate-index --strict` exit 0
(a red repository fails it loudly).

```bash
# 6. no token, no old vocabulary, no old script
grep -rn '<openspec>' "<installed-command-dir>" "<installed-skill-dir>"; echo "rc=$?"
grep -rn 'opsx' "<installed-command-dir>" "<installed-skill-dir>"; echo "rc=$?"
find "$CORP_SYSTEM_STORE_ROOT" -name sync-repos.sh
find "$CORP_SYSTEM_STORE_ROOT" -name repos.json
```
Expected: `rc=1` (no matches) for both `grep` calls; no output from either `find`.

```bash
# 7. syntax
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh"
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/repository-state.sh"
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/verify-docs.sh"
```
Expected: silent, exit 0 for each.

```bash
# 8. one real command in the real port
```
Files on disk are not a working install. Run `corp-spec` against a throwaway ticket in
one onboarded repository, confirm it reaches the interview and writes
`openspec/changes/<id>/proposal.md`, then delete the branch and the change folder. A
migration that has never executed a command in the real port is unproven, whatever
`identify` prints.

### Commit

One commit per Git repository, each revertible on its own:

```bash
git -C "<repo>" add tools/ docs/testing-stack.md openspec/
git -C "<repo>" commit -m "chore(<TICKET>): corp-sdd migration 71de101 -> <new edition>"
git -C "$CORP_SYSTEM_STORE_ROOT" add tools/ conventions/ templates/ project-repositories.json .gitmodules submodules
git -C "$CORP_SYSTEM_STORE_ROOT" commit -m "chore(<TICKET>): adopt clones as submodules; corp-sdd <new edition>"
```

Stage by path. Never `git add -A`: these repositories legitimately hold local-only
settings, credential and scratch files. Record every commit SHA in the handover.

### Close the migration only when every line holds

- [ ] `~/corp-sdd-migration-preflight.txt` — the pre-migration clone inventory — is in
      the handover, with unpushed / stashed / dirty clones flagged by name;
- [ ] `kit-version.sh verify` was green on the new kit **before** the first copy;
- [ ] every clone was adopted by `mv` + `submodule add`, and each printed
      `Adding existing repo at 'submodules/<name>' to the index`;
- [ ] every `.gitmodules` URL equals the corresponding checkout's real `origin`;
- [ ] `$CLONES_DIR` was not deleted, and whatever remains in it is named in the
      handover;
- [ ] `project-repositories.json` exists with `schema_version: 1`, `project`,
      `repository_source`, and a `base_branch` per repository;
- [ ] `repos.json` renamed to `.superseded`, no `sync-repos.sh` anywhere;
- [ ] every repository was gated with `prepare-base` before its copy; skipped
      repositories named with the failing gate and its output;
- [ ] `corp.agentDir` set in every repository and echoed back;
- [ ] the `<openspec>` token resolved, all six CLI calls proven and recorded in
      `port-facts.md`, `grep` finds neither `<openspec>` nor `opsx`;
- [ ] `port-facts.md` is filled in: no P-row still holds `...`, the header names the real port,
      version and probe date, and `corp-lint.mjs` is green on the store;
- [ ] every repository has an `openspec/adr/` directory with a `.gitkeep`;
- [ ] all six skills installed, including the new `corp-repository-state`;
- [ ] `docs/testing-stack.md` filled in and placeholder-free in every repository, with
      one fast and one slow command output pasted per repository;
- [ ] every in-flight change reports `"valid": true`;
- [ ] the five stage-11 negative tests are red where they must be red;
- [ ] `sync-submodules.sh` re-run clean, `.gitmodules` diff empty,
      `aggregate-index --strict` green;
- [ ] one Corp command executed end-to-end in the real port after the migration;
- [ ] one commit per repository, recorded by SHA.

---

## Rollback

Stages 7–10 are one commit per repository, so they revert one repository at a time:

```bash
git -C "<repo>" revert --no-edit <migration-commit>
bash "<repo>/tools/verify-docs.sh"
```

Stage 2 (the clone adoption) is the only irreversible-by-Git step, and it is reversible
by hand because nothing was deleted:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule deinit -f -- "submodules/<name>"   # leaves the work tree
git -C "$CORP_SYSTEM_STORE_ROOT" config -f .gitmodules --remove-section "submodule.<name>"
mv "$CORP_SYSTEM_STORE_ROOT/submodules/<name>" "$CLONES_DIR/<name>"
git -C "$CLONES_DIR/<name>" status --porcelain
git -C "$CLONES_DIR/<name>" stash list
```

Verify against `~/corp-sdd-migration-preflight.txt` that branches, unpushed commits and
stashes are unchanged. Keep `$OLD_ROOT` and `$CLONES_DIR` until stage 12 is green — they
are the only rollback for stages 1–6.

Rolling back commands and skills means re-installing `71de101`'s `en/commands/` and
`en/skills/`, because the port directory is usually not a Git repository. Keep the old
checkout unpacked.

---

## Known kit defects, open in the current edition

From `content/enterprise-sdd-agents/kit-review-2026-08-25.md`. These are not caused by
the migration; know them before you hit them.

- **Nothing in the daily flow proves the OpenSpec root.** `check-openspec-root.sh`
  exists precisely because OpenSpec walks up past `.git`, and the new layout puts every
  repository *inside* a store that has its own `openspec/`. No command calls it (grep
  across all commands and skills: zero hits) — only `docs/SETUP.md` stage 5 does. A
  repository that loses or never commits its `openspec/` writes silently into the store.
  Mitigation: run `bash "$REPO_ROOT/tools/check-openspec-root.sh"` yourself before every
  spec write, and add it to your team's instruction file.
- ~~`corp-lint.mjs` hard-codes a port directory~~ — **fixed in edition `2026-08-25.11`**
  (kit review finding 6). No agent-home name appears anywhere in the kit; the lint resolves
  `CORP_AGENT_DIR` → `git config corp.agentDir` → the single root dot-directory containing
  `skills/`, and exits 1 rather than guess between two. Setting `corp.agentDir` explicitly
  (stage 5.2) is still the safer habit, and is required when a repository root holds more
  than one such directory.
- **`verify-docs.sh` run from the unpacked kit crashes** instead of explaining: it
  resolves `REPO_ROOT` to the containing Git repository and dies with
  `Cannot find module '<that repo>/tools/gen-index.mjs'`. It is an installed-only tool.
  Always run the installed copy from a repository root.

---

## Unverified

Everything above traces to a file read in this repository. These items do not, and must
be resolved on the target machine before or during the run — do not invent them:

1. **The actual on-disk layout of the operator's `71de101` install.** The public commit
   ships `en/` and `ru/` trees and `config/repos.json.example`. Where the live
   `repos.json`, `clones/` and installed `tools/` actually sit is discovered in stage
   0.3, not assumed here.
2. **Whether the install uses the `en/` or `ru/` tree.** Both exist at `71de101` and are
   feature-identical. The current kit directory read for this runbook is the English
   `corp-sdd-starter/`; a `corp-sdd-starter-ru/` exists beside it. Install the language
   the team already runs.
3. **Whether a system store already exists on `<store-remote-url>`.** Stage 1 asks Git
   with `git ls-remote`; the answer is not knowable from here.
4. **The pinned `@fission-ai/openspec` version and the resolved `<openspec>` invocation.**
   The kit records the token, never the value. Stage 6 proves it.
5. **The agent port's home directory, command directory, skill directory, instruction
   filename, and MCP tool names.** The kit names none of them on purpose. Stage 5
   discovers them.
6. **Whether the port supports skills at all.** If not, take the stage 8.3 inlining
   fallback.
7. **Base branches per repository.** Stage 3.1 reads them from each remote; there is no
   value in `repos.json` to convert.
8. **`corp-review`, `corp-implement`, `corp-autotest` and `corp-test-plan` old-vs-new
   diffs** were not read line by line for this runbook; only `corp-spec`, `corp-plan` and
   `corp-archive` were. The behaviour changes listed in 8.4 for the other four come from
   the project note's recorded diff summary (`projects/active/corp-sdd-transition.md`,
   2026-08-25 entry: 21 breaking / 14 additive / 9 neutral across 25 files), not from a
   direct read here. Re-diff them before relying on any detail beyond what 8.4 states.
9. **The exact CI system.** `docs/SETUP.md` §7 ships a CI pipeline template and marks
   it TEMPLATE. Adapt and smoke-test it; this runbook does not migrate CI.
10. **The kit edition moves fast.** During the writing of this runbook `VERSION` read
    `2026-08-25.13`, then `2026-08-25.14` minutes later; it was last re-checked against
    `2026-08-26.7`. Always read `VERSION` on the kit you unpack rather than trusting any
    edition string quoted here.
