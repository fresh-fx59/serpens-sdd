#!/usr/bin/env bash
# corp-version: 2026-08-26.8
# repository-state.sh — inspect and enforce the Git state expected by Corp SDD.
# Never resets, cleans, rebases, force-checks out, mutates stashes, or deletes work.
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  bash repository-state.sh inspect [--repo <path>] [--base <branch>]
  bash repository-state.sh prepare-base [--repo <path>] [--base <branch>]
  bash repository-state.sh assert-archivable [--repo <path>] [--base <branch>]
  bash repository-state.sh assert-change <TICKET> [--repo <path>] [--allow-dirty] [--checkout]
EOF
}

MODE=${1:-}
[ -n "$MODE" ] || { usage; exit 2; }
shift
TICKET=""
if [ "$MODE" = assert-change ]; then
  TICKET=${1:-}
  [ -n "$TICKET" ] || { usage; exit 2; }
  shift
fi

REPO="."
BASE_OVERRIDE="${CORP_BASE_BRANCH:-}"
ALLOW_DIRTY=0
CHECKOUT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;;
    --base) BASE_OVERRIDE=${2:-}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --checkout) CHECKOUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
case "$MODE" in inspect|prepare-base|assert-archivable|assert-change) ;; *) echo "✗ unknown mode: $MODE" >&2; usage; exit 2 ;; esac
if [ "$MODE" != assert-change ] && [ "$ALLOW_DIRTY" -eq 1 ]; then
  echo "✗ --allow-dirty is valid only with assert-change" >&2
  exit 2
fi
if [ "$MODE" != assert-change ] && [ "$CHECKOUT" -eq 1 ]; then
  echo "✗ --checkout is valid only with assert-change" >&2
  exit 2
fi

repo_top=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$repo_top" ]; then
  echo "✗ not a Git repository: $REPO" >&2
  exit 2
fi
REPO=$(cd "$repo_top" && pwd -P)

expected_base() {
  if [ -n "$BASE_OVERRIDE" ]; then
    printf '%s\n' "$BASE_OVERRIDE"
    return
  fi

  local super rel key branch
  branch=$(git -C "$REPO" config --local --get corp.baseBranch 2>/dev/null || true)
  if [ -n "$branch" ]; then
    printf '%s\n' "$branch"
    return
  fi

  super=$(git -C "$REPO" rev-parse --show-superproject-working-tree 2>/dev/null || true)
  if [ -n "$super" ] && [ -f "$super/.gitmodules" ]; then
    super=$(cd "$super" && pwd -P)
    rel=${REPO#"$super"/}
    key=$(git -C "$super" config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null \
      | awk -v target="$rel" '$2 == target { print $1; exit }')
    if [ -n "$key" ]; then
      key=${key%.path}.branch
      branch=$(git -C "$super" config -f .gitmodules --get "$key" 2>/dev/null || true)
      if [ -n "$branch" ]; then printf '%s\n' "$branch"; return; fi
    fi
  fi

  if git -C "$REPO" show-ref --verify --quiet refs/remotes/origin/develop; then
    printf 'develop\n'
    return
  fi
  branch=$(git -C "$REPO" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  branch=${branch#origin/}
  if [ -n "$branch" ]; then printf '%s\n' "$branch"; return; fi

  echo "✗ cannot determine the required base branch" >&2
  echo "  ↳ set branch in the parent .gitmodules, or pass --base <branch>" >&2
  return 1
}

BASE=$(expected_base) || exit 1
if ! git check-ref-format --branch "$BASE" >/dev/null 2>&1; then
  echo "✗ invalid expected base branch: $BASE" >&2
  exit 2
fi

# OpenSpec resolves its root by walking UP from the repository looking for an `openspec/`
# directory, and the walk does not stop at a `.git` boundary. A submodule that was never
# `openspec init`-ed therefore resolves to the STORE's root, and every artifact an agent writes
# lands in the hub with no warning — measured on 1.10.0: `new change` from such a repository
# printed `Created change ... at <store>/openspec/changes/...`. Upstream only treats a directory
# with real content as a root, so an empty `openspec/` shell does not count here either.
openspec_root=""
_d="$REPO"
while :; do
  if [ -d "$_d/openspec" ] && [ -n "$(ls -A "$_d/openspec" 2>/dev/null)" ]; then openspec_root="$_d"; break; fi
  _p=$(dirname "$_d")
  [ "$_p" = "$_d" ] && break
  _d="$_p"
done

branch=$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
upstream=$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
# `dirty` counts TRACKED changes only. Untracked files are never a reason to stop: a working
# repository legitimately holds local-only settings, credential files and scratch output that
# must not be committed, and blocking on them pushes the operator into `git add` chores or,
# worse, into committing a secret. They are reported, never enforced.
# Submodules: git reports a submodule with ANY internal change as a modified gitlink here, so an
# untracked .pyc inside a spoke would make the STORE look dirty. Ignore that class; a submodule
# whose tracked files changed still shows, and is named below rather than blamed on this repo.
dirty=0
dirty_list=$(git -C "$REPO" status --porcelain --untracked-files=no --ignore-submodules=untracked)
[ -n "$dirty_list" ] && dirty=1
dirty_submodules=$(printf '%s\n' "$dirty_list" | awk '$1 == "M" || $1 == "MM" { print $2 }' \
  | while read -r p; do [ -n "$p" ] && [ -f "$REPO/$p/.git" -o -d "$REPO/$p/.git" ] && printf '%s ' "$p"; done)
untracked=$(git -C "$REPO" ls-files --others --exclude-standard | wc -l | tr -d ' ')
stash_count=$(git -C "$REPO" stash list | wc -l | tr -d ' ')
ahead=0
behind=0
if [ -n "$upstream" ]; then
  counts=$(git -C "$REPO" rev-list --left-right --count "HEAD...$upstream" 2>/dev/null || printf '0\t0')
  ahead=${counts%%[[:space:]]*}
  behind=${counts##*[[:space:]]}
fi

print_state() {
  printf 'repo=%s\n' "$REPO"
  printf 'openspec_root=%s\n' "${openspec_root:-NONE}"
  printf 'expected_base=%s\n' "$BASE"
  printf 'branch=%s\n' "${branch:-DETACHED}"
  printf 'upstream=%s\n' "${upstream:-NONE}"
  printf 'dirty=%s\n' "$dirty"
  printf 'untracked=%s\n' "$untracked"
  printf 'stash_count=%s\n' "$stash_count"
  printf 'ahead=%s\n' "$ahead"
  printf 'behind=%s\n' "$behind"
}

if [ "$MODE" = inspect ]; then
  print_state
  exit 0
fi

die_state() {
  echo "✗ $1" >&2
  shift
  for line in "$@"; do echo "$line" >&2; done
  echo "--- repository state ---" >&2
  print_state >&2
  exit 1
}

# Asserting modes only: `inspect` stays evidence-only, so a not-yet-onboarded repository can still
# be looked at. The system store legitimately owns an openspec/ root, so this passes there too.
if [ "$openspec_root" != "$REPO" ]; then
  die_state "OpenSpec root is not this repository" \
    "  ↳ resolved root: ${openspec_root:-NONE}" \
    "  ↳ every spec written here would land there instead — openspec walks up past .git" \
    "  ↳ onboard this repository (SETUP stage 5: openspec init, then check-openspec-root.sh)"
fi
[ -n "$branch" ] || die_state "detached HEAD" "  ↳ inspect it: git -C \"$REPO\" log -1 --oneline"
if [ "$dirty" -eq 1 ] && { [ "$MODE" != assert-change ] || [ "$ALLOW_DIRTY" -eq 0 ]; }; then
  if [ -n "$dirty_submodules" ]; then
    die_state "uncommitted changes to TRACKED files inside submodule(s): $dirty_submodules" \
      "  ↳ the change is in the submodule, not in this repository" \
      "  ↳ inspect it: git -C \"$REPO/${dirty_submodules%% *}\" status --short" \
      "  ↳ commit it there first; the pointer bump is then committed in THIS repository by whoever merges the child PR"
  fi
  die_state "working tree has uncommitted changes to TRACKED files" \
    "  ↳ inspect them: git -C \"$REPO\" status --short --untracked-files=no --ignore-submodules=untracked"
fi
# Untracked files are reported once and never block — see the note above.
if [ "$untracked" -ne 0 ]; then
  echo "⚠ $untracked untracked file(s) present (ignored by every gate, never committed for you):" >&2
  echo "  ↳ list them: git -C \"$REPO\" ls-files --others --exclude-standard" >&2
fi
# A stash is only dangerous where the delta folds into living specs: assert-archivable.
# Elsewhere it is normal interrupted work — warn, never block, and never touch it.
if [ "$stash_count" -ne 0 ]; then
  if [ "$MODE" = assert-archivable ]; then
    die_state "repository has $stash_count stash entry(s)" "  ↳ inspect them: git -C \"$REPO\" stash list"
  fi
  echo "⚠ $stash_count stash entry(s) present (left untouched): git -C \"$REPO\" stash list" >&2
fi

if [ "$MODE" = assert-archivable ]; then
  git -C "$REPO" fetch --quiet origin || die_state "fetch from origin failed" "  ↳ check access: git -C \"$REPO\" fetch origin"
  if ! git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$BASE"; then
    die_state "origin/$BASE does not exist" "  ↳ inspect branches: git -C \"$REPO\" branch -r"
  fi
  if ! git -C "$REPO" merge-base --is-ancestor "origin/$BASE" HEAD; then
    die_state "$branch does not contain origin/$BASE" \
      "  ↳ archiving here would fold the delta into stale specs" \
      "  ↳ inspect it: git -C \"$REPO\" log --oneline --left-right HEAD...origin/$BASE" \
      "  ↳ merge the base in, or archive on a branch created from it"
  fi
  echo "✓ $branch contains origin/$BASE (archivable, ahead $ahead, behind $behind)"
  exit 0
fi

if [ "$MODE" = prepare-base ]; then
  # Commits on OTHER branches are not this command's business: checking out the base
  # neither moves nor deletes them. Report them so they are never a surprise, then let
  # the base-scoped gate below refuse the one case that can lose work — unpushed
  # commits on the base branch itself.
  unpublished=$(git -C "$REPO" log --branches --not --remotes --oneline 2>/dev/null || true)
  if [ -n "$unpublished" ]; then
    echo "⚠ commit(s) exist on no remote (preserved, nothing is deleted):" >&2
    printf '%s\n' "$unpublished" >&2
    echo "  ↳ inspect them: git -C \"$REPO\" log --branches --not --remotes --oneline" >&2
  fi

  git -C "$REPO" fetch --quiet origin || die_state "fetch from origin failed" "  ↳ check access: git -C \"$REPO\" fetch origin"
  if ! git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$BASE"; then
    die_state "origin/$BASE does not exist" "  ↳ inspect branches: git -C \"$REPO\" branch -r"
  fi

  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BASE"; then
    git -C "$REPO" checkout --quiet "$BASE" || die_state "cannot check out $BASE" "  ↳ inspect it: git -C \"$REPO\" status"
  else
    git -C "$REPO" checkout --quiet -b "$BASE" --track "origin/$BASE" \
      || die_state "cannot create local $BASE" "  ↳ inspect branches: git -C \"$REPO\" branch -avv"
  fi

  current_upstream=$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  if [ -z "$current_upstream" ]; then
    git -C "$REPO" branch --set-upstream-to="origin/$BASE" "$BASE" >/dev/null \
      || die_state "cannot set upstream for $BASE" "  ↳ run: git -C \"$REPO\" branch --set-upstream-to=origin/$BASE $BASE"
  elif [ "$current_upstream" != "origin/$BASE" ]; then
    die_state "$BASE tracks $current_upstream, expected origin/$BASE" \
      "  ↳ inspect it: git -C \"$REPO\" branch -vv"
  fi

  counts=$(git -C "$REPO" rev-list --left-right --count "HEAD...origin/$BASE")
  base_ahead=${counts%%[[:space:]]*}
  base_behind=${counts##*[[:space:]]}
  if [ "$base_ahead" -gt 0 ]; then
    die_state "$BASE has $base_ahead unpushed commit(s)" "  ↳ inspect them: git -C \"$REPO\" log origin/$BASE..$BASE --oneline"
  fi
  if [ "$base_behind" -gt 0 ]; then
    before=$(git -C "$REPO" rev-parse HEAD)
    git -C "$REPO" merge --quiet --ff-only "origin/$BASE" \
      || die_state "$BASE diverged from origin/$BASE" "  ↳ inspect it: git -C \"$REPO\" log --oneline --left-right $BASE...origin/$BASE"
    after=$(git -C "$REPO" rev-parse HEAD)
    echo "✓ fast-forwarded $BASE from ${before:0:12} to ${after:0:12}"
  else
    echo "✓ $BASE is clean and up to date"
  fi
  exit 0
fi

if [[ ! "$TICKET" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]]; then
  echo "✗ invalid ticket '$TICKET'; expected ABCD-1234" >&2
  exit 2
fi
expected_change="feature/$TICKET"

# --checkout switches to an EXISTING story branch. It never creates one: a missing branch means the
# story was never started here, and only corp-spec may decide where a new branch is cut from.
if [ "$CHECKOUT" -eq 1 ] && [ "$branch" != "$expected_change" ]; then
  # A dirty tree already died at the generic gate above unless --allow-dirty was given. With it, the
  # edits travel to the story branch and git itself refuses when that would overwrite a file.
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$expected_change"; then
    git -C "$REPO" checkout --quiet "$expected_change" \
      || die_state "cannot check out $expected_change without overwriting local edits" \
        "  ↳ inspect it: git -C \"$REPO\" status --short" \
        "  ↳ commit or park those edits first — this tool never discards work"
    echo "✓ switched to $expected_change"
  else
    git -C "$REPO" fetch --quiet origin || die_state "fetch from origin failed" "  ↳ check access: git -C \"$REPO\" fetch origin"
    if git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$expected_change"; then
      git -C "$REPO" checkout --quiet -b "$expected_change" --track "origin/$expected_change" \
        || die_state "cannot track origin/$expected_change" "  ↳ inspect branches: git -C \"$REPO\" branch -avv"
      echo "✓ checked out $expected_change tracking origin/$expected_change"
    else
      die_state "$expected_change does not exist locally or on origin" \
        "  ↳ this story was never started in this repository" \
        "  ↳ run corp-spec to create it; this tool never cuts a new branch"
    fi
  fi
  branch=$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  upstream=$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  dirty=0
  [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no --ignore-submodules=untracked)" ] && dirty=1
fi

[ "$branch" = "$expected_change" ] \
  || die_state "expected branch $expected_change, found ${branch:-DETACHED}" \
    "  ↳ switch to it: bash repository-state.sh assert-change $TICKET --checkout" \
    "  ↳ or rename this branch only after review: git -C \"$REPO\" branch -m $expected_change"
[ -n "$upstream" ] \
  || die_state "$expected_change has no upstream" "  ↳ publish it: git -C \"$REPO\" push -u origin $expected_change"
[ "$upstream" = "origin/$expected_change" ] \
  || die_state "$expected_change tracks $upstream, expected origin/$expected_change" "  ↳ inspect it: git -C \"$REPO\" branch -vv"

git -C "$REPO" fetch --quiet origin || die_state "fetch from origin failed" "  ↳ check access: git -C \"$REPO\" fetch origin"
counts=$(git -C "$REPO" rev-list --left-right --count "HEAD...origin/$expected_change")
change_ahead=${counts%%[[:space:]]*}
change_behind=${counts##*[[:space:]]}
[ "$change_behind" -eq 0 ] \
  || die_state "$expected_change is behind origin by $change_behind commit(s)" \
    "  ↳ inspect it: git -C \"$REPO\" log --oneline --left-right HEAD...origin/$expected_change"
echo "✓ $expected_change is valid (ahead $change_ahead, behind 0, dirty $dirty)"
