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
# Three modes, one code path per rule:
#   check-git-naming.sh --branch [name] [--conventions <path>]        # lefthook pre-push (and CI)
#   check-git-naming.sh --commit-msg <file> [--conventions <path>]    # lefthook commit-msg
#   check-git-naming.sh --print-contract [TICKET] [--conventions ...] # what the prompts READ
#
# --print-contract exists so the KIT PROMPTS stop restating the convention. A prompt that spells
# `feature/<TICKET>` and `feat(<TICKET>): <text>` in its own words is a second, unenforced copy of
# this contract: a shop that configures `release/<TICKET>` in serpens/branching.md gets hooks
# that accept its shape and prompts that still tell the agent to build the old one. The agent asks
# for the shape instead, and the answer comes from the same bc_* contract both guards compile, so
# prompt, pre-push hook and assert-change cannot disagree. Output is stable `key<TAB>value` lines,
# one per line, for a human and a model to read alike.
#
# Operating rule 1: prompts advise, checks enforce. Never fix a red check by weakening it.
# Exit 1 on violation, with the exact expected form. Zero dependencies.
set -uo pipefail

BC_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=./lib/branch-contract.sh
source "$BC_SELF_DIR/lib/branch-contract.sh"
# shellcheck source=./lib/ownership.sh
source "$BC_SELF_DIR/lib/ownership.sh"

# First line carries the ✗; the rest are continuation detail, so they stay unmarked.
die() { printf '✗ %s\n' "$1" >&2; shift; for l in "$@"; do printf '%s\n' "$l" >&2; done; exit 1; }

current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null
}

# is_serpens_work — gap 1, serpens-openspec-coexistence-gaps-2026-09-22.md, step 3, "Branch/
# commit-msg". A team running vanilla OpenSpec beside this kit must never have their own
# branch or commit message refused by OUR naming convention. Enforce only when the work in
# front of us is ours:
#   1. the current branch equals the `branch:` field of some ACTIVE, marked change (the exact
#      branch `serpens-sdd state mark-change` recorded when the change was created), OR
#   2. the staged set (commit-msg and pre-commit both run against the same index) contains at
#      least one Serpens-owned path (tools/lib/ownership.sh's is_owned_path — under serpens/, or
#      under a marked openspec/changes/<id>/).
# DEVIATION (recorded in the spec, step 3): the design also names a THIRD signal for pre-push —
# "the pushed range touches [an owned path]". `check-git-naming.sh --branch` is invoked
# IDENTICALLY by the pre-commit `serpens-branch` command and the pre-push `serpens-branch`
# command (src/shim.mjs's renderLefthook) — lefthook passes this tool no distinguishing flag and
# no push-range argument, so there is nothing here to read a "pushed range" from. Signal 2 (the
# staged set) is reused for pre-push too: an operator pushing already has whatever they last
# committed as their working tree's staged/HEAD state, which for a linear feature-branch history
# still answers "is this branch's work ours?" honestly enough not to block a vanilla push. A
# richer pre-push-specific signal is out of scope here — see the spec for a fuller fix.
is_serpens_work() {
  local branch root dir marker escaped_branch
  branch="$(current_branch)"
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
    escaped_branch=$(printf '%s' "$branch" | sed 's/[.[\*^$/]/\\&/g')
    for dir in "$root"/openspec/changes/*/; do
      [ -d "$dir" ] || continue
      marker="${dir%/}/.serpens.yaml"
      [ -f "$marker" ] || continue
      is_owned_change "${dir%/}" || continue
      if grep -Eq "^branch:[[:space:]]*${escaped_branch}[[:space:]]*\$" "$marker" 2>/dev/null; then
        return 0
      fi
    done
  fi
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    is_owned_path "$f" "$root" && return 0
  done < <(git -C "$root" diff --cached --name-only 2>/dev/null)
  return 1
}

check_branch() {
  local branch="${1:-$(current_branch)}"
  [ -z "$branch" ] && die "not inside a git repository"
  if ! is_serpens_work; then
    echo "⚠ branch '$branch' is not a Serpens branch — unchecked"
    return 0
  fi
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
      echo "⚠ branch '$branch' matches no configured convention — UNCHECKED (add serpens/branching.md to cover release/hotfix/support branches too)"
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
  if ! is_serpens_work; then
    echo "⚠ commit is not Serpens work — unchecked"
    return 0
  fi
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

# Render one example that actually satisfies the contract in force. A shop's ticket-pattern is
# arbitrary, so no fixed sample can be assumed to match it: try the caller's ticket first, then
# the two built-in samples, and print nothing rather than an example the very check below would
# reject. A wrong example in a prompt is worse than no example — the agent would copy it.
bc_example_ticket() {
  local candidate
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue
    [[ "$candidate" =~ ^(${BC_TICKET_RE})$ ]] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

print_contract() {
  local want_ticket="${1:-}" example=""
  if [ -n "$want_ticket" ] && ! bc_example_ticket "$want_ticket" >/dev/null; then
    die "ticket '$want_ticket' does not match the ticket pattern in force" \
        "    pattern: $BC_TICKET_RE" \
        "  ↳ use your tracker's real key, or call --print-contract with no argument"
  fi
  example="$(bc_example_ticket "$want_ticket" 'ABCD-1234' 'EXAMPLE-1' || true)"

  if [ "$BC_CONFIGURED" -eq 1 ]; then
    printf 'source\t%s\n' "$BC_PATH"
  else
    printf 'source\tbuilt-in defaults (no branching-contract block at %s)\n' "$BC_PATH"
  fi
  printf 'ticket-pattern\t%s\n' "$BC_TICKET_RE"
  printf 'branch-pattern\t%s\n' "$BC_BRANCH_PATTERN"
  printf 'commit-form\t<type>(<TICKET>): <text>\n'
  printf 'commit-types\t%s\n' "${BC_TYPE_RE//|/, }"
  if [ -n "$example" ]; then
    printf 'branch-example\t%s\n' "$(bc_render_branch "$example")"
    printf 'commit-example\t%s(%s): commit message text\n' "${BC_TYPE_RE%%|*}" "$example"
  else
    # Honest silence: see bc_example_ticket. The shape above is still complete on its own.
    printf 'branch-example\t(none — pass your ticket key to see one)\n'
    printf 'commit-example\t(none — pass your ticket key to see one)\n'
  fi
  if [ -n "$BC_EXEMPT_RE" ]; then
    printf 'exempt-branches\t%s\n' "$BC_EXEMPT_RE"
  elif [ "$BC_CONFIGURED" -eq 0 ]; then
    printf 'exempt-branches\t%s\n' "$BC_DEFAULT_LONGLIVED_RE"
  else
    printf 'exempt-branches\tnone\n'
  fi
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
  --branch)         shift; check_branch "${1:-}" ;;
  --commit-msg)     shift; check_commit_msg "${1:?usage: check-git-naming.sh --commit-msg <file>}" ;;
  --print-contract) shift; print_contract "${1:-}" ;;
  *) echo "usage: check-git-naming.sh --branch [name] | --commit-msg <file> | --print-contract [TICKET]" >&2; exit 2 ;;
esac
