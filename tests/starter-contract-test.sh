#!/usr/bin/env bash
set -u

KIT="${1:?usage: starter-contract-test.sh <starter-kit-root>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$KIT" || exit 1
KIT="$PWD"
source "$SCRIPT_DIR/package-root.sh"
PKG_ROOT="$(serpens_package_root)" || exit 1
PASS=0
FAIL=0

pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if "$@"; then pass "$*"; else fail "$*"; fi; }

# spec-npm-oidc-publishing-2026-09-11.md §10: the public repository carries EIGHT
# documents the vault deliberately does not duplicate — four per language under
# docs/ (FLOW.md, FLOW-TABLE.md, FLOW-SCHEMA.md, MIGRATION-<rev>-to-current.md), plus
# three at the repo root (RENAME.md, index.html, common-contract.html, outside $KIT).
# They are historical/reference material about the OLD (pre-submodule, pre-OpenSpec,
# scripts/-based) system, published once and never synced from the vault, so their
# prose legitimately narrates scripts/, clones/, opsx and other retired vocabulary.
# The contract checks below apply to the SHIPPED KIT CONTRACT, not to that archival
# material — exclude it by name rather than weakening the check for the real kit.
#
# The list itself is declared ONCE, in tests/preserved-public-docs.sh — shared with the
# release-side pruning step (serpens-sdd-npm/src/preserved-public-docs.mjs parses the same
# file) so the two can never drift apart.
source "$SCRIPT_DIR/preserved-public-docs.sh"
is_preserved_doc() {
  local name="$1" candidate
  for candidate in $PRESERVED_PUBLIC_DOC_NAMES; do
    [ "$name" = "$candidate" ] && return 0
  done
  for candidate in $PRESERVED_PUBLIC_DOC_GLOBS; do
    case "$name" in
      $candidate) return 0 ;;
    esac
  done
  return 1
}
# F1/F2 fix: built FROM the single sourced list (never restated), and anchored to the KIT
# ROOT's docs/ directory only — never any depth. ripgrep's --glob anchoring is relative to the
# invocation's CWD (not the search-root argument passed on the command line), which is exactly
# why we `cd "$KIT"` above and why every rg call below searches "." / relative subpaths instead
# of passing "$KIT" as an absolute path: a leading '/' in a --glob pattern only anchors against
# CWD, so anchoring against an absolute search-path argument silently does nothing (confirmed:
# `rg --glob '!/docs/x' /abs/path` still matches /abs/path/docs/x). §10 preserves only the
# kit-root docs/<name> — never a nested docs/ at any depth (e.g. skills/*/docs/) — so the glob
# must reconcile with classifyTargetOnly's and T1's identical kit-root-only rule.
RG_EXCLUDE_PRESERVED=()
for _name in $PRESERVED_PUBLIC_DOC_NAMES; do
  RG_EXCLUDE_PRESERVED+=(--glob "!/docs/${_name}")
done
for _glob in $PRESERVED_PUBLIC_DOC_GLOBS; do
  RG_EXCLUDE_PRESERVED+=(--glob "!/docs/${_glob}")
done
unset _name _glob

printf 'T1 compact current documentation\n'
docs="$(find "$KIT/docs" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort | tr '\n' ' ')"
extra_docs=""
for d in $docs; do
  case "$d" in
    OPERATIONS.md|SETUP.md|UPGRADE.md) ;;
    *) is_preserved_doc "$d" || extra_docs="$extra_docs$d "  ;;
  esac
done
if [ -z "$extra_docs" ]; then
  pass "only SETUP.md, UPGRADE.md, OPERATIONS.md and the §10-preserved public-only docs ship"
else
  fail "unexpected docs: $extra_docs"
fi

printf 'T2 submodule layout and inventory contract\n'
# spec-drop-inventory-file-2026-09-11.md §6/item 8: project-repositories.json.example is
# deleted from both kits — stage 1 never writes the file it used to template, and .gitmodules
# (or config.repositories before any submodule exists) is the list now.
check test ! -e "$KIT/config/project-repositories.json.example"
check test -f "$KIT/system-store-template/submodules/.gitkeep"
if [ ! -e "$KIT/scripts" ]; then pass "the kit ships no scripts/ directory"; else fail "scripts/ still in the kit"; fi
if ! rg -n 'sync-repos|repos\.json|(^|[/` ])clones([/` ]|$)' . --glob '!**/slides/**' "${RG_EXCLUDE_PRESERVED[@]}" >/dev/null; then
  pass "clone-era contract is absent"
else
  fail "clone-era contract remains"
fi
if ! rg -n 'scripts/' . "${RG_EXCLUDE_PRESERVED[@]}" >/dev/null; then
  pass "the kit contains no reference to a scripts/ directory anywhere"
else
  fail "the kit still references a scripts/ directory somewhere in its prose"
fi

printf 'T3 setup has independent discovery and installation paths\n'
if rg -q 'MCP' "$KIT/docs/SETUP.md" && rg -qi 'manual' "$KIT/docs/SETUP.md"; then pass "MCP and manual inventory paths documented"; else fail "inventory fallback missing"; fi
if rg -qi 'without.*Superpowers|Superpowers.*not required|does not require.*Superpowers|Superpowers не требуется|без Superpowers' "$KIT/docs/SETUP.md"; then pass "Superpowers is optional"; else fail "Superpowers independence missing"; fi
mcp_line="$(rg -n '^## 1\.' "$KIT/docs/SETUP.md" | head -1 | cut -d: -f1)"
port_line="$(rg -n '^## 2\.' "$KIT/docs/SETUP.md" | head -1 | cut -d: -f1)"
if [ -n "$mcp_line" ] && [ -n "$port_line" ] && [ "$mcp_line" -lt "$port_line" ]; then pass "project repository discovery is the first setup stage"; else fail "repository discovery is not first"; fi

if rg -q 'git clone .*SERPENS_SYSTEM_STORE_ROOT' "$KIT/docs/SETUP.md" && rg -q 'system-store-template' "$KIT/docs/SETUP.md"; then pass "existing and new system-store paths documented"; else fail "system-store install paths incomplete"; fi
if rg -q '<serpens-sdd> state prepare-base --repo .*SERPENS_SYSTEM_STORE_ROOT' "$KIT/docs/SETUP.md"; then pass "existing system store is state-gated before writes"; else fail "system-store state gate missing"; fi

printf 'T4 every command gates repository state\n'
for command in "$KIT"/commands/spns-*.md; do
  if rg -q '<serpens-sdd> state' "$command"; then pass "$(basename "$command") has repository gate"; else fail "$(basename "$command") lacks repository gate"; fi
done

if rg -q '<serpens-sdd> index' "$KIT/commands/spns-archive.md"; then pass "spns-archive writes the index"; else fail "spns-archive dropped the index write (verify-docs only runs index --check)"; fi
if rg -q '<serpens-sdd> verify-docs' "$KIT/commands/spns-archive.md"; then pass "spns-archive verifies"; else fail "spns-archive lacks verify-docs"; fi
if rg -q '<serpens-sdd> state assert-archivable' "$KIT/commands/spns-archive.md"; then pass "spns-archive gates placement with assert-archivable"; else fail "spns-archive lost the assert-archivable gate"; fi

# Both tokens must still be present as tokens — never pre-resolved in the shipped kit.
if rg -q '<openspec>' "$KIT/commands/spns-spec.md"; then pass "the openspec token survives"; else fail "openspec token pre-resolved in the shipped kit"; fi

printf 'T5 OpenSpec lifecycle commands are explicit port placeholders\n'
if rg -q '<openspec> new change' "$KIT/commands/spns-spec.md" && rg -q '<openspec> instructions proposal' "$KIT/commands/spns-spec.md" && rg -q '<openspec> instructions specs' "$KIT/commands/spns-spec.md"; then pass "spns-spec creates the change and names each artifact"; else fail "spns-spec OpenSpec calls missing"; fi
# A spec run can start with no ticket, on an existing branch, or already on it: all three must be handled.
if rg -q 'NO-TICKET' "$KIT/commands/spns-spec.md"; then pass "spns-spec refuses to invent a ticket key"; else fail "spns-spec ticket gate missing"; fi
if rg -q 'ls-remote --heads origin feature/<TICKET>' "$KIT/commands/spns-spec.md"; then pass "spns-spec looks for an existing story branch"; else fail "spns-spec existing-branch probe missing"; fi
if rg -q 'assert-change <TICKET> --allow-dirty' "$KIT/commands/spns-spec.md"; then pass "spns-spec resumes on the story branch instead of re-preparing the base"; else fail "spns-spec resume path missing"; fi
if rg -q '<openspec> instructions design' "$KIT/commands/spns-plan.md" && rg -q '<openspec> instructions tasks' "$KIT/commands/spns-plan.md"; then pass "spns-plan asks for design and tasks only"; else fail "spns-plan OpenSpec calls missing"; fi
if rg -q '<openspec> instructions apply' "$KIT/commands/spns-implement.md"; then pass "spns-implement reads apply state"; else fail "spns-implement apply call missing"; fi
if rg -q '<openspec> validate' "$KIT/commands/spns-review.md" && rg -q '<openspec> status' "$KIT/commands/spns-review.md"; then pass "spns-review validates and reads status"; else fail "spns-review validate call missing"; fi
if rg -q '<openspec> archive' "$KIT/commands/spns-archive.md"; then pass "spns-archive explicitly archives OpenSpec"; else fail "spns-archive call missing"; fi
# One vocabulary everywhere: CLI calls take <change-id>, never the raw {{args}} token, and every
# machine-readable call asks for --json. Mixed semantics across files is what confuses the model.
if rg -q -- '--change \{\{args\}\}' "$KIT/commands" "$KIT/skills"; then fail "a CLI call still takes {{args}} instead of <change-id>"; else pass "every OpenSpec CLI call takes <change-id>"; fi
if rg -q -- '<openspec> archive \{\{args\}\}' "$KIT/commands"; then fail "archive still passes {{args}} (it carries placement flags)"; else pass "archive passes the change id only"; fi
if [ "$(rg -c -- '<openspec> (status|instructions) [^`]*--json' "$KIT/commands" | wc -l | tr -d ' ')" -ge 3 ]; then pass "status and instructions calls are --json in every command that uses them"; else fail "an OpenSpec state call is missing --json"; fi
# Acceptance semantics live in the spec; spns-test-plan renders them and may not silently re-derive.
if rg -q 'SENDS and what they OBSERVE|ОТПРАВЛЯЕТ и что НАБЛЮДАЕТ' "$KIT/commands/spns-spec.md"; then pass "spns-spec makes every scenario observable from outside"; else fail "spns-spec testability question missing"; fi
if rg -q 'DRIFT IS NOT YOURS TO FIX|РАСХОЖДЕНИЕ ЧИНИШЬ НЕ ТЫ' "$KIT/commands/spns-test-plan.md"; then pass "spns-test-plan routes drift back as a spec amendment"; else fail "spns-test-plan drift rule missing"; fi
# The INTENT here is unchanged — spns-spec must make the change's error/rejection facts part of
# the observable contract — but its wording moved. It used to be asserted by grepping for
# `dead-letter`, which named a destination model the customer chose; that word is now forbidden in
# every command by the shape gate (serpens-sdd-npm/test/no-customer-tech-nouns.test.mjs), and the
# fact is recorded through the repository's own `error-routing` slot instead. Two gates disagreed,
# and this is the one that was encoding the leak.
if rg -q 'error-routing|error contract|контракт ошибок' "$KIT/commands/spns-spec.md"; then pass "spns-spec records error/rejection facts through the repository's own slot"; else fail "spns-spec error/rejection facts missing"; fi
if rg -q 'ACCEPTANCE|ПРИЁМКА' "$KIT/commands/spns-review.md"; then pass "spns-review reviews the acceptance scenarios"; else fail "spns-review acceptance lens missing"; fi
TOOLS="$PKG_ROOT/tools"
if rg -q 'names no observable surface' "$TOOLS/serpens-lint.mjs"; then pass "serpens-lint warns on an unobservable requirement"; else fail "serpens-lint observability warning missing"; fi
# The slash commands these replaced do not exist in OpenSpec 1.10's core profile.
if rg -q 'opsx' commands skills docs "${RG_EXCLUDE_PRESERVED[@]}"; then fail "a non-existent opsx slash command is still referenced"; else pass "no opsx slash command referenced"; fi

printf 'T6 installed command paths are runtime-derived\n'
# Bare script names (no tools/ prefix) are just as much a dead call site as the prefixed form —
# an installing agent that reads "run repository-state.sh" has no path at all to run it at,
# since the file was never copied into the target repository. Ban both forms together.
BARE_SCRIPTS='repository-state|verify-docs|check-openspec-root|check-git-naming|sync-submodules|index-all|aggregate-index|gen-index|serpens-lint|check-contract-split-brain|kit-version'
if ! rg -n "/Users/|/home/|/var/lib/zoekt|\.\./clones|bash tools/|tools/[A-Za-z0-9_.-]+\.(sh|mjs)|\\b($BARE_SCRIPTS)\.(sh|mjs)" \
     . --glob '!MANIFEST.sha256' "${RG_EXCLUDE_PRESERVED[@]}" >/dev/null; then
  pass "no machine-specific path and no tools/ or bare script path anywhere in the kit"
else
  fail "a script path (prefixed or bare) or machine-specific path remains"
fi

printf 'T7 serpens-lint keeps only what openspec validate does NOT check\n'
# Delta-spec grammar (missing delta section, non-`### Requirement:` heading, scenario-less
# ADDED/MODIFIED, delta section with no requirement) is the CLI's job since edition .12 —
# every command that writes or reviews a spec runs `validate --strict`. What the lint must still
# catch is what the CLI is measurably blind to: a requirement outside any delta section.
fixture="$(mktemp -d)"
mkdir -p "$fixture/openspec/changes/c1/specs"
delta="$fixture/openspec/changes/c1/specs/spec.md"
lint() { node "$TOOLS/serpens-lint.mjs" "$fixture" >/dev/null 2>&1; }

printf '# Delta\n\n## ADDED Requirements\n\n### Requirement: User signs in\n\n#### Scenario: ok\n- **WHEN** x\n- **THEN** y\n' > "$delta"
if lint; then pass "the literal '### Requirement:' heading passes"; else fail "correct heading rejected"; fi

printf '# Delta\n\n## ADDED Requirements\n\n### \xd0\xa2\xd1\x80\xd0\xb5\xd0\xb1\xd0\xbe\xd0\xb2\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb5 1: \xd0\xb2\xd1\x85\xd0\xbe\xd0\xb4\n\n#### Scenario: ok\n- **WHEN** x\n' > "$delta"
if lint; then fail "translated requirement heading accepted"; else pass "translated requirement heading rejected"; fi

printf '# Delta\n\n## ADDED Requirements\n\n### Requirement: Good\n\nThe system SHALL expose GET /x and return 200.\n\n#### Scenario: ok\n- **WHEN** x\n\n### \xd0\xa2\xd1\x80\xd0\xb5\xd0\xb1\xd0\xbe\xd0\xb2\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb5: \xd0\xb2\xd1\x82\xd0\xbe\xd1\x80\xd0\xbe\xd0\xb5\n\n#### \xd0\xa1\xd1\x86\xd0\xb5\xd0\xbd\xd0\xb0\xd1\x80\xd0\xb8\xd0\xb9: ok\n- **WHEN** y\n' > "$delta"
if lint; then fail "mistyped heading beside a good one accepted (openspec keeps valid=true and drops the requirement)"; else pass "mistyped heading beside a good one rejected"; fi

printf '# Delta\n\n## ADDED Requirements\n\nprose only, no heading\n' > "$delta"
if lint; then pass "empty delta section left to openspec"; else fail "lint still re-implements the openspec parser"; fi

printf '# Delta\n\n## ADDED Requirements\n\n### Requirement: Good\n\nThe system SHALL expose GET /x and return 200.\n\n#### Scenario: ok\n- **WHEN** x\n\n## Notes\n\n### Requirement: Orphan\n\nThe system SHALL do y.\n' > "$delta"
if lint; then fail "requirement outside a delta section accepted (openspec drops it silently)"; else pass "requirement outside a delta section rejected"; fi

printf '# Delta\n\n## ADDED Requirements\n\n### Requirement: X\n\nThe system SHALL do x.\n\n#### Scenario: ok\n- **WHEN** x\n\n```md\n### \xd0\xa2\xd1\x80\xd0\xb5\xd0\xb1\xd0\xbe\xd0\xb2\xd0\xb0\xd0\xbd\xd0\xb8\xd0\xb5: sample\n```\n' > "$delta"
if lint; then pass "a heading inside a fenced example is not flagged"; else fail "fenced example flagged"; fi

# Upstream SCENARIO_HEADER is /^####\s+/ — ANY level-4 heading counts, so Russian scenario
# wording is valid; what archive refuses is an ADDED/MODIFIED requirement with no scenario at all.
printf '# Delta\n\n## ADDED Requirements\n\n### Requirement: \xd0\xb2\xd1\x85\xd0\xbe\xd0\xb4 SHALL work\n\n#### \xd0\xa1\xd1\x86\xd0\xb5\xd0\xbd\xd0\xb0\xd1\x80\xd0\xb8\xd0\xb9: \xd0\xbe\xd0\xba\n- **WHEN** x\n' > "$delta"
if lint; then pass "a Russian scenario heading is accepted (upstream counts any ####)"; else fail "Russian scenario heading wrongly rejected"; fi

printf '# Delta\n\n## ADDED Requirements\n\n### Requirement: X SHALL work\n\nprose but no scenario\n' > "$delta"
if lint; then pass "scenario-less ADDED left to openspec (ERROR: must include at least one scenario)"; else fail "lint still re-implements the openspec parser"; fi

printf '# Delta\n\n## REMOVED Requirements\n\n### Requirement: X\n' > "$delta"
if lint; then pass "REMOVED needs no scenario"; else fail "REMOVED requirement wrongly required a scenario"; fi

printf '# Delta\n\n## RENAMED Requirements\n\n### Requirement: X\n' > "$delta"
if lint; then pass "RENAMED is a valid delta section"; else fail "RENAMED section rejected (openspec accepts it)"; fi
rm -rf "$fixture"

printf 'T7b every command that writes or archives a spec calls openspec validate --strict\n'
for f in spns-spec spns-archive spns-implement spns-review; do
  if rg -q -- 'validate .*--type change --strict --json' "$KIT/commands/$f.md"; then
    pass "$f calls validate --strict"
  else
    fail "$f does not call validate --strict (the lint no longer checks delta grammar)"
  fi
done
if rg -q -- 'validate .*--type change --strict --json' "$KIT/skills/spns-code-review/SKILL.md"; then
  pass "spns-code-review calls validate --strict"
else
  fail "spns-code-review does not call validate --strict"
fi

printf 'T7c every writing command commits its own work, by path\n'
for f in spns-spec spns-plan spns-implement spns-autotest spns-archive; do
  if rg -qi 'commit|коммит' "$KIT/commands/$f.md"; then
    pass "$f commits what it writes"
  else
    fail "$f leaves its work uncommitted for the operator"
  fi
done
for f in spns-spec spns-plan spns-implement spns-autotest; do
  if rg -q -- 'git add -A' "$KIT/commands/$f.md" | rg -qv 'Never|никогда'; then
    fail "$f tells the agent to stage everything (local-only files would be committed)"
  else
    pass "$f stages by path, not everything"
  fi
done

printf 'T7d spns-archive proposes only branch names the pre-push guard accepts\n'
if rg -q -- '-archive`' "$KIT/commands/spns-archive.md"; then
  fail "spns-archive still proposes a feature/<TICKET>-archive branch that check-git-naming.sh rejects"
else
  pass "spns-archive proposes no suffixed branch name"
fi

printf 'T7e the cross-repo fetch line covers the open window, not only the archived spec\n'
if rg -q -- 'show <contract-change-id> --type change --store <store-id> --json --deltas-only' "$KIT/commands/spns-spec.md"; then
  pass "spns-spec fetches the contract while its change is still open"
else
  fail "spns-spec only fetches an archived spec — a dead link for the whole cross-repo window"
fi
if rg -q -- 'show <contract-spec-id> --type spec --store <store-id>' "$KIT/commands/spns-spec.md"; then
  pass "spns-spec also fetches the living spec after the archive"
else
  fail "spns-spec lost the post-archive fetch line"
fi
if rg -q -- '(change show|spec show)' "$KIT/commands/spns-spec.md"; then
  pass "spns-spec warns off the noun-first forms that have no --store"
else
  fail "spns-spec does not warn off change show / spec show (no --store flag there)"
fi

printf 'T7f the contract proposal is required to be readable by the fetch line\n'
if rg -q 'Change must have a Why section' "$KIT/commands/spns-spec.md"; then
  pass "spns-spec names the failure a missing ## Why causes downstream"
else
  fail "spns-spec does not require ## Why — every spoke fetch would die on show_error"
fi
if rg -q 'no "## Why" section' "$TOOLS/serpens-lint.mjs"; then
  pass "the disposer enforces it mechanically, not only in prose"
else
  fail "nothing but prose requires ## Why — the rule is not enforced"
fi
if rg -q 'instructions specs --change <contract-change-id> --store <store-id> --json' "$KIT/commands/spns-spec.md"; then
  pass "spns-spec carries a disk-read fallback for when the CLI refuses"
else
  fail "spns-spec has no fallback when show refuses"
fi

printf 'T7g the branch-name guard runs where lefthook cannot skip it\n'
if [ "$(rg -c '<serpens-sdd> git-naming --branch' "$KIT/config/lefthook.yml.example")" = "2" ]; then
  pass "the branch guard runs at pre-commit and pre-push"
else
  fail "the branch guard exists only on pre-push, which lefthook skips when a push carries no listable files"
fi

printf 'T8 spns-archive keeps the write-then-check index order\n'
if rg -q '<serpens-sdd> index' "$KIT/commands/spns-archive.md"; then pass "spns-archive writes the index"; else fail "spns-archive dropped the index write (verify-docs only runs --check)"; fi
if rg -q '<serpens-sdd> verify-docs' "$KIT/commands/spns-archive.md"; then pass "spns-archive verifies"; else fail "spns-archive lacks verify-docs"; fi

printf 'T9 spns-archive lets the operator choose where the archive commit lands\n'
if rg -q -- '--here' "$KIT/commands/spns-archive.md"; then pass "spns-archive offers --here"; else fail "spns-archive has no --here mode"; fi
if rg -q -- '--branch' "$KIT/commands/spns-archive.md"; then pass "spns-archive offers --branch"; else fail "spns-archive has no --branch mode"; fi
if rg -q '<serpens-sdd> state assert-archivable' "$KIT/commands/spns-archive.md"; then pass "spns-archive gates placement with assert-archivable"; else fail "spns-archive lost the assert-archivable gate"; fi
if rg -q 'assert-archivable' "$TOOLS/repository-state.sh"; then pass "repository-state implements assert-archivable"; else fail "repository-state has no assert-archivable mode"; fi

printf 'T10 every shipped command, skill and tool is version-stamped\n'
if [ -f "$KIT/VERSION" ]; then pass "kit carries a VERSION"; else fail "kit has no VERSION file"; fi
if [ -f "$KIT/MANIFEST.sha256" ]; then pass "kit carries MANIFEST.sha256"; else fail "kit has no MANIFEST.sha256"; fi
if bash "$TOOLS/kit-version.sh" check --root "$KIT" >/dev/null 2>&1; then pass "every stamp matches VERSION"; else fail "a command or skill is unstamped or stale"; fi
if bash "$TOOLS/kit-version.sh" verify --root "$KIT" >/dev/null 2>&1; then pass "every stamped file matches the manifest"; else fail "MANIFEST.sha256 is stale — re-run tests/stamp-kit.py"; fi

printf 'T11 install-time tokens never leak into files the installer copies verbatim\n'
# stage3-store.mjs and stage5-onboard.mjs cp/cpSync these paths into the live store and every
# submodule with NO substitution pass at all (substitution runs only over commands/ and skills/,
# in stage6-install.mjs). A raw <openspec> or <serpens-sdd> token in any of them ships to every
# installed repository as a literal, dead string, and stage 6's own grep (scoped to commands/
# and skills/) can never catch it.
if ! rg -n -- '<openspec>|<serpens-sdd>'      "$KIT/templates/adr.md" "$KIT/templates/research.md" "$KIT/templates/testing-stack.md"      "$KIT/templates/store-contract.md" "$KIT/templates/port-facts.md"      "$KIT/templates/conventions-branching.md" "$KIT/system-store-template" >/dev/null; then
  pass "no unsubstituted install-time token in a verbatim-copied template or system-store-template"
else
  fail "a file the installer copies verbatim still carries a raw <openspec> or <serpens-sdd> token"
fi

printf 'T12 the version proof-of-life SETUP.md runs is a bare no-argument call, and stays runnable\n'
# This kit tree alone cannot prove `<serpens-sdd> version` actually EXITS 0 when run bare — that
# requires the npm package installed (kit-version.sh needs --root, and only the CLI layer
# (src/cli/tools.mjs:defaultVersionArgv) supplies one; no such default exists inside the kit
# itself). The real-execution assertion lives in serpens-sdd-npm/test/version-default.test.mjs
# ("every bare `<serpens-sdd> version` proof-of-life line in both kits' SETUP.md actually runs and
# exits 0"), which runs the real bin against every such line extracted from this same file. Here
# we only assert, statically, that SETUP.md's proof-of-life lines stay bare (no inline args) —
# because the CLI's default only fires for a truly empty argv; a line that grows flags one day
# would silently stop exercising the default this test elsewhere depends on.
bare_version_lines="$(rg -c '^<serpens-sdd> version[[:space:]]*(#.*)?$' "$KIT/docs/SETUP.md")"
if [ "$bare_version_lines" = "2" ]; then
  pass "SETUP.md still shows exactly 2 bare <serpens-sdd> version proof-of-life lines (stage 8 + stage 9)"
else
  fail "expected 2 bare <serpens-sdd> version lines in SETUP.md, found $bare_version_lines — update serpens-sdd-npm/test/version-default.test.mjs's expected count too"
fi

printf 'T13 the lefthook copy step substitutes the token instead of shipping it live\n'
# config/lefthook.yml.example is the ONE kit file that legitimately holds raw <serpens-sdd> tokens
# (T11 deliberately exempts config/): it is the illustrative copy of what the installer generates.
# The danger is the prose. SETUP.md tells an operator to copy that example to lefthook.yml, and a
# copy with no substitution installs `run: <serpens-sdd> verify-docs` as a live pre-commit hook —
# which fails EVERY commit in that repository. stage 6's substitution pass and its grep proof
# cover only the installed command and skill dirs, so nothing else can catch this.
# (The matching runtime assertion, that a generated lefthook.yml carries no token at all, lives in
# serpens-sdd-npm/test/stage5.test.mjs.)
if rg -q '<serpens-sdd>' "$KIT/config/lefthook.yml.example"; then
  pass "the kit's lefthook example still carries the token (it is the illustrative copy)"
else
  fail "config/lefthook.yml.example no longer carries <serpens-sdd> — it must stay tokenized"
fi
# The SETUP step that names the example must, in the same step, both substitute and prove.
lefthook_step="$(rg -A 12 'config/lefthook\.yml\.example' "$KIT/docs/SETUP.md" || true)"
if printf '%s' "$lefthook_step" | rg -q 's\|<serpens-sdd>\|' && printf '%s' "$lefthook_step" | rg -q "grep -n '<serpens-sdd>'"; then
  pass "SETUP.md's lefthook copy step substitutes <serpens-sdd> and greps the result"
else
  fail "SETUP.md tells the agent to copy config/lefthook.yml.example without substituting <serpens-sdd> — every commit in that repo would fail"
fi

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
