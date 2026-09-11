#!/usr/bin/env bash
# Throwaway test for kit-version.sh. Copies the kit to a temp dir; never touches the real one.
set -uo pipefail

KIT="${1:?path to starter kit root}"
KIT=$(cd "$KIT" && pwd -P)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; }

cp -R "$KIT" "$TEST_ROOT/kit"
K="$TEST_ROOT/kit"
V=$(tr -d '[:space:]' < "$K/VERSION")
KVBIN="$(cd "$(dirname "$0")/.." && pwd)/serpens-sdd-npm/tools/kit-version.sh"
KV() { bash "$KVBIN" "$@" --root "$K" 2>&1; }

echo "T1 show prints the kit edition"
out=$(KV show); rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "$V" ]; then ok "reported $V"; else no "show was wrong (rc=$rc)" "$out"; fi

echo "T2 every shipped command, skill and tool is stamped with that edition"
out=$(KV check); rc=$?
if [ "$rc" -eq 0 ] && grep -q "every stamped file is $V" <<<"$out"; then
  ok "all stamps agree with VERSION"
else
  no "a stamp is missing or stale (rc=$rc)" "$out"
fi

echo "T3 the stamped set is commands + skills only — no script is shipped in the kit any more"
out=$(KV list)
if grep -q 'scripts/tools' <<<"$out"; then
  no "kit-version still walks scripts/tools" "$out"
else
  ok "stamped set carries no script path"
fi
if grep -q 'commands/spns-spec.md' <<<"$out" && grep -q 'skills/spns-tdd/SKILL.md' <<<"$out"; then
  ok "commands and skills are stamped"
else
  no "a command or skill is missing from the stamped set" "$out"
fi

echo "T4 verify passes on a pristine kit and fails on an edited file"
clean=$(KV verify); clean_rc=$?
printf '\nlocal edit\n' >> "$K/commands/spns-plan.md"
dirty=$(KV verify); dirty_rc=$?
if [ "$clean_rc" -eq 0 ] && [ "$dirty_rc" -eq 1 ] \
  && grep -q "commands/spns-plan.md: modified since $V" <<<"$dirty"; then
  ok "detected the local edit"
else
  no "verify did not separate pristine from edited ($clean_rc/$dirty_rc)" "$clean\n$dirty"
fi
git -C "$K" checkout -- commands/spns-plan.md 2>/dev/null || cp "$KIT/commands/spns-plan.md" "$K/commands/spns-plan.md"

echo "T5 identify tells pristine, modified and unstamped installs apart"
mkdir -p "$TEST_ROOT/install"
cp "$K/commands/spns-archive.md" "$TEST_ROOT/install/pristine.md"
cp "$K/commands/spns-archive.md" "$TEST_ROOT/install/theirs.md"
printf '\nlocal tweak\n' >> "$TEST_ROOT/install/theirs.md"
printf -- '---\ndescription: x\n---\nold copy\n' > "$TEST_ROOT/install/ancient.md"
out=$(KV identify "$TEST_ROOT/install/pristine.md" "$TEST_ROOT/install/theirs.md" "$TEST_ROOT/install/ancient.md"); rc=$?
if [ "$rc" -eq 1 ] \
  && grep -q "pristine.md	pristine $V" <<<"$out" \
  && grep -q "theirs.md	stamped $V but MODIFIED" <<<"$out" \
  && grep -q "ancient.md	UNSTAMPED" <<<"$out"; then
  ok "classified all three installed copies"
else
  no "identify misclassified a copy (rc=$rc)" "$out"
fi

echo "T7 kit-version refuses to guess a kit root"
out="$(bash "$KVBIN" check 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && grep -q 'root' <<<"$out"; then
  ok "kit-version refuses to guess a kit root"
else
  no "kit-version without --root did not exit 2 (rc=$rc)" "$out"
fi

echo "T8 identify --root works explicitly; a valueless --root exits 2 instead of hanging"
out="$(bash "$KVBIN" identify --root "$K" "$TEST_ROOT/install/pristine.md" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "pristine.md	pristine $V" <<<"$out"; then
  ok "identify --root <kit> <file> works"
else
  no "identify --root <kit> <file> did not work (rc=$rc)" "$out"
fi
out="$(timeout 5 bash "$KVBIN" identify --root 2>&1)"; rc=$?
if [ "$rc" -eq 2 ]; then
  ok "identify with a valueless --root exits 2 instead of hanging"
elif [ "$rc" -eq 124 ]; then
  no "identify with a valueless --root hung (timeout killed it)" "$out"
else
  no "identify with a valueless --root did not exit 2 (rc=$rc)" "$out"
fi

echo "T6 a missing VERSION is a hard stop, not a guess"
rm -f "$K/VERSION"
out=$(KV show); rc=$?
if [ "$rc" -eq 2 ] && grep -q "no VERSION file" <<<"$out"; then
  ok "refused to run without VERSION"
else
  no "ran without VERSION (rc=$rc)" "$out"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
