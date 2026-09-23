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
  delivery.sh --handoff [--base <branch>] [--conventions <path>] [--repo <path>]
  delivery.sh --confirm-archive-when <after-merge|after-qa-accepted> [--repo <path>]
EOF
}

MODE=""
REPO="."
CONVENTIONS=""
BASE_OVERRIDE=""
ARCHIVE_WHEN_CONFIRM=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-contract) MODE="print-contract"; shift ;;
    --handoff) MODE="handoff"; shift ;;
    --confirm-archive-when) MODE="confirm-archive-when"; ARCHIVE_WHEN_CONFIRM=${2:-}; shift 2 ;;
    --conventions) CONVENTIONS=${2:-}; shift 2 ;;
    --repo) REPO=${2:-}; shift 2 ;;
    --base) BASE_OVERRIDE=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
[ -n "$MODE" ] || { usage; exit 2; }

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

# Records this HEAD as the branch's latest handoff tip (spec §2b item 3): `state
# assert-archivable`'s merge-style-keyed check reads it back. Recorded unconditionally (every
# mode) — the fix loop pushes to the SAME branch name again after an earlier squash/merge, and
# the LATEST tip is what the merged check must compare, with earlier ones kept for the squash
# fallback.
dc_record_handoff_tip "$REPO" "$branch" "$(git -C "$REPO" rev-parse HEAD)"

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
