#!/usr/bin/env bash
# Throwaway tree test for serpens-lint.mjs. No git, no network.
set -uo pipefail

LINT="${1:?path to serpens-lint.mjs}"
LINT=$(cd "$(dirname "$LINT")" && pwd -P)/$(basename "$LINT")
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; }

new_repo() {
  R="$TEST_ROOT/$1"
  rm -rf "$R"
  mkdir -p "$R/openspec/specs/cap" "$R/openspec/changes/c1/specs/cap" "$R/docs"
  cat > "$R/openspec/specs/cap/spec.md" <<'EOF'
# Cap
Краткое описание возможности.

## Требования и границы
### Requirement: Раздел
#### Сценарий: ок
EOF
  printf '{\n  "schema_version": 1,\n  "repo": "r",\n  "source_digest": "d",\n  "capabilities": [\n    {"id": "cap", "title": "Cap", "path": "openspec/specs/cap/spec.md", "summary": "s"}\n  ]\n}\n' > "$R/openspec/index.json"
}

echo "L1 a Cyrillic heading anchor resolves"
new_repo ru
printf '# Док\n[ru](../openspec/specs/cap/spec.md#требования-и-границы)\n' > "$R/docs/a.md"
out=$(node "$LINT" "$R" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "accepted a link to a Russian heading"
else
  no "Russian anchor was reported broken (rc=$rc)" "$out"
fi

echo "L2 a wrong Cyrillic anchor is still an error"
printf '# Док\n[ru](../openspec/specs/cap/spec.md#нет-такого)\n' > "$R/docs/a.md"
out=$(node "$LINT" "$R" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "broken anchor" <<<"$out"; then
  ok "still catches an anchor that does not exist"
else
  no "a nonexistent Russian anchor passed (rc=$rc)" "$out"
fi

echo "L3 Latin headings keep working"
printf '# Doc\n[en](../openspec/specs/cap/spec.md#cap)\n' > "$R/docs/a.md"
out=$(node "$LINT" "$R" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "accepted a link to a Latin heading"
else
  no "Latin anchor regressed (rc=$rc)" "$out"
fi

echo "L4 a broken relative link is still an error"
printf '# Doc\n[gone](../openspec/specs/nope/spec.md)\n' > "$R/docs/a.md"
out=$(node "$LINT" "$R" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "broken link" <<<"$out"; then
  ok "still catches a missing target"
else
  no "missing target passed (rc=$rc)" "$out"
fi

echo "L5 a requirement no tester can observe only warns"
new_repo obs
cat > "$R/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Internal mapping
The mapper SHALL handle nulls correctly.

#### Scenario: nulls
- WHEN the value is absent
- THEN nothing breaks
EOF
out=$(node "$LINT" "$R" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "names no observable surface" <<<"$out"; then
  ok "warned without blocking"
else
  no "observability hint was wrong (rc=$rc)" "$out"
fi

echo "L6 a requirement with an endpoint and a status code does not warn"
cat > "$R/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Refund endpoint
The service SHALL expose POST /api/refunds and return 201 with the refund id.

#### Scenario: accepted refund
- WHEN POST /api/refunds is called with a valid body
- THEN the response is 201 and a row appears in the refunds table
EOF
out=$(node "$LINT" "$R" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && ! grep -q "names no observable surface" <<<"$out"; then
  ok "stayed quiet on an observable requirement"
else
  no "false observability warning (rc=$rc)" "$out"
fi

echo "L7 the agent home is discovered, not hard-coded"
A="$(mktemp -d)"; mkdir -p "$A/.acme/skills/spns-big" "$A/openspec" "$A/docs"
awk 'BEGIN { for (i = 0; i < 300; i++) print "line" }' > "$A/.acme/skills/spns-big/SKILL.md"
out=$(node "$LINT" "$A" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q ".acme/skills/spns-big/SKILL.md" <<<"$out" && grep -q "hard cap 250" <<<"$out"; then
  ok "capped skills under a discovered agent home"
else
  no "did not lint the discovered agent home (rc=$rc)" "$out"
fi

echo "L8 two agent homes stop the lint instead of a guess"
mkdir -p "$A/.other/skills"
out=$(node "$LINT" "$A" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "more than one agent home found" <<<"$out"; then
  ok "refused to guess between two homes"
else
  no "did not stop on two agent homes (rc=$rc)" "$out"
fi
rm -rf "$A"

echo "L9 a requirement outside a delta section is still ours (openspec drops it silently)"
D="$(mktemp -d)"; mkdir -p "$D/openspec/changes/c1/specs/cap" "$D/docs"
cat > "$D/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Good one
The service SHALL expose GET /x and return 200.

#### Scenario: ok
- WHEN GET /x
- THEN 200

## Notes
### Requirement: Orphan
The service SHALL do something.
EOF
out=$(node "$LINT" "$D" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q 'sits outside a delta section' <<<"$out"; then
  ok "kept the check openspec does not make"
else
  no "orphan requirement was not caught (rc=$rc)" "$out"
fi

echo "L10 grammar openspec validates is NOT re-checked here"
cat > "$D/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: Scenario-less
The service SHALL expose GET /x and return 200.
EOF
out=$(node "$LINT" "$D" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && ! grep -qE 'has no scenario|no requirement heading' <<<"$out"; then
  ok "delegated delta grammar to openspec validate --strict"
else
  no "still re-implementing the openspec parser (rc=$rc)" "$out"
fi
rm -rf "$D"

echo "L11 the skill cap applies to spns-* skills only, not to the port's own"
V="$(mktemp -d)"; mkdir -p "$V/.acme/skills/spns-tdd" "$V/.acme/skills/openspec-proposal" "$V/openspec" "$V/docs"
awk 'BEGIN { for (i = 0; i < 320; i++) print "line" }' > "$V/.acme/skills/openspec-proposal/SKILL.md"
printf 'short\n' > "$V/.acme/skills/spns-tdd/SKILL.md"
out=$(node "$LINT" "$V" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a vendor skill this kit does not own is not capped"
else
  no "capped a skill the kit neither writes nor may edit (rc=$rc)" "$out"
fi
awk 'BEGIN { for (i = 0; i < 320; i++) print "line" }' > "$V/.acme/skills/spns-tdd/SKILL.md"
out=$(node "$LINT" "$V" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "spns-tdd/SKILL.md" <<<"$out"; then
  ok "our own oversized skill is still capped"
else
  no "the cap stopped applying to our own skills (rc=$rc)" "$out"
fi
rm -rf "$V"

echo "L12 a proposal without ## Why is caught here, not by openspec"
P="$(mktemp -d)"; mkdir -p "$P/openspec/changes/c1/specs/cap" "$P/docs"
cat > "$P/openspec/changes/c1/specs/cap/spec.md" <<'EOF'
## ADDED Requirements
### Requirement: X
The service SHALL expose GET /x and return 200.

#### Scenario: ok
- WHEN x
- THEN 200
EOF
printf 'prose only, no headings\n' > "$P/openspec/changes/c1/proposal.md"
out=$(node "$LINT" "$P" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q 'no "## Why" section' <<<"$out" && grep -q 'no "## What Changes" section' <<<"$out"; then
  ok "an unreadable proposal fails before it reaches another repository"
else
  no "a proposal openspec show cannot parse was accepted (rc=$rc)" "$out"
fi
printf '## Why\nbecause\n\n## What Changes\n- x\n' > "$P/openspec/changes/c1/proposal.md"
out=$(node "$LINT" "$P" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then ok "both headings present passes"; else no "a valid proposal was rejected (rc=$rc)" "$out"; fi
rm -rf "$P"

echo "L13 MODIFIED against a capability with no living spec fails here, not after the merge"
M="$(mktemp -d)"; mkdir -p "$M/openspec/changes/c1/specs/billing" "$M/docs"
printf '## Why\nx\n\n## What Changes\n- y\n' > "$M/openspec/changes/c1/proposal.md"
cat > "$M/openspec/changes/c1/specs/billing/spec.md" <<'EOF'
## MODIFIED Requirements
### Requirement: X
The service SHALL expose GET /x and return 200.

#### Scenario: ok
- WHEN x
- THEN 200
EOF
out=$(node "$LINT" "$M" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q 'has no living spec' <<<"$out"; then
  ok "the archive-time failure is moved to authoring time"
else
  no "a MODIFIED delta openspec archive would refuse was accepted (rc=$rc)" "$out"
fi
mkdir -p "$M/openspec/specs/billing"
cat > "$M/openspec/specs/billing/spec.md" <<'EOF'
## Purpose
Billing capability for the service.

## Requirements
### Requirement: X
The service SHALL expose GET /x and return 200.

#### Scenario: ok
- WHEN x
- THEN 200
EOF
out=$(node "$LINT" "$M" 2>&1)
if ! grep -q 'has no living spec' <<<"$out"; then
  ok "a MODIFIED delta with its living spec present is accepted"
else
  no "a legitimate MODIFIED delta was rejected" "$out"
fi
rm -rf "$M"

echo "L14 an unfilled port-facts.md is caught; a probed one passes"
F="$(mktemp -d)"; mkdir -p "$F/openspec" "$F/docs"
cat > "$F/port-facts.md" <<'EOF'
# Port facts — <port name + version> (probed YYYY-MM-DD)

| # | Question | Probe ran | Evidence (verbatim output) | Conclusion |
|---|---|---|---|---|
| P1 | agent home + project instruction file | ... | ... | e.g. `.acme/` |
EOF
out=$(node "$LINT" "$F" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q 'template placeholder' <<<"$out"; then
  ok "an install running on the untouched template is refused"
else
  no "port-facts.md is still unchecked (rc=$rc)" "$out"
fi
cat > "$F/port-facts.md" <<'EOF'
# Port facts — acme-cli 2.4 (probed 2026-08-26)

| # | Question | Probe ran | Evidence (verbatim output) | Conclusion |
|---|---|---|---|---|
| P1 | agent home + project instruction file | ls -a | .acme/ ACME.md | `.acme/` + `ACME.md` |
EOF
out=$(node "$LINT" "$F" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then ok "a probed port-facts.md passes"; else no "a filled port-facts.md was rejected (rc=$rc)" "$out"; fi
rm -rf "$F"

echo "L15 documented embed syntax inside inline code is not a broken directive"
E="$(mktemp -d)"; mkdir -p "$E/openspec" "$E/docs"
printf 'Use `<!-- embed: path#Lx-Ly -->` to pull a shape from source.\n' > "$E/docs/guide.md"
out=$(node "$LINT" "$E" 2>&1)
if ! grep -q 'looks like an embed directive' <<<"$out"; then
  ok "prose about the directive is not reported as one"
else
  no "documented syntax still warns" "$out"
fi
printf 'text\n<!-- embed: nope -->\n' > "$E/docs/guide.md"
out=$(node "$LINT" "$E" 2>&1)
if grep -q 'looks like an embed directive' <<<"$out"; then
  ok "a genuinely broken directive still warns"
else
  no "the embed check stopped working" "$out"
fi
rm -rf "$E"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
