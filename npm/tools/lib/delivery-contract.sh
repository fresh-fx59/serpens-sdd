# delivery-contract.sh — the ONE delivery-convention contract (forge word, who opens the PR,
# ticket topology, approvals, merge order/style, integration/release branch, archive timing,
# hand-off routing), read by `delivery --print-contract` / `delivery --handoff` and by
# `repository-state.sh`'s `expected_base()` / `assert-archivable`.
# spec-org-facts-slice-delivery-2026-09-23.md §4/§5 — same shape as tools/lib/branch-contract.sh
# (spec-org-facts-slice-branching-2026-09-11.md): resolution order, anchor-plus-strict-table
# parsing, fenced examples invisible, presence+malformed is always fatal, absence/unanchored is
# defaults.
#
# RESOLUTION ORDER for the conventions file:
#   1. an explicit --conventions <path>, passed by the caller;
#   2. the SERPENS_SDD_CONVENTIONS_DELIVERY environment variable;
#   3. the default location, <repo-root>/serpens/delivery.md.
#
#   <!-- serpens:section delivery-contract -->
#   | Field | Value |
#   |---|---|
#   | `forge-word`          | PR |
#   | `pr-opened-by`        | human |
#   | `ticket-topology`     | parent-story+child-per-repo |
#   | `child-created-by`    | ask |
#   | `proposal-approval`   | analyst-in-story |
#   | `test-plan-posted-to` | same-ticket-comment |
#   | `merge-order`         | producer,consumers,store-contract |
#   | `review-may-merge`    | no |
#   | `integration-branch`  | develop |
#   | `release-branch`      | master |
#   | `archive-when`        | after-qa-accepted |
#   | `merge-style`         | merge |
#   | `handoff-to`          | chat |
#
# `## Team notes` (or any prose outside the anchored section, or inside a fence) is invisible to
# this parser on purpose (spec §2b item 6) — no gate or test may ever read it.
set -uo pipefail

DC_FIELDS="forge-word pr-opened-by ticket-topology child-created-by proposal-approval test-plan-posted-to merge-order review-may-merge integration-branch release-branch archive-when merge-style handoff-to"

# ---- built-in defaults (today's kit behaviour, §4) --------------------------------------------
DC_DEFAULT_FORGE_WORD="PR"
DC_DEFAULT_PR_OPENED_BY="human"
DC_DEFAULT_TICKET_TOPOLOGY="parent-story+child-per-repo"
DC_DEFAULT_CHILD_CREATED_BY="ask"
DC_DEFAULT_PROPOSAL_APPROVAL="analyst-in-story"
DC_DEFAULT_TEST_PLAN_POSTED_TO="same-ticket-comment"
DC_DEFAULT_MERGE_ORDER="producer,consumers,store-contract"
DC_DEFAULT_REVIEW_MAY_MERGE="no"
# integration-branch has no static default: §2b keeps repository-state.sh's own detection order
# (origin/develop if present, else origin/HEAD) as the default BEHAVIOUR, not a literal string.
# DC_INTEGRATION_BRANCH is left empty when unset; callers that need "the resolved branch, not
# just the field" call dc_resolved_integration_branch (below), which reproduces that order.
DC_DEFAULT_RELEASE_BRANCH="master"
DC_DEFAULT_ARCHIVE_WHEN="after-qa-accepted"
DC_DEFAULT_HANDOFF_TO="chat"
# merge-style has NO default — §4: "none — required once the merged check is wired". Left empty.

# ---- resolved contract (populated by dc_load) --------------------------------------------------
DC_PATH=""
DC_CONFIGURED=0
DC_FORGE_WORD=""
DC_PR_OPENED_BY=""
DC_TICKET_TOPOLOGY=""
DC_CHILD_CREATED_BY=""
DC_PROPOSAL_APPROVAL=""
DC_TEST_PLAN_POSTED_TO=""
DC_MERGE_ORDER=""
DC_REVIEW_MAY_MERGE=""
DC_INTEGRATION_BRANCH=""
DC_RELEASE_BRANCH=""
DC_ARCHIVE_WHEN=""
DC_MERGE_STYLE=""
DC_HANDOFF_TO=""

dc_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Reuses branch-contract.sh's table-cell splitter (bc_table_cells) — this lib is always sourced
# alongside it (repository-state.sh, delivery.sh both source branch-contract.sh first). Fails
# loudly if it is somehow missing, rather than silently duplicating the escaping rule.
dc_table_cells() {
  if ! declare -f bc_table_cells >/dev/null 2>&1; then
    echo "✗ delivery-contract.sh requires tools/lib/branch-contract.sh sourced first (bc_table_cells missing)" >&2
    exit 2
  fi
  bc_table_cells "$1"
}

dc_die() {
  local path="$1" line="$2" msg="$3"
  printf '✗ %s:%s: %s\n' "$path" "$line" "$msg" >&2
  exit 1
}

dc_resolve_conventions_path() {
  local explicit="${1:-}" root="${2:-}"
  if [ -n "$explicit" ]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [ -n "${SERPENS_SDD_CONVENTIONS_DELIVERY:-}" ]; then
    printf '%s\n' "$SERPENS_SDD_CONVENTIONS_DELIVERY"
    return 0
  fi
  if [ -z "$root" ]; then
    root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  fi
  printf '%s/serpens/delivery.md\n' "$root"
}

dc_use_defaults() {
  DC_CONFIGURED=0
  DC_FORGE_WORD="$DC_DEFAULT_FORGE_WORD"
  DC_PR_OPENED_BY="$DC_DEFAULT_PR_OPENED_BY"
  DC_TICKET_TOPOLOGY="$DC_DEFAULT_TICKET_TOPOLOGY"
  DC_CHILD_CREATED_BY="$DC_DEFAULT_CHILD_CREATED_BY"
  DC_PROPOSAL_APPROVAL="$DC_DEFAULT_PROPOSAL_APPROVAL"
  DC_TEST_PLAN_POSTED_TO="$DC_DEFAULT_TEST_PLAN_POSTED_TO"
  DC_MERGE_ORDER="$DC_DEFAULT_MERGE_ORDER"
  DC_REVIEW_MAY_MERGE="$DC_DEFAULT_REVIEW_MAY_MERGE"
  DC_INTEGRATION_BRANCH=""
  DC_RELEASE_BRANCH="$DC_DEFAULT_RELEASE_BRANCH"
  DC_ARCHIVE_WHEN="$DC_DEFAULT_ARCHIVE_WHEN"
  DC_MERGE_STYLE=""
  DC_HANDOFF_TO="$DC_DEFAULT_HANDOFF_TO"
}

# Validate `merge-order` is a permutation of producer,consumers,store-contract (§4).
dc_valid_merge_order() {
  local v="$1"
  case ",$v," in
    *,producer,*'consumers'*'store-contract'*) ;;
    *) : ;;
  esac
  local IFS_OLD="$IFS" tok seen_p=0 seen_c=0 seen_s=0 n=0
  IFS=','
  for tok in $v; do
    tok="$(dc_trim "$tok")"
    n=$((n + 1))
    case "$tok" in
      producer) [ "$seen_p" -eq 0 ] || { IFS="$IFS_OLD"; return 1; }; seen_p=1 ;;
      consumers) [ "$seen_c" -eq 0 ] || { IFS="$IFS_OLD"; return 1; }; seen_c=1 ;;
      store-contract) [ "$seen_s" -eq 0 ] || { IFS="$IFS_OLD"; return 1; }; seen_s=1 ;;
      *) IFS="$IFS_OLD"; return 1 ;;
    esac
  done
  IFS="$IFS_OLD"
  [ "$n" -eq 3 ] && [ "$seen_p" -eq 1 ] && [ "$seen_c" -eq 1 ] && [ "$seen_s" -eq 1 ]
}

# Parse a conventions file already known to exist. Mirrors bc_load_file's structure exactly.
dc_load_file() {
  local path="$1" explicit="${2:-0}"
  local in_section=0 in_fence=0 lineno=0 section_line=0
  local val_forge="" val_pr="" val_topo="" val_child="" val_proposal="" val_testplan=""
  local val_mergeorder="" val_review="" val_integ="" val_release="" val_archwhen=""
  local val_mergestyle="" val_handoff=""
  local ln_forge=0 ln_pr=0 ln_topo=0 ln_child=0 ln_proposal=0 ln_testplan=0
  local ln_mergeorder=0 ln_review=0 ln_integ=0 ln_release=0 ln_archwhen=0 ln_mergestyle=0 ln_handoff=0
  local raw t

  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    raw="${raw%$'\r'}"
    t="$(dc_trim "$raw")"

    if [[ "$t" =~ ^(\`\`\`+|~~~+) ]]; then
      if [ "$in_fence" -eq 0 ]; then in_fence=1; else in_fence=0; fi
      continue
    fi
    [ "$in_fence" -eq 1 ] && continue

    if [[ "$t" =~ ^\<!--[[:space:]]*serpens:section[[:space:]]+([a-z0-9-]+)[[:space:]]*--\>$ ]]; then
      if [ "${BASH_REMATCH[1]}" = "delivery-contract" ]; then in_section=1; section_line=$lineno; else in_section=0; fi
      continue
    fi

    [ "$in_section" -ne 1 ] && continue
    case "$t" in
      '|'*'|') ;;
      *) continue ;;
    esac

    local cellstr cells ncells c0 c1 is_sep=1 c cc
    cellstr="$(dc_table_cells "$t")" || continue
    IFS=$'\x1f' read -r -a cells <<< "$cellstr"
    ncells=${#cells[@]}

    for c in "${cells[@]}"; do
      cc="$(dc_trim "$c")"
      if [[ ! "$cc" =~ ^:?-+:?$ ]]; then is_sep=0; break; fi
    done
    [ "$is_sep" -eq 1 ] && continue

    c0="$(dc_trim "${cells[0]:-}")"
    c1="$(dc_trim "${cells[1]:-}")"
    if [ "$ncells" -eq 2 ] && { [ "$c0" = "Field" ] || [ "$c0" = "field" ]; }; then continue; fi

    if [ "$ncells" -ne 2 ]; then
      dc_die "$path" "$lineno" "row has $ncells column(s), expected 2 (\`field\` | value)"
    fi
    if [[ ! "$c0" =~ ^\`([a-z0-9-]+)\`$ ]]; then
      dc_die "$path" "$lineno" "row's first cell '$c0' must be a \`field-name\` in backticks"
    fi
    local key="${BASH_REMATCH[1]}"
    case "$key" in
      forge-word) [ "$ln_forge" -eq 0 ] || dc_die "$path" "$lineno" "field \`forge-word\` is set twice (also at line $ln_forge)"; ln_forge="$lineno"; val_forge="$c1" ;;
      pr-opened-by) [ "$ln_pr" -eq 0 ] || dc_die "$path" "$lineno" "field \`pr-opened-by\` is set twice (also at line $ln_pr)"; ln_pr="$lineno"; val_pr="$c1" ;;
      ticket-topology) [ "$ln_topo" -eq 0 ] || dc_die "$path" "$lineno" "field \`ticket-topology\` is set twice (also at line $ln_topo)"; ln_topo="$lineno"; val_topo="$c1" ;;
      child-created-by) [ "$ln_child" -eq 0 ] || dc_die "$path" "$lineno" "field \`child-created-by\` is set twice (also at line $ln_child)"; ln_child="$lineno"; val_child="$c1" ;;
      proposal-approval) [ "$ln_proposal" -eq 0 ] || dc_die "$path" "$lineno" "field \`proposal-approval\` is set twice (also at line $ln_proposal)"; ln_proposal="$lineno"; val_proposal="$c1" ;;
      test-plan-posted-to) [ "$ln_testplan" -eq 0 ] || dc_die "$path" "$lineno" "field \`test-plan-posted-to\` is set twice (also at line $ln_testplan)"; ln_testplan="$lineno"; val_testplan="$c1" ;;
      merge-order) [ "$ln_mergeorder" -eq 0 ] || dc_die "$path" "$lineno" "field \`merge-order\` is set twice (also at line $ln_mergeorder)"; ln_mergeorder="$lineno"; val_mergeorder="$c1" ;;
      review-may-merge) [ "$ln_review" -eq 0 ] || dc_die "$path" "$lineno" "field \`review-may-merge\` is set twice (also at line $ln_review)"; ln_review="$lineno"; val_review="$c1" ;;
      integration-branch) [ "$ln_integ" -eq 0 ] || dc_die "$path" "$lineno" "field \`integration-branch\` is set twice (also at line $ln_integ)"; ln_integ="$lineno"; val_integ="$c1" ;;
      release-branch) [ "$ln_release" -eq 0 ] || dc_die "$path" "$lineno" "field \`release-branch\` is set twice (also at line $ln_release)"; ln_release="$lineno"; val_release="$c1" ;;
      archive-when) [ "$ln_archwhen" -eq 0 ] || dc_die "$path" "$lineno" "field \`archive-when\` is set twice (also at line $ln_archwhen)"; ln_archwhen="$lineno"; val_archwhen="$c1" ;;
      merge-style) [ "$ln_mergestyle" -eq 0 ] || dc_die "$path" "$lineno" "field \`merge-style\` is set twice (also at line $ln_mergestyle)"; ln_mergestyle="$lineno"; val_mergestyle="$c1" ;;
      handoff-to) [ "$ln_handoff" -eq 0 ] || dc_die "$path" "$lineno" "field \`handoff-to\` is set twice (also at line $ln_handoff)"; ln_handoff="$lineno"; val_handoff="$c1" ;;
      *) dc_die "$path" "$lineno" "unknown field \`$key\` — expected one of: $DC_FIELDS" ;;
    esac
  done < "$path"

  if [ "$section_line" -eq 0 ]; then
    if [ "$explicit" -eq 1 ]; then
      dc_die "$path" 1 \
        "no <!-- serpens:section delivery-contract --> anchor found in this explicitly-configured conventions file — an explicit --conventions/SERPENS_SDD_CONVENTIONS_DELIVERY file must carry a valid contract; it is never treated as \"unconfigured\""
    fi
    dc_use_defaults
    return 0
  fi

  DC_PATH="$path"
  DC_CONFIGURED=1

  if [ -n "$val_forge" ]; then
    case "$val_forge" in PR|MR) ;; *) dc_die "$path" "$ln_forge" "\`forge-word\` must be PR or MR, got: $val_forge" ;; esac
    DC_FORGE_WORD="$val_forge"
  else DC_FORGE_WORD="$DC_DEFAULT_FORGE_WORD"; fi

  if [ -n "$val_pr" ]; then
    case "$val_pr" in human|agent) ;; *) dc_die "$path" "$ln_pr" "\`pr-opened-by\` must be human or agent, got: $val_pr" ;; esac
    DC_PR_OPENED_BY="$val_pr"
  else DC_PR_OPENED_BY="$DC_DEFAULT_PR_OPENED_BY"; fi

  if [ -n "$val_topo" ]; then
    case "$val_topo" in parent-story+child-per-repo) ;; *) dc_die "$path" "$ln_topo" "\`ticket-topology\` must be parent-story+child-per-repo (single-ticket is deferred, not shipped — §4a), got: $val_topo" ;; esac
    DC_TICKET_TOPOLOGY="$val_topo"
  else DC_TICKET_TOPOLOGY="$DC_DEFAULT_TICKET_TOPOLOGY"; fi

  if [ -n "$val_child" ]; then
    case "$val_child" in ask|analyst|agent) ;; *) dc_die "$path" "$ln_child" "\`child-created-by\` must be ask, analyst or agent, got: $val_child" ;; esac
    DC_CHILD_CREATED_BY="$val_child"
  else DC_CHILD_CREATED_BY="$DC_DEFAULT_CHILD_CREATED_BY"; fi

  if [ -n "$val_proposal" ]; then
    case "$val_proposal" in analyst-in-story|none) ;; *) dc_die "$path" "$ln_proposal" "\`proposal-approval\` must be analyst-in-story or none, got: $val_proposal" ;; esac
    DC_PROPOSAL_APPROVAL="$val_proposal"
  else DC_PROPOSAL_APPROVAL="$DC_DEFAULT_PROPOSAL_APPROVAL"; fi

  if [ -n "$val_testplan" ]; then
    case "$val_testplan" in same-ticket-comment|print-only) ;; *) dc_die "$path" "$ln_testplan" "\`test-plan-posted-to\` must be same-ticket-comment or print-only, got: $val_testplan" ;; esac
    DC_TEST_PLAN_POSTED_TO="$val_testplan"
  else DC_TEST_PLAN_POSTED_TO="$DC_DEFAULT_TEST_PLAN_POSTED_TO"; fi

  if [ -n "$val_mergeorder" ]; then
    dc_valid_merge_order "$val_mergeorder" \
      || dc_die "$path" "$ln_mergeorder" "\`merge-order\` must be a permutation of producer,consumers,store-contract, got: $val_mergeorder"
    DC_MERGE_ORDER="$val_mergeorder"
  else DC_MERGE_ORDER="$DC_DEFAULT_MERGE_ORDER"; fi

  if [ -n "$val_review" ]; then
    case "$val_review" in no) ;; *) dc_die "$path" "$ln_review" "\`review-may-merge\` accepts only 'no' (listed so it is visible), got: $val_review" ;; esac
    DC_REVIEW_MAY_MERGE="$val_review"
  else DC_REVIEW_MAY_MERGE="$DC_DEFAULT_REVIEW_MAY_MERGE"; fi

  if [ -n "$val_integ" ]; then
    git check-ref-format --branch "$val_integ" >/dev/null 2>&1 \
      || dc_die "$path" "$ln_integ" "\`integration-branch\` is not a valid branch name: $val_integ"
    DC_INTEGRATION_BRANCH="$val_integ"
  else DC_INTEGRATION_BRANCH=""; fi

  if [ -n "$val_release" ]; then
    git check-ref-format --branch "$val_release" >/dev/null 2>&1 \
      || dc_die "$path" "$ln_release" "\`release-branch\` is not a valid branch name: $val_release"
    DC_RELEASE_BRANCH="$val_release"
  else DC_RELEASE_BRANCH="$DC_DEFAULT_RELEASE_BRANCH"; fi

  if [ -n "$val_archwhen" ]; then
    case "$val_archwhen" in after-merge|after-qa-accepted) ;; *) dc_die "$path" "$ln_archwhen" "\`archive-when\` must be after-merge or after-qa-accepted, got: $val_archwhen" ;; esac
    DC_ARCHIVE_WHEN="$val_archwhen"
  else DC_ARCHIVE_WHEN="$DC_DEFAULT_ARCHIVE_WHEN"; fi

  if [ -n "$val_mergestyle" ]; then
    case "$val_mergestyle" in merge|squash|rebase) ;; *) dc_die "$path" "$ln_mergestyle" "\`merge-style\` must be merge, squash or rebase, got: $val_mergestyle" ;; esac
    DC_MERGE_STYLE="$val_mergestyle"
  else DC_MERGE_STYLE=""; fi

  if [ -n "$val_handoff" ]; then
    case "$val_handoff" in chat|chat+ticket) ;; *) dc_die "$path" "$ln_handoff" "\`handoff-to\` must be chat or chat+ticket, got: $val_handoff" ;; esac
    DC_HANDOFF_TO="$val_handoff"
  else DC_HANDOFF_TO="$DC_DEFAULT_HANDOFF_TO"; fi
}

# The one entry point. `explicit` is a caller-supplied --conventions path (or empty); `root` is
# the repository root to resolve the default path against (or empty -> ask git / use cwd).
dc_load() {
  local explicit_arg="${1:-}" root="${2:-}"
  local path is_explicit=0
  path="$(dc_resolve_conventions_path "$explicit_arg" "$root")"
  DC_PATH="$path"
  if [ -n "$explicit_arg" ] || [ -n "${SERPENS_SDD_CONVENTIONS_DELIVERY:-}" ]; then
    is_explicit=1
  fi
  if [ ! -f "$path" ]; then
    dc_use_defaults
    return 0
  fi
  dc_load_file "$path" "$is_explicit"
}

# The resolved integration branch: the field if set, else the SAME detection order
# repository-state.sh's expected_base() already hardcodes (origin/develop if present, else
# origin/HEAD) — §2b: "the resolver keeps that exact order as its built-in default". `root`
# is the repo to probe remotes in.
dc_resolved_integration_branch() {
  local root="${1:-.}"
  if [ -n "$DC_INTEGRATION_BRANCH" ]; then
    printf '%s\n' "$DC_INTEGRATION_BRANCH"
    return 0
  fi
  if git -C "$root" show-ref --verify --quiet refs/remotes/origin/develop; then
    printf 'develop\n'
    return 0
  fi
  local branch
  branch=$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  branch=${branch#origin/}
  if [ -n "$branch" ]; then
    printf '%s\n' "$branch"
    return 0
  fi
  return 1
}

# ---- estate state file: <repo-root>/.serpens.yaml -----------------------------------------------
# spec-org-facts-slice-delivery-2026-09-23.md §2b items 2/3: records facts that must survive
# across separate `delivery`/`repository-state` invocations and are NOT per-change (that is what
# the change-directory `.serpens.yaml` marker, written by `repository-state.sh mark-change`,
# already covers — a different file, same name, different scope, never confused because the
# change-directory one lives under openspec/changes/<id>/ and this one lives at the repo root):
#   - handoff-tip: <branch> <sha>       — every tip `delivery --handoff` has ever recorded for a
#     branch, oldest first; the LATEST one wins for the merged check, earlier ones are kept for
#     the squash fallback (a fix-loop push to the SAME branch name after an earlier squash-merge).
#   - squash-confirmed: <branch> <sha>  — a human's one-time confirmation that a squash re-edit
#     ambiguity for this exact (branch, tip) really is archivable; never re-asked for that tip.
#   - archive-when-confirmed: <value>   — the human's one-time confirmation of which archive-when
#     value this estate uses, so the agent asks at most once per estate.
# Line-based, not real YAML, on purpose: the same "grep it, append to it, never rewrite history"
# shape as every other serpens-sdd state file. Appends only; nothing here is ever edited in place
# except a fresh archive-when-confirmed line, deliberately singular (one estate, one answer).
dc_estate_path() {
  local root="${1:-.}"
  printf '%s/.serpens.yaml\n' "$root"
}

dc_estate_ensure() {
  local path="$1"
  [ -f "$path" ] || printf '# serpens-sdd:estate-state\n' > "$path"
}

# Records a new handoff tip for $branch unless it already IS the latest recorded tip (so a
# second --handoff on an unchanged HEAD does not grow the file forever).
dc_record_handoff_tip() {
  local root="$1" branch="$2" sha="$3" path
  path="$(dc_estate_path "$root")"
  dc_estate_ensure "$path"
  local latest
  latest="$(dc_latest_handoff_tip "$root" "$branch")"
  [ "$latest" = "$sha" ] && return 0
  printf 'handoff-tip: %s %s\n' "$branch" "$sha" >> "$path"
}

# All recorded tips for $branch, oldest first, one per line.
dc_handoff_tips() {
  local root="$1" branch="$2" path
  path="$(dc_estate_path "$root")"
  [ -f "$path" ] || return 0
  grep -F "handoff-tip: $branch " "$path" 2>/dev/null | awk '{print $3}'
}

dc_latest_handoff_tip() {
  dc_handoff_tips "$1" "$2" | tail -1
}

dc_record_squash_confirm() {
  local root="$1" branch="$2" sha="$3" path
  path="$(dc_estate_path "$root")"
  dc_estate_ensure "$path"
  dc_squash_confirmed "$root" "$branch" "$sha" && return 0
  printf 'squash-confirmed: %s %s\n' "$branch" "$sha" >> "$path"
}

dc_squash_confirmed() {
  local root="$1" branch="$2" sha="$3" path
  path="$(dc_estate_path "$root")"
  [ -f "$path" ] || return 1
  grep -qF "squash-confirmed: $branch $sha" "$path" 2>/dev/null
}

dc_record_archive_when_confirm() {
  local root="$1" value="$2" path tmp
  path="$(dc_estate_path "$root")"
  dc_estate_ensure "$path"
  tmp="$(mktemp)"
  grep -v '^archive-when-confirmed: ' "$path" > "$tmp" 2>/dev/null || true
  printf 'archive-when-confirmed: %s\n' "$value" >> "$tmp"
  mv "$tmp" "$path"
}

dc_archive_when_confirmed() {
  local root="$1" path
  path="$(dc_estate_path "$root")"
  [ -f "$path" ] || return 1
  grep '^archive-when-confirmed: ' "$path" 2>/dev/null | tail -1 | sed 's/^archive-when-confirmed: //'
}
