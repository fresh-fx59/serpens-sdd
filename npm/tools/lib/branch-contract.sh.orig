# branch-contract.sh — the ONE branching-convention contract, sourced by both
# check-git-naming.sh and the assert-change mode so a single conventions file changes both
# guards together (spec-org-facts-slice-branching-2026-09-11.md §7: a second executable guard
# hardcoded the same convention and §2's inventory missed it).
#
# A contract is: how a branch name is BUILT from a ticket, and how a ticket is EXTRACTED from a
# branch. Both directions are exactly one function each — bc_render_branch / a capture regex —
# so neither guard can drift from the other by re-deriving its own version of either direction.
#
# RESOLUTION ORDER for the conventions file (never inferred from the shim — src/shim.mjs:62
# carries no store path, see the spec's §7 correction of that idea):
#   1. an explicit --conventions <path>, passed by the caller;
#   2. the SERPENS_SDD_CONVENTIONS_BRANCHING environment variable — the route the installed
#      hook wiring is expected to set, the same shape as the SERPENS_SDD_* variables
#      src/resolve.mjs already resolves for the rest of the config;
#   3. the default location, <repo-root>/conventions/branching.md.
# A file that does not exist at the resolved location is not an error: the built-in defaults
# apply, byte-identical to the pre-contract behaviour. The SAME is true of a file that exists
# but carries no `<!-- serpens:section branching-contract -->` anchor at all — this is exactly
# the shape of the shipped, unfilled `templates/conventions-branching.md`
# (src/stages/stage3-store.mjs copies it to this same path on EVERY install, unconditionally),
# which is pure prose for a human, not a shop's attempt at machine configuration. Only once a
# file carries the anchor does this become a real, parsed contract — and from that point on,
# anything wrong inside it is always an error naming the file and the line, never a silent
# fallback to defaults (the input-gate principle; see src/testingstack.mjs's own header for the
# false-pass history that principle is fixing here too).
#
# THE MACHINE-READABLE BLOCK is deliberately NOT a fenced code block. src/testingstack.mjs:36
# already learned this the hard way: "Fenced code blocks are invisible to every scan here" —
# deliberately, so a document can SHOW an example table to a human without that example being
# read as content. The same anchor-plus-strict-table mechanism is used here:
#
#   <!-- serpens:section branching-contract -->
#   | Field | Value |
#   |---|---|
#   | `ticket-pattern`   | [A-Z][A-Z0-9]+-[0-9]+ |
#   | `branch-pattern`   | feature/<TICKET> |
#   | `commit-types`     | feat,fix,chore,docs,refactor,test,perf,build,ci,revert |
#   | `exempt-branches`  | ^(main|master|develop)$ |
#
# Everything from the anchor comment to the next anchor (or EOF), OUTSIDE any fenced block, is
# the section; a fenced example anywhere else in the same file is invisible to this parser, on
# purpose. `ticket-pattern` and `branch-pattern` are required; `commit-types` and
# `exempt-branches` are optional and fall back to the built-in defaults below when the file is
# present but omits them.
#
# A `|` that is part of a Value (an alternation inside a regex) is written `\|`, escaped exactly
# like src/testingstack.mjs's own `tableCells()` — see bc_table_cells below, the bash port of
# that same rule.
set -uo pipefail

# ---- built-in defaults: today's hardcoded behaviour, unchanged --------------------------------
BC_DEFAULT_TICKET_RE='[A-Z][A-Z0-9]+-[0-9]+'
BC_DEFAULT_BRANCH_PATTERN='feature/<TICKET>'
BC_DEFAULT_TYPE_RE='feat|fix|chore|docs|refactor|test|perf|build|ci|revert'
# Long-lived branches: genuinely exempt, with or without a conventions file.
BC_DEFAULT_LONGLIVED_RE='^(main|master|develop)$'
# The trap spec-org-facts-slice-branching-2026-09-11.md §2 names: release/hotfix/support were
# EXEMPT in the pre-contract regex, which silently UNCHECKED any shop that works on
# release/<TICKET>. With no conventions file this class is now reported honestly instead of
# being folded into "exempt" — see bc_check_branch_default below.
BC_DEFAULT_TRAP_RE='^(release|hotfix|support)/.+$'
# The default exempt set used ONLY when a conventions file is present but omits
# `exempt-branches`. Deliberately excludes the release/hotfix/support trap: a shop that just
# told us its branch pattern is (for example) release/<TICKET> gets that pattern CHECKED, not
# silently re-exempted by a leftover default.
BC_CONFIGURED_DEFAULT_EXEMPT_RE='^(main|master|develop)$'

# ---- resolved contract (populated by bc_load) ------------------------------------------------
BC_PATH=""
BC_CONFIGURED=0
BC_TICKET_RE=""
BC_BRANCH_PATTERN=""
BC_TYPE_RE=""
BC_EXEMPT_RE=""
BC_BRANCH_REGEX=""
BC_BRANCH_REGEX_CAP=""

# Trim leading and trailing whitespace. Pure bash, no subprocess.
bc_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Escape ERE metacharacters in a literal string, one character at a time. Used on the literal
# (non-<TICKET>) parts of branch-pattern, so a prefix/suffix a shop writes is matched literally
# even if it happens to contain a regex-special character.
bc_escape_ere() {
  local s="$1" out="" c i n
  n=${#s}
  for ((i = 0; i < n; i++)); do
    c="${s:i:1}"
    case "$c" in
      '.'|'*'|'+'|'?'|'('|')'|'['|']'|'{'|'}'|'^'|'$'|'|'|'\') out="${out}\\${c}" ;;
      *) out="${out}${c}" ;;
    esac
  done
  printf '%s' "$out"
}

# Split one already-trimmed `|...|` table row into cells on an ASCII unit-separator (0x1F),
# unescaping `\|` to a literal `|` inside a cell. Same escaping rule as
# src/testingstack.mjs:tableCells — an escaped `\|` is part of a cell, never a separator.
# Returns non-zero (nothing printed) when the line is not a table row at all.
bc_table_cells() {
  local line="$1"
  case "$line" in
    '|'*'|') ;;
    *) return 1 ;;
  esac
  local inner="${line:1:${#line}-2}"
  local out="" cur="" i=0 n=${#inner} ch
  while [ "$i" -lt "$n" ]; do
    ch="${inner:$i:1}"
    if [ "$ch" = '\' ] && [ "$((i + 1))" -lt "$n" ] && [ "${inner:$((i + 1)):1}" = '|' ]; then
      cur="${cur}|"
      i=$((i + 2))
      continue
    fi
    if [ "$ch" = '|' ]; then
      out="${out}${cur}"$'\x1f'
      cur=""
      i=$((i + 1))
      continue
    fi
    cur="${cur}${ch}"
    i=$((i + 1))
  done
  out="${out}${cur}"
  printf '%s' "$out"
}

# Fatal parse error: names the file and the exact line, always — never a silent fallback to the
# built-in defaults. Mirrors the ✗-prefixed shape both callers already use.
bc_die() {
  local path="$1" line="$2" msg="$3"
  printf '✗ %s:%s: %s\n' "$path" "$line" "$msg" >&2
  exit 1
}

# Where the conventions file lives: explicit arg, then the env var the installed hook wiring is
# expected to set, then the default path under the repository root. `root`, when given, is the
# repo root the caller already resolved (repository-state.sh's $REPO); when omitted this falls
# back to `git rev-parse --show-toplevel`, then plain cwd.
bc_resolve_conventions_path() {
  local explicit="${1:-}" root="${2:-}"
  if [ -n "$explicit" ]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [ -n "${SERPENS_SDD_CONVENTIONS_BRANCHING:-}" ]; then
    printf '%s\n' "$SERPENS_SDD_CONVENTIONS_BRANCHING"
    return 0
  fi
  if [ -z "$root" ]; then
    root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  fi
  printf '%s/conventions/branching.md\n' "$root"
}

# Compile BC_BRANCH_PATTERN + BC_TICKET_RE into the two regexes both guards read: the plain
# match, and the capturing form used to pull the ticket back OUT of a branch name.
bc_compile() {
  local prefix="${BC_BRANCH_PATTERN%%<TICKET>*}"
  local suffix="${BC_BRANCH_PATTERN#*<TICKET>}"
  local prefix_esc suffix_esc
  prefix_esc="$(bc_escape_ere "$prefix")"
  suffix_esc="$(bc_escape_ere "$suffix")"
  # BC_TICKET_RE is user-supplied and MUST be grouped wherever it is embedded inside a larger
  # regex: an ungrouped alternation (e.g. `AA-[0-9]+|BB-[0-9]+`) would otherwise split the WHOLE
  # surrounding regex at the `|`, silently detaching the anchors from everything but the last
  # alternative (spec-org-facts-slice-branching-2026-09-11.md §7, D1). Grouping is harmless even
  # when the ticket pattern has no alternation, and harmless when it has its own internal groups
  # (BASH_REMATCH[1] on BC_BRANCH_REGEX_CAP always addresses this outermost group).
  BC_BRANCH_REGEX="^${prefix_esc}(${BC_TICKET_RE})${suffix_esc}\$"
  BC_BRANCH_REGEX_CAP="^${prefix_esc}(${BC_TICKET_RE})${suffix_esc}\$"
}

# Build the branch name a ticket maps to under the current contract — the one function EITHER
# guard uses to go ticket -> branch, so `repository-state.sh`'s assert-change and
# `check-git-naming.sh`'s branch check can never disagree about the shape.
bc_render_branch() {
  local ticket="$1"
  printf '%s' "${BC_BRANCH_PATTERN/<TICKET>/$ticket}"
}

bc_use_defaults() {
  BC_CONFIGURED=0
  BC_TICKET_RE="$BC_DEFAULT_TICKET_RE"
  BC_BRANCH_PATTERN="$BC_DEFAULT_BRANCH_PATTERN"
  BC_TYPE_RE="$BC_DEFAULT_TYPE_RE"
  BC_EXEMPT_RE=""   # unused in default mode; bc_check_branch_default handles exemption itself
  bc_compile
}

# Validate one ERE by asking grep -E to compile it against empty input. grep -E exits 2 on a
# syntactically bad pattern (0 = matched, 1 = did not match — both mean "compiled fine").
bc_valid_ere() {
  grep -E -q -- "$1" </dev/null 2>/dev/null
  local rc=$?
  [ "$rc" -ne 2 ]
}

# Parse a conventions file already known to exist. Sets the BC_* contract on success; calls
# bc_die (which exits) naming the file and line on the first problem found. Never falls back to
# defaults on a malformed file — presence + malformed is always fatal.
#
# `explicit` (1/0) carries PROVENANCE, not content: it is 1 when this path came from an explicit
# --conventions flag or the SERPENS_SDD_CONVENTIONS_BRANCHING env var, 0 for the default
# <repo-root>/conventions/branching.md. That distinction is exactly what decides what "no
# anchor found" means (spec-org-facts-slice-branching-2026-09-11.md §7, D2):
#   - default path, no anchor at all -> this is stage3-store.mjs's unfilled prose template,
#     installed on EVERY install unconditionally; treated as "unconfigured", defaults apply.
#   - explicit path, no anchor at all (including a misspelled anchor name, which never matches
#     the anchor regex below and so is indistinguishable from "no anchor") -> the user pointed
#     us at this file on purpose. A file with no valid contract in it is a MISTAKE, never a
#     silent request for defaults, so this is now a fatal, named error.
# Once a file has a genuine `branching-contract` anchor, everything below is unconditional:
# provenance no longer matters, because a real contract was found and any row inside it that is
# wrong is fatal for either provenance.
bc_load_file() {
  local path="$1" explicit="${2:-0}"
  local in_section=0 in_fence=0 lineno=0 section_line=0
  local ticket_val="" branch_val="" types_val="" exempt_val=""
  # Bash 3.2 (macOS's shipped /bin/bash) has no associative arrays, so each field's "have I
  # already seen this row, and at which line" state is tracked in its own plain variable rather
  # than a map keyed by field name.
  local ticket_line=0 branch_line=0 types_line=0 exempt_line=0
  local raw t

  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    raw="${raw%$'\r'}"
    t="$(bc_trim "$raw")"

    if [[ "$t" =~ ^(\`\`\`+|~~~+) ]]; then
      if [ "$in_fence" -eq 0 ]; then in_fence=1; else in_fence=0; fi
      continue
    fi
    [ "$in_fence" -eq 1 ] && continue

    if [[ "$t" =~ ^\<!--[[:space:]]*serpens:section[[:space:]]+([a-z0-9-]+)[[:space:]]*--\>$ ]]; then
      if [ "${BASH_REMATCH[1]}" = "branching-contract" ]; then in_section=1; section_line=$lineno; else in_section=0; fi
      continue
    fi

    [ "$in_section" -ne 1 ] && continue
    case "$t" in
      '|'*'|') ;;
      *) continue ;;
    esac

    local cellstr cells ncells c0 c1 is_sep=1 c cc
    cellstr="$(bc_table_cells "$t")" || continue
    IFS=$'\x1f' read -r -a cells <<< "$cellstr"
    ncells=${#cells[@]}

    for c in "${cells[@]}"; do
      cc="$(bc_trim "$c")"
      if [[ ! "$cc" =~ ^:?-+:?$ ]]; then is_sep=0; break; fi
    done
    [ "$is_sep" -eq 1 ] && continue

    c0="$(bc_trim "${cells[0]:-}")"
    c1="$(bc_trim "${cells[1]:-}")"
    if [ "$ncells" -eq 2 ] && { [ "$c0" = "Field" ] || [ "$c0" = "field" ]; }; then continue; fi

    if [ "$ncells" -ne 2 ]; then
      bc_die "$path" "$lineno" "row has $ncells column(s), expected 2 (\`field\` | value)"
    fi
    if [[ ! "$c0" =~ ^\`([a-z0-9-]+)\`$ ]]; then
      bc_die "$path" "$lineno" "row's first cell '$c0' must be a \`field-name\` in backticks"
    fi
    local key="${BASH_REMATCH[1]}"
    case "$key" in
      ticket-pattern)
        [ "$ticket_line" -eq 0 ] || bc_die "$path" "$lineno" "field \`ticket-pattern\` is set twice (also at line $ticket_line)"
        ticket_line="$lineno"; ticket_val="$c1" ;;
      branch-pattern)
        [ "$branch_line" -eq 0 ] || bc_die "$path" "$lineno" "field \`branch-pattern\` is set twice (also at line $branch_line)"
        branch_line="$lineno"; branch_val="$c1" ;;
      commit-types)
        [ "$types_line" -eq 0 ] || bc_die "$path" "$lineno" "field \`commit-types\` is set twice (also at line $types_line)"
        types_line="$lineno"; types_val="$c1" ;;
      exempt-branches)
        [ "$exempt_line" -eq 0 ] || bc_die "$path" "$lineno" "field \`exempt-branches\` is set twice (also at line $exempt_line)"
        exempt_line="$lineno"; exempt_val="$c1" ;;
      *) bc_die "$path" "$lineno" "unknown field \`$key\` — expected one of ticket-pattern, branch-pattern, commit-types, exempt-branches" ;;
    esac
  done < "$path"

  if [ "$section_line" -eq 0 ]; then
    if [ "$explicit" -eq 1 ]; then
      # This path was named explicitly (--conventions or SERPENS_SDD_CONVENTIONS_BRANCHING) —
      # there is no "unfilled default template" excuse here. A file with no
      # `<!-- serpens:section branching-contract -->` anchor at all (a misspelled anchor name,
      # e.g. `branching_contract`, never matches the anchor regex above and lands here too) is a
      # configuration mistake, never a silent request for defaults (§7, D2).
      bc_die "$path" 1 \
        "no <!-- serpens:section branching-contract --> anchor found in this explicitly-configured conventions file — an explicit --conventions/SERPENS_SDD_CONVENTIONS_BRANCHING file must carry a valid contract; it is never treated as \"unconfigured\""
    fi
    # No `<!-- serpens:section branching-contract -->` anchor anywhere, and this is the DEFAULT
    # path: this is the unfilled prose template (stage3-store.mjs copies
    # templates/conventions-branching.md to exactly this path on every install, unconditionally
    # — verified against src/stages/stage3-store.mjs) and NOT a shop's attempt at machine-readable
    # configuration. Treated as "no conventions file" rather than "malformed", so every existing
    # install stays byte-identical to today until the kit prose pass (out of scope here) adds the
    # block to the template. Once a shop (or that later pass) adds the anchor, every row inside
    # it is validated strictly — see below — and a broken attempt from that point on IS a fatal,
    # named error, regardless of provenance.
    bc_use_defaults
    return 0
  fi
  [ "$ticket_line" -ne 0 ] \
    || bc_die "$path" "$section_line" "required field \`ticket-pattern\` is missing from the branching-contract block"
  [ "$branch_line" -ne 0 ] \
    || bc_die "$path" "$section_line" "required field \`branch-pattern\` is missing from the branching-contract block"

  [ -n "$ticket_val" ] || bc_die "$path" "$ticket_line" "\`ticket-pattern\` has no value"
  bc_valid_ere "$ticket_val" \
    || bc_die "$path" "$ticket_line" "\`ticket-pattern\` is not a valid regular expression: $ticket_val"

  [ -n "$branch_val" ] || bc_die "$path" "$branch_line" "\`branch-pattern\` has no value"
  local ticket_count
  ticket_count=$(grep -o -F '<TICKET>' <<< "$branch_val" | wc -l | tr -d ' ')
  [ "$ticket_count" = "1" ] \
    || bc_die "$path" "$branch_line" "\`branch-pattern\` must contain exactly one <TICKET> placeholder, found $ticket_count: $branch_val"

  if [ -n "$types_val" ]; then
    local IFS_OLD="$IFS" tok built=""
    IFS=','
    for tok in $types_val; do
      tok="$(bc_trim "$tok")"
      IFS="$IFS_OLD"
      [[ "$tok" =~ ^[a-z]+$ ]] \
        || bc_die "$path" "$types_line" "\`commit-types\` entry '$tok' must be lower-case letters only"
      if [ -z "$built" ]; then built="$tok"; else built="${built}|${tok}"; fi
      IFS=','
    done
    IFS="$IFS_OLD"
    [ -n "$built" ] || bc_die "$path" "$types_line" "\`commit-types\` has no entries"
    BC_TYPE_RE="$built"
  else
    BC_TYPE_RE="$BC_DEFAULT_TYPE_RE"
  fi

  if [ -n "$exempt_val" ]; then
    if [ "$exempt_val" = "none" ]; then
      BC_EXEMPT_RE=""
    else
      bc_valid_ere "$exempt_val" \
        || bc_die "$path" "$exempt_line" "\`exempt-branches\` is not a valid regular expression: $exempt_val"
      BC_EXEMPT_RE="$exempt_val"
    fi
  else
    BC_EXEMPT_RE="$BC_CONFIGURED_DEFAULT_EXEMPT_RE"
  fi

  BC_TICKET_RE="$ticket_val"
  BC_BRANCH_PATTERN="$branch_val"
  BC_CONFIGURED=1
  BC_PATH="$path"
  bc_compile
}

# The one entry point both guards call. `explicit` is a caller-supplied --conventions path (or
# empty); `root` is the repository root to resolve the default path against (or empty, meaning
# "ask git / use cwd"). Absence of a file at the resolved path is not an error: built-in
# defaults apply. Presence of a malformed file always is, via bc_die inside bc_load_file.
bc_load() {
  local explicit_arg="${1:-}" root="${2:-}"
  local path is_explicit=0
  path="$(bc_resolve_conventions_path "$explicit_arg" "$root")"
  BC_PATH="$path"
  # Provenance: an explicit --conventions arg or the env var both name the file on purpose; only
  # the derived default path (repo-root/conventions/branching.md, with neither of those set)
  # gets the "file present but no anchor -> unconfigured" pass (§7, D2).
  if [ -n "$explicit_arg" ] || [ -n "${SERPENS_SDD_CONVENTIONS_BRANCHING:-}" ]; then
    is_explicit=1
  fi
  if [ ! -f "$path" ]; then
    bc_use_defaults
    return 0
  fi
  bc_load_file "$path" "$is_explicit"
}
