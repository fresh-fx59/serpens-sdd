#!/usr/bin/env bash
# check-git-naming.sh ownership scoping (gap 1, serpens-openspec-coexistence-gaps-2026-09-22.md,
# step 3, "Branch/commit-msg"). Before this, --branch and --commit-msg enforced the Serpens
# naming convention on EVERY branch and EVERY commit in a repository, including a team's own
# vanilla OpenSpec work. This suite proves the gate: unowned work is unchecked (⚠, exit 0);
# owned work (a staged Serpens path, or a branch a marker names) is still enforced in full.
set -uo pipefail

CHECK="${1:?path to check-git-naming.sh}"
CHECK=$(cd "$(dirname "$CHECK")" && pwd -P)/$(basename "$CHECK")
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; }

new_git_repo() {
  R="$TEST_ROOT/$1"
  rm -rf "$R"
  mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t
  git -C "$R" config user.name t
  printf 'root\n' > "$R/ROOT.md"
  git -C "$R" add ROOT.md
  git -C "$R" commit -q -m 'feat(ABCD-0000): initial commit'
}

mark_change() {
  # $1 = change dir, $2 = branch value to record in the marker
  mkdir -p "$1"
  cat > "$1/.serpens.yaml" <<EOF
# serpens-sdd:change-marker
owner: serpens-sdd
ticket: ABCD-1234
branch: $2
created: 2026-09-22
EOF
}

echo "G1 a non-conforming branch with only vanilla files staged is UNCHECKED"
new_git_repo g1
git -C "$R" checkout -q -b wip/foo
printf 'vanilla team content\n' > "$R/docs.md"
git -C "$R" add docs.md
out=$(cd "$R" && "$CHECK" --branch 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "not a Serpens branch — unchecked" <<<"$out"; then
  ok "a vanilla branch with only vanilla files staged is skipped, not refused"
else
  no "the vanilla branch was judged as if it were ours (rc=$rc)" "$out"
fi

echo "G2 the SAME branch, with a Serpens-owned path staged, is enforced — and fails (wip/foo does not match feature/<TICKET>)"
mkdir -p "$R/serpens"
printf 'x\n' > "$R/serpens/index.json"
git -C "$R" add serpens/index.json
out=$(cd "$R" && "$CHECK" --branch 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "does not match the convention" <<<"$out"; then
  ok "a Serpens-owned path staged brings the branch check back, and it fails as it should"
else
  no "a Serpens-owned path staged did not restore the check (rc=$rc)" "$out"
fi

echo "G3 a conforming branch, with a Serpens-owned path staged, passes"
git -C "$R" checkout -q -b feature/ABCD-1234
out=$(cd "$R" && "$CHECK" --branch 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "matches feature/<TICKET>" <<<"$out"; then
  ok "a conforming Serpens branch passes in full"
else
  no "a conforming branch with owned work staged was rejected (rc=$rc)" "$out"
fi

echo "G4 a commit message on a vanilla branch with only vanilla files staged is UNCHECKED"
new_git_repo g4
git -C "$R" checkout -q -b wip/bar
printf 'vanilla team content\n' > "$R/docs.md"
git -C "$R" add docs.md
printf 'not even close to the convention\n' > "$R/msg.txt"
out=$(cd "$R" && "$CHECK" --commit-msg "$R/msg.txt" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "not Serpens work — unchecked" <<<"$out"; then
  ok "a vanilla commit message is skipped, not refused"
else
  no "a vanilla commit message was judged as if it were ours (rc=$rc)" "$out"
fi

echo "G5 the SAME commit, with a Serpens-owned path staged, is enforced and fails"
mkdir -p "$R/serpens"
printf 'x\n' > "$R/serpens/index.json"
git -C "$R" add serpens/index.json
out=$(cd "$R" && "$CHECK" --commit-msg "$R/msg.txt" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "does not match the convention" <<<"$out"; then
  ok "a Serpens-owned path staged brings the commit-msg check back, and it fails as it should"
else
  no "a Serpens-owned path staged did not restore the commit-msg check (rc=$rc)" "$out"
fi

echo "G6 a branch NAMED IN A MARKER, with nothing staged, is still enforced (and fails: malformed)"
new_git_repo g6
git -C "$R" checkout -q -b totally/not-a-ticket-shape
mark_change "$R/openspec/changes/c1" "totally/not-a-ticket-shape"
out=$(cd "$R" && "$CHECK" --branch 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "does not match the convention" <<<"$out"; then
  ok "a marker naming this exact branch enforces the check even with nothing staged"
else
  no "a marker-named branch was left unchecked (rc=$rc)" "$out"
fi

echo "G7 an UNMARKED change dir (no owner: serpens-sdd) naming the branch does NOT enforce"
new_git_repo g7
git -C "$R" checkout -q -b totally/vanilla-branch
mkdir -p "$R/openspec/changes/c1"
cat > "$R/openspec/changes/c1/.serpens.yaml" <<'EOF'
# serpens-sdd:change-marker
owner: someone-else
branch: totally/vanilla-branch
EOF
out=$(cd "$R" && "$CHECK" --branch 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "not a Serpens branch — unchecked" <<<"$out"; then
  ok "a marker not owned by us does not enforce the branch check"
else
  no "an unowned marker still enforced the branch check (rc=$rc)" "$out"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
