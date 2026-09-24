#!/usr/bin/env bash
# No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
# repository-state.sh — inspect and enforce the Git state expected by Serpens SDD.
# Never resets, cleans, rebases, force-checks out, mutates stashes, or deletes work.
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  bash repository-state.sh inspect [--repo <path>] [--base <branch>]
  bash repository-state.sh prepare-base [--repo <path>] [--base <branch>]
  bash repository-state.sh assert-archivable [--repo <path>] [--base <branch>] [--change <change-id>]
  bash repository-state.sh assert-change <TICKET> [--repo <path>] [--allow-dirty] [--checkout] [--conventions <path>]
  bash repository-state.sh mark-change <CHANGE-ID> --ticket <TICKET> [--repo <path>]
EOF
}

BC_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./lib/branch-contract.sh
source "$BC_SELF_DIR/lib/branch-contract.sh"
# shellcheck source=./lib/delivery-contract.sh
source "$BC_SELF_DIR/lib/delivery-contract.sh"

MODE=${1:-}
[ -n "$MODE" ] || { usage; exit 2; }
shift
TICKET=""
if [ "$MODE" = assert-change ]; then
  TICKET=${1:-}
  [ -n "$TICKET" ] || { usage; exit 2; }
  shift
fi
CHANGE_ID=""
if [ "$MODE" = mark-change ]; then
  CHANGE_ID=${1:-}
  [ -n "$CHANGE_ID" ] || { usage; exit 2; }
  shift
fi

REPO="."
BASE_OVERRIDE="${SERPENS_BASE_BRANCH:-}"
ALLOW_DIRTY=0
CHECKOUT=0
CONVENTIONS=""
MARK_TICKET=""
CONFIRM_SQUASH_REEDIT=0
ASSERT_CHANGE_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;;
    --base) BASE_OVERRIDE=${2:-}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --checkout) CHECKOUT=1; shift ;;
    --conventions) CONVENTIONS=${2:-}; shift 2 ;;
    --ticket) MARK_TICKET=${2:-}; shift 2 ;;
    --confirm-squash-reedit) CONFIRM_SQUASH_REEDIT=1; shift ;;
    --change) ASSERT_CHANGE_ID=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
if [ "$MODE" != assert-archivable ] && [ "$CONFIRM_SQUASH_REEDIT" -eq 1 ]; then
  echo "✗ --confirm-squash-reedit is valid only with assert-archivable" >&2
  exit 2
fi
if [ "$MODE" != assert-archivable ] && [ -n "$ASSERT_CHANGE_ID" ]; then
  echo "✗ --change is valid only with assert-archivable" >&2
  exit 2
fi
case "$MODE" in inspect|prepare-base|assert-archivable|assert-change|mark-change) ;; *) echo "✗ unknown mode: $MODE" >&2; usage; exit 2 ;; esac
if [ "$MODE" != assert-change ] && [ "$ALLOW_DIRTY" -eq 1 ]; then
  echo "✗ --allow-dirty is valid only with assert-change" >&2
  exit 2
fi
if [ "$MODE" != assert-change ] && [ "$CHECKOUT" -eq 1 ]; then
  echo "✗ --checkout is valid only with assert-change" >&2
  exit 2
fi
if [ "$MODE" != assert-change ] && [ -n "$CONVENTIONS" ]; then
  echo "✗ --conventions is valid only with assert-change" >&2
  exit 2
fi
if [ "$MODE" = mark-change ] && [ -z "$MARK_TICKET" ]; then
  echo "✗ mark-change requires --ticket <TICKET>" >&2
  usage
  exit 2
fi
if [ "$MODE" != mark-change ] && [ -n "$MARK_TICKET" ]; then
  echo "✗ --ticket is valid only with mark-change" >&2
  exit 2
fi

repo_top=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$repo_top" ]; then
  echo "✗ not a Git repository: $REPO" >&2
  exit 2
fi
REPO=$(cd "$repo_top" && pwd -P)

# mark-change stands apart from the other modes: it does not care about the base branch, dirty
# state, or the branch-naming contract — it just records ownership of an ALREADY-CREATED change
# folder. Handled here, before bc_load and the base-branch resolution below, none of which it
# needs (gap 2, serpens-openspec-coexistence-gaps-2026-09-22.md).
if [ "$MODE" = mark-change ]; then
  CHANGE_DIR="$REPO/openspec/changes/$CHANGE_ID"
  if [ ! -d "$CHANGE_DIR" ]; then
    echo "✗ no such change directory: $CHANGE_DIR" >&2
    echo "  ↳ run <openspec> new change $CHANGE_ID first; mark-change never creates a change" >&2
    exit 2
  fi
  MARKER="$CHANGE_DIR/.serpens.yaml"
  if [ -f "$MARKER" ]; then
    existing_ticket=$(grep -E '^ticket: ' "$MARKER" | head -1 | sed 's/^ticket: //')
    if [ -n "$existing_ticket" ] && [ "$existing_ticket" != "$MARK_TICKET" ]; then
      echo "✗ $MARKER already marks ticket $existing_ticket, refusing to overwrite with $MARK_TICKET" >&2
      echo "  ↳ inspect it: cat \"$MARKER\"" >&2
      exit 1
    fi
  fi
  mark_branch=$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  mark_created=$(date -u +%Y-%m-%d)
  cat > "$MARKER" <<EOF
# serpens-sdd:change-marker
owner: serpens-sdd
ticket: $MARK_TICKET
branch: ${mark_branch:-DETACHED}
created: $mark_created
EOF
  echo "✓ marked $CHANGE_ID as Serpens-owned (ticket $MARK_TICKET, branch ${mark_branch:-DETACHED})"
  exit 0
fi

# Loaded here (once REPO is a resolved absolute path) rather than sourced separately for each
# mode: assert-change is the only mode that reads BC_*, but resolving the contract is cheap and
# every mode having it loaded means a future mode never has to remember to do this first.
bc_load "$CONVENTIONS" "$REPO"
# The delivery contract's `integration-branch` (spec-org-facts-slice-delivery-2026-09-23.md §2b)
# now formalizes what expected_base() below used to hardcode ad hoc — origin/develop if present,
# else origin/HEAD. dc_load never fails on a missing/unanchored file (defaults apply), so this is
# always safe to call before BASE is resolved.
dc_load "" "$REPO"

expected_base() {
  if [ -n "$BASE_OVERRIDE" ]; then
    printf '%s\n' "$BASE_OVERRIDE"
    return
  fi

  local super rel key branch
  branch=$(git -C "$REPO" config --local --get serpens.baseBranch 2>/dev/null || true)
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

  # spec-org-facts-slice-delivery-2026-09-23.md §2b: `integration-branch` in serpens/delivery.md
  # is now the source of this lookup. dc_resolved_integration_branch keeps the EXACT same
  # detection order as the fallback (origin/develop if present, else origin/HEAD) when the field
  # is unset, so an unconfigured estate sees no behaviour change.
  branch=$(dc_resolved_integration_branch "$REPO" 2>/dev/null || true)
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

  # spec-org-facts-slice-delivery-2026-09-23.md §2b item 3: with `merge-style` configured, the
  # recorded handoff-tip SHA (delivery --handoff writes it to <repo-root>/.serpens.yaml, KEYED BY
  # CHANGE-ID, never by branch — a story branch is usually deleted after merge, and archive runs
  # on a fresh close-out branch that never had its own hand-off) is checked against origin/$BASE
  # by the rule the shop's own merge-style implies — a REAL "did MY commits land" check, replacing
  # the plain ancestor proxy below (which stays, unchanged, for an estate that has not set
  # merge-style yet — "in addition to", never a silent fallback between the two once merge-style
  # IS set).
  if [ -n "$DC_MERGE_STYLE" ]; then
    [ -n "$ASSERT_CHANGE_ID" ] || die_state "merge-style=$DC_MERGE_STYLE is set but no --change <change-id> was given" \
      "  ↳ run: bash repository-state.sh assert-archivable --change <change-id>" \
      "  ↳ the handoff tip is recorded per change, never per branch (a story branch is usually deleted after merge)"
    dc_ticket_for_change "$REPO" "$ASSERT_CHANGE_ID" >/dev/null \
      || die_state "no marked change $ASSERT_CHANGE_ID" \
        "  ↳ inspect it: cat \"$REPO/openspec/changes/$ASSERT_CHANGE_ID/.serpens.yaml\"" \
        "  ↳ run: bash repository-state.sh mark-change $ASSERT_CHANGE_ID --ticket <TICKET> first"
    tip=$(dc_latest_handoff_tip "$REPO" "$ASSERT_CHANGE_ID")
    if [ -z "$tip" ]; then
      die_state "merge-style=$DC_MERGE_STYLE is set but no handoff tip is recorded for $ASSERT_CHANGE_ID" \
        "  ↳ run: <serpens-sdd> delivery --handoff --change $ASSERT_CHANGE_ID   (this records the pushed tip in $(dc_estate_path "$REPO"))" \
        "  ↳ run it on the branch you stood on when the merged change was handed off, BEFORE you cut a close-out branch"
    fi
    if ! git -C "$REPO" cat-file -e "$tip" 2>/dev/null; then
      die_state "recorded handoff tip $tip for $branch is not a known commit here" \
        "  ↳ fetch it first: git -C \"$REPO\" fetch origin"
    fi
    # Operator decision, 2026-09-24 (eval part7-b, samples 1/2): a correct refusal must never be
    # answerable by hand-editing `.serpens.yaml`. `delivery --handoff` stamps every record commit
    # with a `Serpens-Handoff-Tip: <full-sha>` trailer — its own proof that IT wrote the record.
    # For `merge`/`rebase` styles (whose individual commits survive into `origin/$BASE`'s own
    # history once the change is genuinely merged), require that trailer to be found there before
    # trusting the tip at all. `squash` is exempt: the record commit's own identity is discarded
    # by a real squash-merge, so this check would always fail there — squash instead leans on the
    # path-set identity check below, which is its own (weaker but real) forgery resistance.
    handoff_record_verified() {
      local base="$1" full_tip="$2"
      [ -n "$(git -C "$REPO" log "origin/$base" -F --grep="Serpens-Handoff-Tip: $full_tip" --format=%H 2>/dev/null | head -1)" ]
    }
    case "$DC_MERGE_STYLE" in
      merge)
        if git -C "$REPO" merge-base --is-ancestor "$tip" "origin/$BASE"; then
          if ! handoff_record_verified "$BASE" "$tip"; then
            die_state "recorded tip ${tip:0:12} has no matching \`delivery --handoff\`-produced record commit in origin/$BASE's history" \
              "  ↳ expected a commit trailer \`Serpens-Handoff-Tip: $tip\` — its absence means this record was likely hand-edited into .serpens.yaml, never produced by the tool" \
              "  ↳ never hand-edit .serpens.yaml or fabricate a handoff-tip line; if this change genuinely was not handed off yet, run: <serpens-sdd> delivery --handoff --change $ASSERT_CHANGE_ID on the branch that carries the real work"
          fi
          echo "✓ merge-style=merge: recorded tip ${tip:0:12} is an ancestor of origin/$BASE, with a verified delivery --handoff record (archivable)"
          exit 0
        fi
        die_state "merge-style=merge check failed: recorded tip ${tip:0:12} is NOT an ancestor of origin/$BASE" \
          "  ↳ inspect it: git -C \"$REPO\" log --oneline origin/$BASE..$tip" \
          "  ↳ the ${DC_FORGE_WORD:-PR} for this tip has not merged into origin/$BASE yet"
        ;;
      rebase)
        cherry_out=$(git -C "$REPO" cherry "origin/$BASE" "$tip" 2>/dev/null || true)
        unapplied=$(printf '%s\n' "$cherry_out" | grep -c '^+' || true)
        if [ "$unapplied" -eq 0 ]; then
          if ! handoff_record_verified "$BASE" "$tip"; then
            die_state "recorded tip ${tip:0:12} has no matching \`delivery --handoff\`-produced record commit in origin/$BASE's history" \
              "  ↳ expected a commit trailer \`Serpens-Handoff-Tip: $tip\` — its absence means this record was likely hand-edited into .serpens.yaml, never produced by the tool" \
              "  ↳ never hand-edit .serpens.yaml or fabricate a handoff-tip line; if this change genuinely was not handed off yet, run: <serpens-sdd> delivery --handoff --change $ASSERT_CHANGE_ID on the branch that carries the real work"
          fi
          echo "✓ merge-style=rebase: every commit up to tip ${tip:0:12} is already applied on origin/$BASE (\`git cherry\` shows no + lines), with a verified delivery --handoff record (archivable)"
          exit 0
        fi
        die_state "merge-style=rebase check failed: $unapplied commit(s) up to tip ${tip:0:12} are NOT applied on origin/$BASE (\`git cherry\` shows + lines)" \
          "  ↳ inspect it: git -C \"$REPO\" cherry origin/$BASE $tip" \
          "  ↳ the rebase-merge for this tip has not landed on origin/$BASE yet"
        ;;
      squash)
        mb=$(git -C "$REPO" merge-base "$tip" "origin/$BASE") \
          || die_state "cannot compute a merge-base of tip ${tip:0:12} and origin/$BASE" \
            "  ↳ they may share no history — inspect: git -C \"$REPO\" log --oneline -1 $tip; git -C \"$REPO\" log --oneline -1 origin/$BASE"
        # `.serpens.yaml` is excluded on purpose: it never carries any of THIS change's own work —
        # `delivery --handoff` commits the record to it AFTER computing tip (T), so T's own diff
        # never includes it; the filter is defensive (spec §2b item 3, second defect) in case some
        # other flow ever touches it earlier.
        paths_tip=$(git -C "$REPO" diff --name-only "$mb" "$tip" | grep -v '^\.serpens\.yaml$' | LC_ALL=C sort)
        paths_base=$(git -C "$REPO" diff --name-only "$mb" "origin/$BASE" | grep -v '^\.serpens\.yaml$' | LC_ALL=C sort)
        if [ "$paths_tip" != "$paths_base" ]; then
          die_state "merge-style=squash check failed: changed paths at tip ${tip:0:12} (since diverging at ${mb:0:12}) differ from origin/$BASE's changed paths over the same range" \
            "  ↳ tip's paths: git -C \"$REPO\" diff --name-only $mb $tip" \
            "  ↳ base's paths: git -C \"$REPO\" diff --name-only $mb origin/$BASE" \
            "  ↳ the squash-merge for this tip has not landed on origin/$BASE yet, or a different change landed instead"
        fi
        tip_count=$(dc_handoff_tips "$REPO" "$ASSERT_CHANGE_ID" | wc -l | tr -d ' ')
        if [ "$tip_count" -le 1 ]; then
          echo "✓ merge-style=squash: changed paths at tip ${tip:0:12} match origin/$BASE's changed paths since diverging (archivable)"
          exit 0
        fi
        # More than one handoff tip recorded for this change means it was handed off again after
        # an earlier squash-merge — spec §2b item 3's fallback: the path-set match alone cannot
        # tell a genuine re-verification apart from a coincidental re-edit of the same files, so a
        # human confirms once, and that confirmation (keyed on THIS exact tip) is never re-asked.
        if dc_squash_confirmed "$REPO" "$ASSERT_CHANGE_ID" "$tip"; then
          echo "✓ merge-style=squash: changed paths match origin/$BASE; the re-edit ambiguity for tip ${tip:0:12} was already confirmed by a human (archivable)"
          exit 0
        fi
        if [ "$CONFIRM_SQUASH_REEDIT" -eq 1 ]; then
          dc_record_squash_confirm "$REPO" "$ASSERT_CHANGE_ID" "$tip"
          echo "✓ merge-style=squash: changed paths match origin/$BASE; re-edit ambiguity confirmed by human for tip ${tip:0:12} — recorded, will not be re-asked (archivable)"
          exit 0
        fi
        die_state "merge-style=squash: changed paths at tip ${tip:0:12} match origin/$BASE, but $tip_count handoff tips are recorded for $ASSERT_CHANGE_ID — this change was handed off again after what looks like an earlier squash-merge, touching the same paths again, which a path-set check alone cannot tell apart from a true match" \
          "  ↳ a human must confirm this is really archivable: re-run with --confirm-squash-reedit" \
          "  ↳ inspect the history since diverging: git -C \"$REPO\" log --oneline $mb..$tip"
        ;;
    esac
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

# BC_TICKET_RE grouped: an ungrouped alternation would split this regex at the `|` and detach
# the ^/$ anchors from every alternative but the last (spec-org-facts-slice-branching-2026-09-11.md
# §7, D1) — same fix as branch-contract.sh's bc_compile and check-git-naming.sh's checks.
if [[ ! "$TICKET" =~ ^(${BC_TICKET_RE})$ ]]; then
  if [ "$BC_CONFIGURED" -eq 0 ]; then
    echo "✗ invalid ticket '$TICKET'; expected ABCD-1234" >&2
  else
    echo "✗ invalid ticket '$TICKET'; expected to match the configured pattern ($BC_PATH): $BC_TICKET_RE" >&2
  fi
  exit 2
fi
# Built from the SAME contract check-git-naming.sh reads (tools/lib/branch-contract.sh) — this
# is the fix for spec-org-facts-slice-branching-2026-09-11.md §7's second finding: this line used
# to hardcode "feature/$TICKET" independently of the hook, so a configured shop could pass the
# hook and still fail this workflow gate on the very same branch.
expected_change="$(bc_render_branch "$TICKET")"

# --checkout switches to an EXISTING story branch. It never creates one: a missing branch means the
# story was never started here, and only spns-spec may decide where a new branch is cut from.
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
        "  ↳ run spns-spec to create it; this tool never cuts a new branch"
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
