---
name: spns-repository-state
description: Use when starting or resuming Serpens SDD work, changing base or feature branches, working in a project submodule, or encountering dirty, detached, stale, unpushed, behind, or diverged Git state.
serpens-version: 2026-09-25.1
---

# Serpens repository state

## Overview

Prove repository identity and Git state before reading current code or writing a
change. The deterministic `<serpens-sdd> state` command is the authority; this
skill chooses its safe mode and acts on its evidence.

This skill is self-contained. It does not require an upstream Superpowers
installation.

## Required sequence

### Start a new story

1. From the selected repository, run:
   ```bash
   <serpens-sdd> state inspect
   <serpens-sdd> state prepare-base
   ```
2. Ask for the branch name — never build it yourself:
   ```bash
   BRANCH=$(<serpens-sdd> git-naming --print-contract <TICKET> | awk -F'\t' '$1=="branch-example"{print $2}')
   ```
   The shape comes from the shop's `serpens/branching.md`, which is also what the
   pre-push hook enforces. Create `$BRANCH` from the prepared base.
3. Publish the branch with `git push -u origin "$BRANCH"` before handing
   it to another Serpens command.
4. Run `assert-change <TICKET>` and record its output as the branch-state gate.

### Resume an existing story

Run:

```bash
<serpens-sdd> state assert-change <TICKET>
```

Add `--checkout` when the command should move you onto the story branch instead of stopping. It
switches only to a branch that already exists locally or on origin, and refuses to invent one —
cutting a new story branch is `spns-spec`'s decision alone.

Use `--allow-dirty` only for a command that explicitly resumes already-started
implementation or test edits. A dirty spec, plan, review, or archive start is a
state failure, not permission to continue.

## Quick reference

| Situation | Mode | Required result |
|---|---|---|
| Learn current state | `inspect` | Evidence only; no mutation |
| Start a new story | `prepare-base` | Configured base, clean, tracked, current |
| Plan or review | `assert-change <TICKET>` | Exact tracked feature branch, not behind |
| Get onto the story branch | `assert-change <TICKET> --checkout` | Switches to an EXISTING branch (local or origin); never creates one |
| Resume code edits | `assert-change <TICKET> --allow-dirty` | Same branch gate; working edits allowed |
| Archive after merge | `assert-archivable` | Clean tree, no stashes, HEAD contains the base |

The base branch comes from `SERPENS_BASE_BRANCH`, then the repository-local
`serpens.baseBranch` Git setting, then the parent system store's `.gitmodules`.
Without those, the tool uses `origin/develop`, then the remote default branch.

## Failure handling

Treat a non-zero result as a hard gate. Read the printed state and use its
recovery command after deciding where the local work belongs. Preserve the
repository until that decision is made.

The tool never runs reset, clean, rebase, force checkout, automatic stash
mutation, or branch deletion. Do not replace that safety with a manual shortcut.

## Common mistakes

- Running a Serpens command from the system-store root instead of the selected
  submodule. Change directory to `system-store/submodules/<repository>` first.
- Assuming `git fetch` updates the working branch. `prepare-base` performs the
  verified fast-forward when safe.
- Treating an ahead branch as disposable. An unpushed commit may be its only
  copy; inspect and publish or relocate it deliberately.
- Using `--allow-dirty` to bypass an unknown state. It is only for known,
  interrupted implementation work on the exact story branch.
