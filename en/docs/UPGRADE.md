# Upgrade task for the installation agent

Use this runbook when the workspace already exists — `@fresh-fx59/serpens-sdd`, a sibling
system store, and N onboarded submodules — and you are moving it from an older
kit edition to the current one. A first install is `docs/SETUP.md`; this file
never replaces it.

Stop on every failed gate. Record commands and outputs in your project handover.
Never delete, reset, clean, rebase, force-checkout, or rewrite an existing
repository during an upgrade. An upgrade replaces *the shim, installed commands
and skills*. It never touches project content.

## 0. Take stock before you touch anything

Resolve the same durable roots the setup runbook uses:

```bash
export SERPENS_WORKSPACE_ROOT="$(pwd -P)"
export SERPENS_SYSTEM_STORE_ROOT="${SERPENS_SYSTEM_STORE_ROOT:-$SERPENS_WORKSPACE_ROOT/system-store}"
test -d "$SERPENS_SYSTEM_STORE_ROOT/.git" || test -f "$SERPENS_SYSTEM_STORE_ROOT/.git"
```

Name both editions — the one you are installing, and the one already on disk:

```bash
serpens-sdd version                          # the edition this install of the package is
```

Now classify every **installed** command and skill copy — the only files an upgrade
overwrites. `identify` hashes the file you name, so it works at any path, including an
agent-home command directory (`<kit-root>` is the installed package's own `kits/<lang>`
directory, e.g. `$(npm root -g)/@fresh-fx59/serpens-sdd/kits/en`):

```bash
serpens-sdd version identify --root "<kit-root>" "<installed-command-dir>"/spns-*.md || true
serpens-sdd version identify --root "<kit-root>" "<installed-skill-dir>"/spns-*/SKILL.md || true
```

Each line is one of three verdicts:

| Verdict | Meaning | What the upgrade does |
|---|---|---|
| `pristine <edition>` | untouched kit file of that edition | replace it silently |
| `MODIFIED` | carries a stamp, but not those bytes — someone edited it | **stop**, stage 6 below |
| `UNSTAMPED` | predates versioning, or is a local file | treat as MODIFIED, stage 6 below |

Write the full three-way inventory into the handover **before** the first copy.
After the upgrade it cannot be reconstructed: a replaced file looks exactly like
a file that was already current.

The shim itself is never classified this way: `serpens-sdd init` refuses to overwrite a
`serpens/bin/serpens-sdd` that does not carry its own generated-file marker, so a hand-edited shim is a
hard stop at write time, not a keep-or-replace decision here.

## 1. Every repository clean and on its base branch

The upgrade writes into the store and into every submodule. Each one is a
separate Git repository and is committed separately, so each one is gated
separately, before any copy:

```bash
<serpens-sdd> state prepare-base \
  --repo "$SERPENS_SYSTEM_STORE_ROOT" --base "$(git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch)"
git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      <serpens-sdd> state prepare-base --repo "$repo"
    done
```

The state gate refuses dirty worktrees, detached HEAD, unpushed commits on the
base branch, wrong upstreams, and divergence. It only performs a verified
fast-forward. A stash and commits on other local branches are reported, never
blocked and never touched. Resolve every stop with the owner of that work — do not upgrade
around it. A repository that cannot be gated is skipped whole and named in the
handover; a half-upgraded repository is the one state the daily flow cannot
detect.

Do not start a shared "upgrade" branch across repositories. Each repository gets
its own commit on its own base, so each can be reverted alone (stage 9).

## 2. Re-probe the port only when it changed

Skip this stage unless the agent CLI version, its command or skill directory, or
the pinned OpenSpec package version changed since `serpens/port-facts.md` was written.
If any of those changed, redo SETUP stage 2 in full against the real port —
never edit the recorded invocations by hand — and prove the new pin once:

```bash
npx @fission-ai/openspec@<pinned-version> --version
```

Refresh the store's copy of the facts, keeping the recorded ids:

```bash
git -C "$SERPENS_SYSTEM_STORE_ROOT" diff -- serpens/port-facts.md
```

`<store-id>` and every repository id are a contract, not a label. An upgrade
never renames them; cross-repo links resolve by id and would break silently.

## 3. Refresh the shim in the store and every submodule

`serpens-sdd init --only 3,5` (see the "Upgrading from…" section above) writes a fresh
`serpens/bin/serpens-sdd` in the store and in every submodule reachable from `.gitmodules`, and
refreshes the templates each of those stages installs. Skipping this leaves the store and
every submodule's shim pointing at the previous edition's package version while every other
file claims to be current.

`serpens/port-facts.md` is untouched by this stage. It holds this installation's probed
facts, not kit content; stage 2 owns it. Overwriting it with a blank template
erases the port evidence the installed commands were resolved from.

Prove the refresh. `"$repo/serpens/bin/serpens-sdd" version` on its own proves nothing here: the shim is a
two-line `exec` of an absolute path into the installed package, and bare `version` reports that
PACKAGE's vendored kit edition, so a stale shim and a freshly written one print exactly the same
string. Prove instead the two things that can actually differ — that every repository has a
generated shim, and that it execs the package that is installed now:

```bash
installed_bin=$(node -e 'console.log(require.resolve("@fresh-fx59/serpens-sdd/bin/serpens-sdd.mjs"))' 2>/dev/null \
  || readlink -f "$(command -v serpens-sdd)")
echo "installed package bin: $installed_bin"
{ echo "$SERPENS_SYSTEM_STORE_ROOT"
  git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"'
} | while IFS= read -r repo; do
  shim="$repo/serpens/bin/serpens-sdd"
  grep -q 'serpens-sdd shim' "$shim" 2>/dev/null || { echo "✗ $repo: no generated shim — re-run stage 3/5"; continue; }
  grep -qF "$installed_bin" "$shim" || { echo "✗ $repo: shim routes to a DIFFERENT install than $installed_bin"; continue; }
  printf '✓ %s -> ' "$repo"; "$shim" version
done
git -C "$SERPENS_SYSTEM_STORE_ROOT" status --short
```

Every repository must print `✓` and the new edition.

What this does NOT prove, stated plainly: when the package is upgraded in place (`npm i -g`
overwrites the same bin path), a shim from the previous edition is byte-identical to a fresh one
and routes to the upgraded package correctly. In that case there is nothing to distinguish, and
nothing that needs distinguishing — the check above is exactly as strong as the situation allows.
It catches the cases that do break: a missing shim, a hand-written file at `serpens/bin/serpens-sdd`, and a
shim left pointing at an install that has moved or been removed.

## 4. New per-repository files this edition requires

Two files SETUP now installs into every repository did not exist in older editions, and an
upgrade that skips them leaves working repositories half-configured. `serpens-sdd init --only 5`
(part of the same re-run as stage 3 above) writes both, but check for a repository whose
`serpens/testing-stack.md` or `.gitignore` predates that stage and was never touched since:

```bash
for repo in $(git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule --quiet foreach 'echo $sm_path'); do
  d="$SERPENS_SYSTEM_STORE_ROOT/$repo"
  test -f "$d/serpens/testing-stack.md" || echo "MISSING serpens/testing-stack.md: $d"
  test -f "$d/.gitignore" || echo "MISSING .gitignore: $d"
done
```

`serpens/testing-stack.md` is what `spns-tdd`, `spns-debugging`, `spns-test-plan` and
`spns-autotest` read instead of naming a technology; a repository without it leaves four
commands with no stack, and since this edition `verify-docs` FAILS on its absence in an
onboarded repository rather than passing quietly. Never overwrite one that already holds real
content — the installer only ever writes the file when it does not yet exist.

An existing file does, however, get UPGRADED in place: stage 6 appends every required section
and slot row this edition added and the file does not have, verbatim from the template and
therefore still marked `UNFILLED`, and changes nothing that is already answered. So a file
filled in under an older edition gains this edition's `Manual testing access` section unanswered
— `verify-docs` will then name those slots, which is the point: they are facts only the team
has. Re-run `serpens-sdd init --only 6` to apply it, then answer the new slots (`none` where the
repository has no such surface). The `.gitignore` is SETUP step 6b: untracked files never block a gate, but an ignored
file can never be staged by accident either — merge a missing one from
`system-store-template/gitignore.template` rather than replacing an existing file.

## 5. Commands, skills, and the placeholder re-resolution

`serpens-sdd init --only 6` copies `skills/spns-*` into the project-scoped skill directory recorded
in `serpens/port-facts.md`, and `commands/spns-*.md` into the recorded command directory, adapting only
the port wrapper, frontmatter, and `{{args}}` token, exactly as at install time.

A fresh command file ships **unresolved** placeholders. The copy therefore undoes
the install-time resolution, and re-resolving is mandatory, not optional:
`<serpens-sdd> init` replaces every `<openspec>` token with the resolved CLI invocation recorded
in `serpens/port-facts.md`, and every `<serpens-sdd>` token with the shim invocation from stage 3/5 —
`"$(git rev-parse --show-toplevel)"/serpens/bin/serpens-sdd` by default, the same string the generated
`lefthook.yml` uses, overridable with `serpens_sdd.invocation`. A bare `serpens-sdd` is not a valid
resolution: it is on PATH only in a global install.
`spns-spec` must call `new change` and per-artifact `instructions`,
`spns-plan` `instructions design`/`instructions tasks`, `spns-implement`
`instructions apply`, `spns-review` `validate` and `status`, `spns-archive` `archive`.

```bash
grep -rnE '<openspec>|<serpens-sdd>' "<installed-command-dir>" "<installed-skill-dir>" && exit 1 || true
```

That proof is the gate: a non-empty result means the upgrade left a command
that cannot run. If the port has no skill mechanism, inline the skill bodies
again and prove no unavailable skill reference remains.

## 6. MODIFIED and UNSTAMPED files: decide, never overwrite

Stage 0 listed them. For each one, stop the copy for that single file and:

1. diff the installed copy against the kit copy of the same path:

   ```bash
   diff -u "<installed-file>" "<kit-root>/<kit-path-from-identify>"
   ```

   `identify` prints the kit path for a pristine file; for a MODIFIED one, use
   the same relative path under `<kit-root>`.
2. decide **keep** or **replace** with a named human — the harness owner, or the
   author of the local change when Git names one:

   ```bash
   git -C "<repo>" log -1 --format='%an %ae %cI' -- "<path-relative-to-repo>"
   ```
3. record the decision in the handover: file, both editions, who decided, why.
   A kept local change is now a permanent fork of that file — say so, and file it
   as a kit change request so the next upgrade does not re-litigate it.

Silently overwriting here is the failure this stage exists to prevent: a
deliberate local guard or a port-specific wrapper disappears, and nothing in the
daily flow reports it.

## 7. What an upgrade must never touch

These are project content and installation identity, not kit files. Leave them
exactly as they are:

- `project-repositories.json`, if present — the inventory. Refreshing bindings is
  a separate operation (`docs/OPERATIONS.md`, "Refresh project bindings"). On
  this edition `serpens-sdd init` no longer writes this file at all (`.gitmodules`,
  or `config.repositories` before any submodule exists, is the list); an upgrade
  never deletes an existing one either, but it is obsolete and safe to delete
  once you have confirmed `sync-submodules --repos-from -` reconciles cleanly
  without it (stage 8 below).
- `.gitmodules` and the submodule contents — an upgrade adds no repository and
  moves no pointer.
- `openspec/` in the store and in every repository — contracts, ADRs, changes,
  archives, `repo.txt`, `config.yaml`.
- `serpens/port-facts.md`, except through stage 2.
- The store's own project files under `tools/` that the kit does not ship.

Never re-run the `system-store-template` copy and never run `git init` in the
store. Both are first-install-only. Running them against a live store creates a
second, unrelated history and costs a rewrite rather than a retry.

**Partial reruns of stage 4/9 stay correct even without stage 1.** `serpens-sdd init
--only 4` and `--only 9` used to depend on stage 1 having already populated the
repository row list for that same run; skip stage 1 and they silently reconciled
ZERO repositories, exiting 0 with a deinitialized submodule left exactly as
deinitialized. Both stages now re-derive the row list themselves (`.gitmodules`
when submodules exist, otherwise `config.repositories`) whenever it wasn't
already resolved this run, so `--only 4,9` alone repairs a deinitialized or
missing checkout without needing `--only 1,4,9`.

## 8. Re-prove the guards, then run one real command

New tool bytes mean the guards are unproven again. Repeat SETUP stage 8 against
temporary bad inputs, in the store and in one representative spoke:

- a bad OpenSpec root must fail;
- a duplicated shared contract shape must fail the split-brain check;
- a bad branch and mismatched ticket commit must fail naming checks;
- `git config core.hooksPath` must be empty or point to this repository's hooks;
- a deliberate bad temporary commit must be rejected by the installed hook.

Re-run `lefthook install` in any repository whose `lefthook.yml` changed. Then
prove idempotence and the live catalog path:

```bash
git -C "$SERPENS_SYSTEM_STORE_ROOT" config -f .gitmodules --get-regexp '\.(url|branch)$' \
  | # ... reshape into name<TAB>url<TAB>base_branch rows, one per submodule ...
  <serpens-sdd> sync-submodules --repos-from - --store-root "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" diff -- .gitmodules   # must be empty
<serpens-sdd> catalog --strict "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule status
```

A shop still carrying `project-repositories.json` may instead pass
`--inventory "$SERPENS_SYSTEM_STORE_ROOT/project-repositories.json"` — both forms
are read by the same per-row validation and reconciliation.

Files on disk are not a working upgrade. Invoke one Serpens command inside the port
itself — run `spns-spec` against a throwaway ticket in one onboarded repository,
confirm it reaches the interview and writes `openspec/changes/<id>/proposal.md`,
then delete the branch and the change folder. An upgrade that has never executed
a command in the real port is unproven, whatever `identify` prints.

Commit each repository separately, one commit per repository, touching only the
files this upgrade actually changed. Since this edition `serpens/bin/` holds nothing but the generated
shim, and the shim's bytes do not change when the package is upgraded in place, an upgraded
repository frequently has NOTHING to commit — that is a success, not a failure, so never chain
`git commit` behind `&&` on this step:

```bash
git -C "<repo>" add -A serpens/bin/
if git -C "<repo>" diff --cached --quiet; then
  echo "nothing to commit in <repo>: the shim is already current (expected)"
else
  git -C "<repo>" commit -m "chore(<TICKET>): serpens-sdd shim -> <new edition>"
fi
```

Do the same in the store, and commit the installed commands and skills wherever
the port keeps them under version control.

## 9. Rollback

A repository's upgrade is AT MOST one commit — and often none at all, because the generated shim
is usually byte-identical across editions (see section 3). So rollback is per repository, and the
first step is to find out whether there is anything to revert:

```bash
git -C "<repo>" log --oneline -1 -- serpens/bin/    # the upgrade commit, if this repo produced one
```

If it produced one, revert exactly that commit; if it did not, there is nothing in the repository
to roll back — the shim it has is the shim the previous edition wrote, and rolling back means
reinstalling the previous package version so the shim's target resolves to it:

```bash
git -C "<repo>" revert --no-edit <upgrade-commit>   # only when the log above named one
"<repo>/serpens/bin/serpens-sdd" verify-docs
```

The store and the spokes roll back independently and in any order: the shims do
not read each other. Reverting the store does not change a submodule pointer,
because stage 4 committed inside the submodule, not in the store.

Rolling back commands and skills means re-installing the previous kit's
`commands/` and `skills/` and re-running the stage 5 placeholder resolution — the
port directory is usually not a Git repository, so keep the previous kit
unpacked until the acceptance checklist is green.

Nothing in stages 3–5 touches project content, so a rollback never loses a spec,
a change, or a submodule pointer.

## 10. Uninstall

`serpens-sdd uninstall [--repo <path>] [--apply] [--include-history]` reverses an install.
**Dry-run is the default** — it prints every write this kit could have made, an owner check for
each, and what it would do; nothing on disk changes until you pass `--apply`. Works against a
repo-local trial (the one repository) or a system store (run it from the store root; it walks
every onboarded submodule).

Every removal passes an owner check first — a marker, or a byte-identical match against the kit
— never a guess. A file that fails the check is reported **"left in place, remove by hand"**,
with the exact manual step. Concretely:

- `lefthook.yml` (or `serpens/lefthook.yml`, when a team config already existed) is deleted only
  when it still carries our generated marker; `lefthook uninstall` runs only when no other
  lefthook config remains.
- The HARD RULE block in the port instruction file (`CLAUDE.md`, `AGENTS.md`, …) is removed by
  its own marker heading, never the rest of the file; the file itself is deleted only if it
  becomes empty AND this install created it.
- `openspec/config.yaml`: the `references:` entry, the context catalog, and the per-artifact
  `rules:` ids this install added are removed only when their bytes still match exactly what we
  would have written; anything a human edited since is left alone.
- Every installed command and skill is checked byte-for-byte against what stage 6 would have
  written for it (the kit source with the resolved `<openspec>`/`<serpens-sdd>` tokens
  substituted); an edited copy is kept and reported, never deleted.
- `serpens/testing-stack.md`, `serpens/branching.md` and `serpens/port-facts.md` are **kept** —
  they hold real answers, not placeholders — unless `--include-history` is given.
- `.serpens.yaml` change markers are **never removed by default**: they are change history.
  `--include-history` removes the marker files only, never `research.md` or any other change
  content.
- `git config serpens.baseBranch` / `serpens.agentDir` are unset when present.
- A registered system store and its `.gitmodules`/submodule commits are **never reversed by
  this command**: it prints the exact `openspec store` de-registration command for you to run
  by hand, and never runs it itself.

Nothing here ever commits or pushes. Review `git status`, keep what you want, commit yourself.

## Acceptance

Close the upgrade only when every line holds:

- [ ] the pre-upgrade pristine / MODIFIED / UNSTAMPED inventory is in the handover;
- [ ] `serpens-sdd version` reports the new edition before any copy;
- [ ] every repository gated with `prepare-base` before its copy; skipped
      repositories named with the failing gate and its output;
- [ ] every repository has a generated `serpens/bin/serpens-sdd` whose exec target is the package
      installed now, and each one prints the new edition (section 3's proof, not a bare
      `version` call, which cannot fail);
- [ ] every MODIFIED or UNSTAMPED file has a recorded keep-or-replace decision
      and a named decider;
- [ ] commands and skills reinstalled, `grep` proves no `<openspec>` and no `<serpens-sdd>`
      token left;
- [ ] `serpens/port-facts.md`, `project-repositories.json` (if present), `.gitmodules` and
      every `openspec/` tree unchanged by the upgrade;
- [ ] SETUP stage 8 negative tests re-run and red where they must be red;
- [ ] `sync-submodules` re-run clean and `catalog --strict` green;
- [ ] one Serpens command executed end-to-end in the port after the upgrade;
- [ ] at most one commit per repository, each revertible on its own, recorded in the
      handover by SHA — and every repository that legitimately had nothing to commit
      recorded as such, with the shim check above as its evidence.
