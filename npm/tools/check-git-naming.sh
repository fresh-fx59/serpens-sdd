#!/usr/bin/env bash
# No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
# check-git-naming.sh — enforce the shop's branch and commit-message conventions.
#
# With NO conventions file, the built-in default applies (unchanged from before this file read
# a contract at all):
#   branch          feature/ABCD-1234
#   commit message  feat(ABCD-1234): commit message text
#
# With a conventions file (see tools/lib/branch-contract.sh for the resolution order and the
# machine-readable block's shape), both the branch shape and the ticket shape come from it
# instead — and `repository-state.sh`'s assert-change mode reads the exact same contract, so a
# shop that configures one is never left with a hook and a workflow gate that disagree.
#
# Two modes, one code path per rule:
#   check-git-naming.sh --branch [name] [--conventions <path>]     # lefthook pre-push (and CI)
#   check-git-naming.sh --commit-msg <file> [--conventions <path>] # lefthook commit-msg
#
# Operating rule 1: prompts advise, checks enforce. Never fix a red check by weakening it.
# Exit 1 on violation, with the exact expected form. Zero dependencies.
set -uo pipefail

BC_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./lib/branch-contract.sh
source "$BC_SELF_DIR/lib/branch-contract.sh"

# First line carries the ✗; the rest are continuation detail, so they stay unmarked.
die() { printf '✗ %s\n' "$1" >&2; shift; for l in "$@"; do printf '%s\n' "$l" >&2; done; exit 1; }

current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null
}

check_branch() {
  local branch="${1:-$(current_branch)}"
  [ -z "$branch" ] && die "not inside a git repository"
  if [ "$branch" = "HEAD" ]; then
    echo "⚠ detached HEAD — skipping branch-name check"
    return 0
  fi

  if [ "$BC_CONFIGURED" -eq 0 ]; then
    # No conventions file: today's exact behaviour, split into its two honest halves.
    # main/master/develop really are exempt; release/hotfix/support were folded into the same
    # "exempt" bucket before this file existed, which silently left them UNCHECKED rather than
    # actually exempt — see spec-org-facts-slice-branching-2026-09-11.md §2/§7.
    if [[ "$branch" =~ $BC_DEFAULT_LONGLIVED_RE ]]; then
      echo "✓ branch '$branch' is exempt from the feature/ rule"
      return 0
    fi
    if [[ "$branch" =~ $BC_DEFAULT_TRAP_RE ]]; then
      echo "⚠ branch '$branch' matches no configured convention — UNCHECKED (add conventions/branching.md to cover release/hotfix/support branches too)"
      return 0
    fi
    # BC_TICKET_RE is grouped: an ungrouped alternation would otherwise split this whole regex
    # at the `|`, detaching the ^feature/ prefix and $ anchor from every alternative but the
    # last (spec-org-facts-slice-branching-2026-09-11.md §7, D1).
    if [[ ! "$branch" =~ ^feature/(${BC_TICKET_RE})$ ]]; then
      die "branch name '$branch' does not match the convention" \
          "    expected: feature/ABCD-1234  (uppercase project key, dash, number)" \
          "  ↳ rename it: git branch -m feature/ABCD-1234"
    fi
    echo "✓ branch '$branch' matches feature/<TICKET>"
    return 0
  fi

  # A conventions file is present: use its exempt set, its branch shape, its ticket shape.
  if [ -n "$BC_EXEMPT_RE" ] && [[ "$branch" =~ $BC_EXEMPT_RE ]]; then
    echo "✓ branch '$branch' is exempt from the configured convention"
    return 0
  fi
  if [[ ! "$branch" =~ $BC_BRANCH_REGEX ]]; then
    die "branch name '$branch' does not match the configured convention ($BC_PATH)" \
        "    expected shape: $BC_BRANCH_PATTERN" \
        "  ↳ rename it, e.g.: git branch -m $(bc_render_branch EXAMPLE-1)"
  fi
  echo "✓ branch '$branch' matches $BC_BRANCH_PATTERN"
}

check_commit_msg() {
  local file="$1"
  [ -f "$file" ] || die "commit message file not found: $file"
  # First non-comment, non-empty line is the subject.
  local subject
  subject="$(grep -v '^#' "$file" | grep -v '^[[:space:]]*$' | head -1)"
  [ -z "$subject" ] && die "empty commit message"

  # Git-generated commits are not authored prose — never block them.
  case "$subject" in
    "Merge "*|"Revert \""*|"fixup! "*|"squash! "*)
      echo "⚠ generated commit subject — skipping message check"; return 0 ;;
  esac

  # BC_TICKET_RE grouped for the same reason as the branch check above: unguarded, an
  # alternation inside it would split this regex at the `|` and detach the `<type>(` prefix
  # from every ticket alternative but the last, letting an incomplete subject like
  # `feat(AA-123` (no closing paren, no message) match.
  if [[ ! "$subject" =~ ^(${BC_TYPE_RE})\((${BC_TICKET_RE})\):\ .+ ]]; then
    if [ "$BC_CONFIGURED" -eq 0 ]; then
      die "commit subject does not match the convention" \
          "    got:      $subject" \
          "    expected: feat(ABCD-1234): commit message text" \
          "    types:    ${BC_TYPE_RE//|/, }" \
          "  ↳ note the space after the colon, and the ticket in parentheses"
    else
      die "commit subject does not match the configured convention ($BC_PATH)" \
          "    got:      $subject" \
          "    expected: <type>(<TICKET>): commit message text" \
          "    types:    ${BC_TYPE_RE//|/, }" \
          "  ↳ note the space after the colon, and the ticket in parentheses"
    fi
  fi

  # The ticket in the message must be the ticket in the branch. A mismatched ticket links the
  # work to the wrong story and nobody notices until the report — checked under whatever branch
  # shape is actually in force (the built-in feature/<TICKET>, or the configured pattern), never
  # hardcoded to feature/ the way this used to be.
  local branch msg_ticket branch_ticket
  branch="$(current_branch)"
  if [[ "$branch" =~ $BC_BRANCH_REGEX_CAP ]]; then
    branch_ticket="${BASH_REMATCH[1]}"
    [[ "$subject" =~ \((${BC_TICKET_RE})\) ]] && msg_ticket="${BASH_REMATCH[1]}"
    if [ -n "${msg_ticket:-}" ] && [ "$msg_ticket" != "$branch_ticket" ]; then
      die "commit ticket '$msg_ticket' does not match branch ticket '$branch_ticket'" \
          "  ↳ use the branch's ticket, or move the commit to the right branch"
    fi
  fi
  echo "✓ commit subject matches <type>(<TICKET>): <text>"
}

# --conventions <path> is accepted anywhere in argv and pulled out before the mode dispatch, so
# it can be passed before or after --branch/--commit-msg without disturbing either one's own
# (optional, positional) argument.
CONVENTIONS=""
ARGV=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --conventions) CONVENTIONS=${2:-}; shift 2 ;;
    *) ARGV+=("$1"); shift ;;
  esac
done
set -- "${ARGV[@]:-}"
[ "${#ARGV[@]}" -eq 0 ] && set --

bc_load "$CONVENTIONS" "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

case "${1:-}" in
  --branch)     shift; check_branch "${1:-}" ;;
  --commit-msg) shift; check_commit_msg "${1:?usage: check-git-naming.sh --commit-msg <file>}" ;;
  *) echo "usage: check-git-naming.sh --branch [name] | --commit-msg <file>" >&2; exit 2 ;;
esac
