#!/usr/bin/env bash
# No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
# delivery.sh — read the delivery-convention contract (forge word, who opens the PR, ticket
# topology, approvals, merge order/style, integration/release branch, archive timing, hand-off
# routing) and print what the kit prose needs instead of restating it.
# spec-org-facts-slice-delivery-2026-09-23.md §5.
#
#   delivery.sh --print-contract [--conventions <path>] [--repo <path>]
#   delivery.sh --handoff [--base <branch>] [--conventions <path>] [--repo <path>]
#
# Operating rule: prompts advise, checks enforce. This script never opens a PR, never posts to a
# tracker itself (§2c item 12's chat+ticket posting is the caller's job, driven by this script's
# printed facts) — it only reads git state and the contract, and prints.
set -uo pipefail

BC_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./lib/branch-contract.sh
source "$BC_SELF_DIR/lib/branch-contract.sh"
# shellcheck source=./lib/delivery-contract.sh
source "$BC_SELF_DIR/lib/delivery-contract.sh"

die() { printf '✗ %s\n' "$1" >&2; shift; for l in "$@"; do printf '%s\n' "$l" >&2; done; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage:
  delivery.sh --print-contract [--conventions <path>] [--repo <path>]
  delivery.sh --handoff [--change <change-id>] [--base <branch>] [--conventions <path>] [--repo <path>]
  delivery.sh --confirm-archive-when <after-merge|after-qa-accepted> [--repo <path>]
EOF
}

MODE=""
REPO="."
CONVENTIONS=""
BASE_OVERRIDE=""
ARCHIVE_WHEN_CONFIRM=""
CHANGE_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-contract) MODE="print-contract"; shift ;;
    --handoff) MODE="handoff"; shift ;;
    --confirm-archive-when) MODE="confirm-archive-when"; ARCHIVE_WHEN_CONFIRM=${2:-}; shift 2 ;;
    --conventions) CONVENTIONS=${2:-}; shift 2 ;;
    --repo) REPO=${2:-}; shift 2 ;;
    --base) BASE_OVERRIDE=${2:-}; shift 2 ;;
    --change) CHANGE_ARG=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
[ -n "$MODE" ] || { usage; exit 2; }
if [ "$MODE" != handoff ] && [ -n "$CHANGE_ARG" ]; then
  echo "✗ --change is valid only with --handoff" >&2
  exit 2
fi

repo_top=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$repo_top" ] || die "not a Git repository: $REPO"
REPO=$(cd "$repo_top" && pwd -P)

dc_load "$CONVENTIONS" "$REPO"

print_contract() {
  printf 'forge-word=%s\n' "$DC_FORGE_WORD"
  printf 'pr-opened-by=%s\n' "$DC_PR_OPENED_BY"
  printf 'ticket-topology=%s\n' "$DC_TICKET_TOPOLOGY"
  printf 'child-created-by=%s\n' "$DC_CHILD_CREATED_BY"
  printf 'proposal-approval=%s\n' "$DC_PROPOSAL_APPROVAL"
  printf 'test-plan-posted-to=%s\n' "$DC_TEST_PLAN_POSTED_TO"
  printf 'merge-order=%s\n' "$DC_MERGE_ORDER"
  printf 'review-may-merge=%s\n' "$DC_REVIEW_MAY_MERGE"
  printf 'integration-branch=%s\n' "$(dc_resolved_integration_branch "$REPO" 2>/dev/null || printf '%s' "${DC_INTEGRATION_BRANCH:-UNKNOWN}")"
  printf 'release-branch=%s\n' "$DC_RELEASE_BRANCH"
  printf 'archive-when=%s\n' "$DC_ARCHIVE_WHEN"
  printf 'merge-style=%s\n' "${DC_MERGE_STYLE:-UNSET}"
  printf 'handoff-to=%s\n' "$DC_HANDOFF_TO"
  if [ "$DC_CONFIGURED" -eq 1 ]; then
    printf 'source=%s\n' "$DC_PATH"
  else
    printf 'source=defaults\n'
  fi
}

if [ "$MODE" = print-contract ]; then
  print_contract
  exit 0
fi

# --confirm-archive-when: records the human's one-time answer for this estate (spec §2b item 2 /
# §8 "archive-when asked once"). The KIT (spns-archive step 0) is what actually asks the question
# when `dc_archive_when_confirmed` reports nothing recorded yet; this is only the recording half —
# a CLI never assembles a question on its own.
if [ "$MODE" = confirm-archive-when ]; then
  case "$ARCHIVE_WHEN_CONFIRM" in
    after-merge|after-qa-accepted) ;;
    *) die "--confirm-archive-when must be after-merge or after-qa-accepted, got: $ARCHIVE_WHEN_CONFIRM" ;;
  esac
  dc_record_archive_when_confirm "$REPO" "$ARCHIVE_WHEN_CONFIRM"
  echo "✓ recorded archive-when=$ARCHIVE_WHEN_CONFIRM for this estate ($(dc_estate_path "$REPO")); not asked again"
  exit 0
fi

# --handoff: the one place the manual-PR hand-off is assembled, so the agent never composes it
# by hand (spec §5). Reads the current branch, its upstream (fails if unpushed or ahead of
# upstream), and the base from the same resolver repository-state.sh uses (BASE_OVERRIDE, then
# the contract's integration-branch / detection order).
branch=$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
[ -n "$branch" ] || die "detached HEAD" "  ↳ inspect it: git -C \"$REPO\" log -1 --oneline"

upstream=$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
[ -n "$upstream" ] || die "$branch has no upstream — push it first" "  ↳ git -C \"$REPO\" push -u origin $branch"

git -C "$REPO" fetch --quiet origin 2>/dev/null || true
counts=$(git -C "$REPO" rev-list --left-right --count "HEAD...$upstream" 2>/dev/null || printf '0\t0')
ahead=${counts%%[[:space:]]*}
[ "$ahead" -eq 0 ] || die "$branch is $ahead commit(s) ahead of $upstream — push first" "  ↳ git -C \"$REPO\" push"

if [ -n "$BASE_OVERRIDE" ]; then
  base="$BASE_OVERRIDE"
else
  base="$(dc_resolved_integration_branch "$REPO")" \
    || die "cannot determine the integration branch" "  ↳ set it in serpens/delivery.md, or pass --base <branch>"
fi

# A branch with nothing beyond the base has nothing to hand off. Recording its tip would be a
# false "merged" later: that tip IS origin/<base>'s own commit, so every merge-style check passes
# (eval 2026-09-24, scenario b — a freshly cut, still-empty close-out branch was handed off).
if git -C "$REPO" rev-parse --verify --quiet "refs/remotes/origin/$base" >/dev/null \
  && git -C "$REPO" merge-base --is-ancestor HEAD "origin/$base"; then
  die "$branch has no commits beyond origin/$base — nothing to hand off" \
    "  ↳ commit the work for this branch first, push it, then run --handoff again"
fi

subject=$(git -C "$REPO" log -1 --pretty=%s HEAD 2>/dev/null || true)
title="feat: ${subject:-$branch}"
if [[ "$subject" =~ ^[a-z]+\([A-Za-z0-9-]+\): ]]; then
  title="$subject"
fi

if [ "$DC_PR_OPENED_BY" = human ]; then
  echo "${DC_FORGE_WORD} is opened by a human in this shop. Do not create it."
else
  echo "You may open the ${DC_FORGE_WORD}."
fi
handoff_line1="${DC_PR_OPENED_BY:+}"
if [ "$DC_PR_OPENED_BY" = human ]; then
  handoff_line1="${DC_FORGE_WORD} is opened by a human in this shop. Do not create it."
else
  handoff_line1="You may open the ${DC_FORGE_WORD}."
fi
handoff_line2="Pushed branch: $branch"
handoff_line3="Target branch: $base"
handoff_line4="Suggested title: $title"

echo "$handoff_line1"
echo "$handoff_line2"
echo "$handoff_line3"
echo "$handoff_line4"

# Resolve WHICH marked change this hand-off belongs to: the record below is keyed by change-id
# (+ticket), never by branch — a story branch is usually deleted after merge, and archive runs on
# a fresh close-out branch that never had its own hand-off (spec §2b item 3).
bc_load "" "$REPO"
hoff_change_id="$CHANGE_ARG"
hoff_ticket=""
if [ -n "$hoff_change_id" ]; then
  hoff_ticket="$(dc_ticket_for_change "$REPO" "$hoff_change_id")" \
    || die "no marked change $hoff_change_id" \
      "  ↳ inspect it: cat \"$REPO/openspec/changes/$hoff_change_id/.serpens.yaml\"" \
      "  ↳ run: <serpens-sdd> state mark-change $hoff_change_id --ticket <TICKET> first"
else
  if [[ "$branch" =~ $BC_BRANCH_REGEX_CAP ]]; then
    hoff_ticket="${BASH_REMATCH[1]}"
  fi
  [ -n "$hoff_ticket" ] || die "cannot derive a ticket from branch $branch" \
    "  ↳ pass --change <change-id> explicitly"
  # A marked change (openspec/changes/<id>/.serpens.yaml) is the precise key while it exists —
  # but `<openspec> archive` FOLDS that directory away (spns-archive step 1), and step 5's own
  # close-out hand-off runs AFTER the fold, for the close-out commit itself, not for the
  # already-merged change the fold just closed. Falling back to the TICKET as the key (still
  # never the branch — the bug this fixes) keeps that call working instead of hard-erroring on a
  # marker that has legitimately stopped existing.
  hoff_change_id="$(dc_change_for_ticket "$REPO" "$hoff_ticket")" || hoff_change_id="$hoff_ticket"
fi

# Records T (this HEAD — the last pushed WORK commit) as the change's latest handoff tip (spec
# §2b item 3): `state assert-archivable`'s merge-style-keyed check reads it back, keyed by
# change-id, never by branch. Recorded unconditionally (every mode) — the fix loop hands off the
# SAME change again after an earlier squash/merge, and the LATEST tip is what the merged check
# must compare, with earlier ones kept for the squash fallback.
#
# The record itself is committed and pushed HERE, as its own commit — never left as a dirty
# tracked file (spec §2b item 3, second defect: a hand-off used to leave `.serpens.yaml` dirty,
# which every subsequent gate then refused as "uncommitted changes to TRACKED files"). Every check
# that reads the record back keys off T, the SHA the line names, never off this record commit.
estate_path="$(dc_estate_path "$REPO")"
tip_sha="$(git -C "$REPO" rev-parse HEAD)"
# HEAD may itself be an earlier --handoff's own record commit for this exact change/ticket (this
# same branch, no new work since) — its parent is T, the last pushed WORK commit, not this commit.
# Unwrap it so a repeated --handoff never mistakes its own previous record commit for new work.
head_subject="$(git -C "$REPO" log -1 --pretty=%s "$tip_sha" 2>/dev/null || true)"
if [[ "$head_subject" == "chore(${hoff_ticket}): record handoff "* ]]; then
  changed="$(git -C "$REPO" diff --name-only "${tip_sha}^" "$tip_sha" 2>/dev/null)"
  if [ "$changed" = "$(basename "$estate_path")" ]; then
    tip_sha="$(git -C "$REPO" rev-parse "${tip_sha}^")"
  fi
fi
dc_record_handoff_tip "$REPO" "$hoff_change_id" "$hoff_ticket" "$tip_sha"
if [ -n "$(git -C "$REPO" status --porcelain --ignore-submodules=untracked -- "$estate_path" 2>/dev/null)" ]; then
  short_tip="${tip_sha:0:7}"
  git -C "$REPO" add -- "$estate_path" \
    || die "cannot stage $estate_path"
  # The `Serpens-Handoff-Tip:` trailer (full SHA) is what lets `state assert-archivable` tell a
  # tool-produced record apart from a hand-edited one (operator decision, 2026-09-24: a correct
  # refusal must never be worked around by hand-editing `.serpens.yaml` — see the kit prose next
  # to every `state assert-archivable`/`delivery --handoff` call). Never fake this trailer by
  # hand: it is the CLI's own proof that IT wrote this record.
  git -C "$REPO" commit --quiet \
    -m "chore(${hoff_ticket}): record handoff ${short_tip}" \
    -m "Serpens-Handoff-Tip: ${tip_sha}" \
    -- "$estate_path" \
    || die "cannot commit the handoff record" "  ↳ inspect it: git -C \"$REPO\" status --short"
  git -C "$REPO" push --quiet origin "HEAD:$branch" \
    || die "cannot push the handoff record commit" "  ↳ push it yourself: git -C \"$REPO\" push origin HEAD:$branch"
  echo "✓ recorded handoff tip ${short_tip} for $hoff_change_id (ticket $hoff_ticket); committed + pushed, tree clean" >&2
else
  echo "✓ handoff tip for $hoff_change_id (ticket $hoff_ticket) already recorded; nothing new to commit" >&2
fi

# handoff-to=chat+ticket (spec §2c item 12): the same three facts, in addition to chat, posted as
# a ticket comment — a tracker must be configured, or this errors naming the gap rather than
# silently degrading to chat-only. "configured" here is the same fact port-facts.md's `tracker`
# row already carries (UNFILLED counts as unconfigured); a test double sets
# SERPENS_SDD_TRACKER_CMD to a stub instead of a real forge/tracker call.
if [ "$DC_HANDOFF_TO" = "chat+ticket" ]; then
  tracker_cmd="${SERPENS_SDD_TRACKER_CMD:-}"
  if [ -z "$tracker_cmd" ]; then
    portfacts="$REPO/serpens/port-facts.md"
    if [ -f "$portfacts" ] && grep -qE '^\| *`?tracker`? *\|' "$portfacts" 2>/dev/null; then
      trow=$(grep -E '^\| *`?tracker`? *\|' "$portfacts" | head -1)
      case "$trow" in *UNFILLED*|*unfilled*) : ;; *) tracker_cmd="__portfacts__" ;; esac
    fi
  fi
  if [ -z "$tracker_cmd" ]; then
    die "handoff-to=chat+ticket requires a configured tracker; none found" \
      "  ↳ set SERPENS_SDD_TRACKER_CMD to the posting command, or fill the tracker fact in serpens/port-facts.md" \
      "  ↳ this hand-off was still printed to chat above; nothing was posted anywhere"
  fi
  comment_text="$(printf '%s\n%s\n%s\n%s\n' "$handoff_line1" "$handoff_line2" "$handoff_line3" "$handoff_line4")"
  if [ "$tracker_cmd" != "__portfacts__" ]; then
    printf '%s' "$comment_text" | eval "$tracker_cmd" \
      || die "handoff-to=chat+ticket: SERPENS_SDD_TRACKER_CMD failed" "  ↳ command: $tracker_cmd"
  fi
  echo "✓ handoff-to=chat+ticket: posted the hand-off above as a ticket comment" >&2
fi

exit 0
