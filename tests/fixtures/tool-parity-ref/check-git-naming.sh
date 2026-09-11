#!/usr/bin/env bash
# corp-version: 2026-08-26.8
# check-git-naming.sh — enforce the org's branch and commit-message conventions.
#
#   branch          feature/ABCD-1234
#   commit message  feat(ABCD-1234): commit message text
#
# Two modes, one code path per rule:
#   check-git-naming.sh --branch                 # lefthook pre-push (and CI)
#   check-git-naming.sh --commit-msg <file>      # lefthook commit-msg
#
# Operating rule 1: prompts advise, checks enforce. Never fix a red check by weakening it.
# Exit 1 on violation, with the exact expected form. Zero dependencies.
set -uo pipefail

# The ticket key: uppercase project prefix, dash, digits. ABCD-1234.
TICKET_RE='[A-Z][A-Z0-9]+-[0-9]+'
# Conventional-commit types accepted as the message prefix.
TYPE_RE='feat|fix|chore|docs|refactor|test|perf|build|ci|revert'
# Branches exempt from the feature/ rule — long-lived, not created by the flow.
EXEMPT_BRANCH_RE='^(main|master|develop|(release|hotfix|support)/.+)$'

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
  if [[ "$branch" =~ $EXEMPT_BRANCH_RE ]]; then
    echo "✓ branch '$branch' is exempt from the feature/ rule"
    return 0
  fi
  if [[ ! "$branch" =~ ^feature/${TICKET_RE}$ ]]; then
    die "branch name '$branch' does not match the convention" \
        "    expected: feature/ABCD-1234  (uppercase project key, dash, number)" \
        "  ↳ rename it: git branch -m feature/ABCD-1234"
  fi
  echo "✓ branch '$branch' matches feature/<TICKET>"
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

  if [[ ! "$subject" =~ ^(${TYPE_RE})\(${TICKET_RE}\):\ .+ ]]; then
    die "commit subject does not match the convention" \
        "    got:      $subject" \
        "    expected: feat(ABCD-1234): commit message text" \
        "    types:    ${TYPE_RE//|/, }" \
        "  ↳ note the space after the colon, and the ticket in parentheses"
  fi

  # The ticket in the message must be the ticket in the branch. A mismatched
  # ticket links the work to the wrong story and nobody notices until the report.
  local branch msg_ticket branch_ticket
  branch="$(current_branch)"
  if [[ "$branch" =~ ^feature/(${TICKET_RE})$ ]]; then
    branch_ticket="${BASH_REMATCH[1]}"
    [[ "$subject" =~ \((${TICKET_RE})\) ]] && msg_ticket="${BASH_REMATCH[1]}"
    if [ -n "${msg_ticket:-}" ] && [ "$msg_ticket" != "$branch_ticket" ]; then
      die "commit ticket '$msg_ticket' does not match branch ticket '$branch_ticket'" \
          "  ↳ use the branch's ticket, or move the commit to the right branch"
    fi
  fi
  echo "✓ commit subject matches <type>(<TICKET>): <text>"
}

case "${1:-}" in
  --branch)     shift; check_branch "${1:-}" ;;
  --commit-msg) shift; check_commit_msg "${1:?usage: check-git-naming.sh --commit-msg <file>}" ;;
  *) echo "usage: check-git-naming.sh --branch [name] | --commit-msg <file>" >&2; exit 2 ;;
esac
