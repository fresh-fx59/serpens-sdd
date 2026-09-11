#!/usr/bin/env bash
# Throwaway Git test for repository-state.sh. Uses local bare remotes only.
set -uo pipefail

SCRIPT="${1:?path to repository-state.sh}"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; }
G() { git -c init.defaultBranch=master -c user.email=test@example.invalid -c user.name=test -c commit.gpgsign=false "$@"; }

G init --quiet --bare "$TEST_ROOT/alpha.git"
G clone --quiet "$TEST_ROOT/alpha.git" "$TEST_ROOT/seed" 2>/dev/null
printf 'master\n' > "$TEST_ROOT/seed/state.txt"
# every asserting mode now proves this repository owns its OpenSpec root, so the fixture must be
# onboarded — an empty openspec/ shell does not count, upstream ignores it too
mkdir -p "$TEST_ROOT/seed/openspec/changes"
printf 'alpha\n' > "$TEST_ROOT/seed/openspec/repo.txt"
G -C "$TEST_ROOT/seed" add state.txt openspec/repo.txt
G -C "$TEST_ROOT/seed" commit --quiet -m master
G -C "$TEST_ROOT/seed" push --quiet origin master
G -C "$TEST_ROOT/seed" checkout --quiet -b develop
printf 'develop\n' >> "$TEST_ROOT/seed/state.txt"
G -C "$TEST_ROOT/seed" commit --quiet -am develop
G -C "$TEST_ROOT/seed" push --quiet origin develop

mkdir -p "$TEST_ROOT/store"
G -C "$TEST_ROOT/store" init --quiet
printf 'store\n' > "$TEST_ROOT/store/README.md"
mkdir -p "$TEST_ROOT/store/openspec/specs"
printf 'store\n' > "$TEST_ROOT/store/openspec/repo.txt"
G -C "$TEST_ROOT/store" add README.md openspec/repo.txt
G -C "$TEST_ROOT/store" commit --quiet -m init
GIT_ALLOW_PROTOCOL=file G -C "$TEST_ROOT/store" submodule add --quiet --name alpha -b develop "$TEST_ROOT/alpha.git" submodules/alpha
G -C "$TEST_ROOT/store" config -f .gitmodules submodule.alpha.branch develop
G -C "$TEST_ROOT/store" add .gitmodules submodules/alpha
G -C "$TEST_ROOT/store" commit --quiet -m alpha
REPO="$TEST_ROOT/store/submodules/alpha"

run_state() {
  bash "$SCRIPT" "$@" --repo "$REPO" 2>&1
}

restore_repo() {
  G -C "$REPO" rebase --abort >/dev/null 2>&1 || true
  G -C "$REPO" merge --abort >/dev/null 2>&1 || true
  G -C "$REPO" reset --hard origin/develop >/dev/null
  G -C "$REPO" clean -fd >/dev/null
  G -C "$REPO" stash clear
  G -C "$REPO" checkout --quiet develop
  G -C "$REPO" branch --set-upstream-to=origin/develop develop >/dev/null
}

echo "T1 inspect discovers the configured submodule base branch"
out=$(run_state inspect); rc=$?
if [ "$rc" -eq 0 ] \
  && grep -q '^expected_base=develop$' <<<"$out" \
  && grep -q '^branch=develop$' <<<"$out" \
  && grep -q '^ahead=0$' <<<"$out" \
  && grep -q '^behind=0$' <<<"$out"; then
  ok "reported the real submodule state"
else
  no "inspect output was incomplete (rc=$rc)" "$out"
fi

echo "T2 prepare-base returns a clean temporary branch to develop"
G -C "$REPO" checkout --quiet -b feature/OLD-1
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 0 ] && [ "$(G -C "$REPO" branch --show-current)" = develop ]; then
  ok "prepared the configured base branch"
else
  no "prepare-base did not select develop (rc=$rc)" "$out"
fi

echo "T3 prepare-base refuses dirty work and leaves the branch unchanged"
G -C "$REPO" checkout --quiet feature/OLD-1
printf 'dirty\n' >> "$REPO/state.txt"
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 1 ] && grep -q "uncommitted changes to TRACKED files" <<<"$out" \
  && [ "$(G -C "$REPO" branch --show-current)" = feature/OLD-1 ]; then
  ok "preserved dirty work"
else
  no "dirty work was not protected (rc=$rc)" "$out"
fi
restore_repo

echo "T4 prepare-base refuses detached HEAD"
G -C "$REPO" checkout --quiet --detach HEAD
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 1 ] && grep -q "detached HEAD" <<<"$out"; then
  ok "refused detached HEAD"
else
  no "detached HEAD was not rejected (rc=$rc)" "$out"
fi
restore_repo

echo "T5 prepare-base reports an unpushed commit on ANOTHER branch and continues"
G -C "$REPO" checkout --quiet -b feature/LOCAL-1
printf 'local\n' > "$REPO/local.txt"
G -C "$REPO" add local.txt
G -C "$REPO" commit --quiet -m local
kept=$(G -C "$REPO" rev-parse feature/LOCAL-1)
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 0 ] && grep -q "exist on no remote" <<<"$out" \
  && [ "$(G -C "$REPO" rev-parse feature/LOCAL-1)" = "$kept" ]; then
  ok "warned about a foreign local commit without blocking or losing it"
else
  no "foreign unpushed commit was mishandled (rc=$rc)" "$out"
fi
G -C "$REPO" checkout --quiet develop
G -C "$REPO" branch -D feature/LOCAL-1 >/dev/null 2>&1 || true
restore_repo

echo "T5b prepare-base still refuses an unpushed commit on the base itself"
printf 'onbase\n' >> "$REPO/state.txt"
G -C "$REPO" commit --quiet -am onbase
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 1 ] && grep -q "develop has 1 unpushed commit" <<<"$out"; then
  ok "protected an unpushed commit on the base branch"
else
  no "base-branch unpushed commit was not protected (rc=$rc)" "$out"
fi
restore_repo

echo "T5c a stash warns in prepare-base and assert-change, blocks assert-archivable"
printf 'stashed\n' >> "$REPO/state.txt"
G -C "$REPO" stash push --quiet -m serpens-test
prep=$(run_state prepare-base); prep_rc=$?
G -C "$REPO" checkout --quiet -B feature/DEMO-555 origin/develop
G -C "$REPO" push --quiet -u origin feature/DEMO-555
chg=$(run_state assert-change DEMO-555); chg_rc=$?
arch=$(run_state assert-archivable); arch_rc=$?
if [ "$prep_rc" -eq 0 ] && grep -q "stash entry(s) present" <<<"$prep" \
  && [ "$chg_rc" -eq 0 ] && grep -q "stash entry(s) present" <<<"$chg" \
  && [ "$arch_rc" -eq 1 ] && grep -q "stash entry(s)" <<<"$arch" \
  && [ "$(G -C "$REPO" stash list | wc -l | tr -d ' ')" = "1" ]; then
  ok "stash warns in the daily gates, blocks the archive gate, is never touched"
else
  no "stash handling was incorrect (prep=$prep_rc change=$chg_rc archive=$arch_rc)" "$prep\n$chg\n$arch"
fi
G -C "$REPO" checkout --quiet develop
G -C "$REPO" branch -D feature/DEMO-555 >/dev/null 2>&1 || true
G -C "$REPO" push --quiet origin --delete feature/DEMO-555 >/dev/null 2>&1 || true
restore_repo

echo "T6 prepare-base fast-forwards a clean base"
printf 'remote\n' >> "$TEST_ROOT/seed/state.txt"
G -C "$TEST_ROOT/seed" commit --quiet -am remote
G -C "$TEST_ROOT/seed" push --quiet origin develop
expected=$(G -C "$TEST_ROOT/seed" rev-parse HEAD)
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 0 ] && [ "$(G -C "$REPO" rev-parse HEAD)" = "$expected" ] \
  && grep -q "fast-forwarded develop" <<<"$out"; then
  ok "fast-forwarded safely"
else
  no "clean base was not updated (rc=$rc)" "$out"
fi

echo "T7 prepare-base refuses a diverged base"
printf 'local-diverge\n' > "$REPO/local-diverge.txt"
G -C "$REPO" add local-diverge.txt
G -C "$REPO" commit --quiet -m local-diverge
printf 'remote-diverge\n' > "$TEST_ROOT/seed/remote-diverge.txt"
G -C "$TEST_ROOT/seed" add remote-diverge.txt
G -C "$TEST_ROOT/seed" commit --quiet -m remote-diverge
G -C "$TEST_ROOT/seed" push --quiet origin develop
out=$(run_state prepare-base); rc=$?
if [ "$rc" -eq 1 ] && grep -q "unpushed commit" <<<"$out"; then
  ok "stopped before changing a diverged base"
else
  no "divergence was not rejected (rc=$rc)" "$out"
fi
G -C "$REPO" reset --hard HEAD^ >/dev/null
restore_repo

echo "T8 assert-change accepts the exact tracked feature branch"
G -C "$REPO" checkout --quiet -b feature/DEMO-123
G -C "$REPO" push --quiet -u origin feature/DEMO-123
out=$(run_state assert-change DEMO-123); rc=$?
if [ "$rc" -eq 0 ] && grep -q "feature/DEMO-123 is valid" <<<"$out"; then
  ok "accepted the expected change branch"
else
  no "valid change branch was rejected (rc=$rc)" "$out"
fi

echo "T9 assert-change rejects the wrong ticket branch"
out=$(run_state assert-change DEMO-999); rc=$?
if [ "$rc" -eq 1 ] && grep -q "expected branch feature/DEMO-999" <<<"$out"; then
  ok "rejected the wrong ticket"
else
  no "wrong ticket was not rejected (rc=$rc)" "$out"
fi

echo "T10 assert-change permits dirty implementation state only when explicit"
printf 'work\n' >> "$REPO/state.txt"
blocked=$(run_state assert-change DEMO-123); blocked_rc=$?
allowed=$(run_state assert-change DEMO-123 --allow-dirty); allowed_rc=$?
if [ "$blocked_rc" -eq 1 ] && grep -q "uncommitted changes to TRACKED files" <<<"$blocked" \
  && [ "$allowed_rc" -eq 0 ]; then
  ok "required explicit dirty-state permission"
else
  no "dirty-state mode was incorrect" "$blocked\n$allowed"
fi

echo "T12 assert-archivable accepts a feature branch that contains the base"
restore_repo
G -C "$REPO" checkout --quiet -B feature/DEMO-321 origin/develop
printf 'archive\n' >> "$REPO/state.txt"
G -C "$REPO" commit --quiet -am 'feat(DEMO-321): work'
out=$(run_state assert-archivable); rc=$?
if [ "$rc" -eq 0 ] && grep -q "feature/DEMO-321 contains origin/develop" <<<"$out"; then
  ok "accepted archiving on the current branch"
else
  no "archivable branch was rejected (rc=$rc)" "$out"
fi

echo "T13 assert-archivable rejects a branch that misses the base"
G -C "$REPO" checkout --quiet -B feature/STALE-1 origin/master
out=$(run_state assert-archivable); rc=$?
if [ "$rc" -eq 1 ] && grep -q "does not contain origin/develop" <<<"$out" \
  && grep -q "stale specs" <<<"$out"; then
  ok "refused to archive into stale specs"
else
  no "stale branch was not rejected (rc=$rc)" "$out"
fi
G -C "$REPO" checkout --quiet develop
G -C "$REPO" branch -D feature/STALE-1 feature/DEMO-321 >/dev/null 2>&1
restore_repo

echo "T14 assert-change --checkout switches to an existing local story branch"
restore_repo
G -C "$REPO" checkout --quiet -B feature/DEMO-777 origin/develop
G -C "$REPO" push --quiet -u origin feature/DEMO-777
G -C "$REPO" checkout --quiet develop
out=$(run_state assert-change DEMO-777 --checkout); rc=$?
if [ "$rc" -eq 0 ] && grep -q "switched to feature/DEMO-777" <<<"$out" \
  && [ "$(G -C "$REPO" rev-parse --abbrev-ref HEAD)" = "feature/DEMO-777" ]; then
  ok "switched to the existing story branch"
else
  no "checkout of an existing branch failed (rc=$rc)" "$out"
fi

echo "T15 assert-change --checkout tracks a branch that exists only on origin"
G -C "$REPO" checkout --quiet develop
G -C "$REPO" branch -D feature/DEMO-777 >/dev/null
out=$(run_state assert-change DEMO-777 --checkout); rc=$?
if [ "$rc" -eq 0 ] && grep -q "tracking origin/feature/DEMO-777" <<<"$out" \
  && [ "$(G -C "$REPO" rev-parse --abbrev-ref HEAD)" = "feature/DEMO-777" ]; then
  ok "recreated the local branch from origin"
else
  no "origin-only branch was not tracked (rc=$rc)" "$out"
fi

echo "T16 assert-change --checkout never creates a branch that exists nowhere"
G -C "$REPO" checkout --quiet develop
G -C "$REPO" branch -D feature/DEMO-777 >/dev/null
G -C "$REPO" push --quiet origin --delete feature/DEMO-777 >/dev/null 2>&1
out=$(run_state assert-change DEMO-888 --checkout); rc=$?
if [ "$rc" -eq 1 ] && grep -q "does not exist locally or on origin" <<<"$out" \
  && grep -q "never cuts a new branch" <<<"$out" \
  && [ "$(G -C "$REPO" rev-parse --abbrev-ref HEAD)" = "develop" ]; then
  ok "refused to invent a story branch"
else
  no "missing branch was mishandled (rc=$rc)" "$out"
fi

echo "T17 assert-change --checkout refuses to move dirty work without permission"
G -C "$REPO" checkout --quiet -B feature/DEMO-999 origin/develop
G -C "$REPO" push --quiet -u origin feature/DEMO-999
G -C "$REPO" checkout --quiet develop
printf 'unsaved\n' >> "$REPO/state.txt"
out=$(run_state assert-change DEMO-999 --checkout); rc=$?
if [ "$rc" -eq 1 ] && grep -q "uncommitted changes to TRACKED files" <<<"$out" \
  && [ "$(G -C "$REPO" rev-parse --abbrev-ref HEAD)" = "develop" ] \
  && grep -q unsaved "$REPO/state.txt"; then
  ok "kept dirty work where it was"
else
  no "dirty switch was not refused (rc=$rc)" "$out"
fi

echo "T18 assert-change --checkout --allow-dirty carries interrupted work to the story branch"
out=$(run_state assert-change DEMO-999 --checkout --allow-dirty); rc=$?
if [ "$rc" -eq 0 ] && [ "$(G -C "$REPO" rev-parse --abbrev-ref HEAD)" = "feature/DEMO-999" ] \
  && grep -q unsaved "$REPO/state.txt"; then
  ok "moved the branch and kept the edits"
else
  no "explicit dirty switch failed (rc=$rc)" "$out"
fi
G -C "$REPO" checkout --quiet -- state.txt 2>/dev/null
G -C "$REPO" checkout --quiet develop 2>/dev/null
restore_repo
G -C "$REPO" branch -D feature/DEMO-999 >/dev/null 2>&1
G -C "$REPO" push --quiet origin --delete feature/DEMO-999 >/dev/null 2>&1

echo "T11 a standalone repository uses its durable serpens.baseBranch setting"
G -C "$TEST_ROOT/seed" config serpens.baseBranch master
out=$(bash "$SCRIPT" inspect --repo "$TEST_ROOT/seed" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q '^expected_base=master$' <<<"$out"; then
  ok "used the repository-local base branch"
else
  no "ignored serpens.baseBranch (rc=$rc)" "$out"
fi

echo "T18b untracked files never block any mode"
restore_repo
G -C "$REPO" checkout --quiet -b feature/DEMO-777 develop 2>/dev/null || G -C "$REPO" checkout --quiet feature/DEMO-777
G -C "$REPO" push --quiet -u origin feature/DEMO-777 >/dev/null 2>&1
printf 'password=hunter2\n' > "$REPO/local-settings.properties"
printf 'junk\n' > "$REPO/build-output.tmp"
out=$(run_state assert-change DEMO-777); rc=$?
if [ "$rc" -eq 0 ] && grep -q "untracked file(s) present" <<<"$out"; then
  ok "local-only files were reported, not enforced"
else
  no "untracked files blocked the gate (rc=$rc)" "$out"
fi
if grep -q "^untracked=2" <<<"$(run_state inspect)"; then
  ok "inspect counts untracked files separately"
else
  no "inspect does not report untracked separately" "$(run_state inspect)"
fi
rm -f "$REPO/local-settings.properties" "$REPO/build-output.tmp"
G -C "$REPO" push --quiet origin --delete feature/DEMO-777 >/dev/null 2>&1
restore_repo

echo "T18c a submodule's untracked build output does not make the parent dirty"
SUP="$(mktemp -d)"
G init -q "$SUP/child"; G -C "$SUP/child" config user.email t@t.t; G -C "$SUP/child" config user.name t
mkdir -p "$SUP/child/openspec"; printf 'child\n' > "$SUP/child/openspec/repo.txt"
printf 'x\n' > "$SUP/child/f.txt"; G -C "$SUP/child" add f.txt openspec/repo.txt; G -C "$SUP/child" commit -qm init
G init -q "$SUP/parent"; G -C "$SUP/parent" config user.email t@t.t; G -C "$SUP/parent" config user.name t
mkdir -p "$SUP/parent/openspec"; printf 'parent\n' > "$SUP/parent/openspec/repo.txt"
G -C "$SUP/parent" -c protocol.file.allow=always submodule add -q "$SUP/child" child >/dev/null 2>&1
G -C "$SUP/parent" commit -qm "add submodule" >/dev/null
printf 'junk\n' > "$SUP/parent/child/build.pyc"
out=$(bash "$SCRIPT" inspect --repo "$SUP/parent" --base master 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -q "^dirty=0" <<<"$out"; then
  ok "an untracked file inside a submodule leaves the parent clean"
else
  no "a submodule's build output made the parent dirty (rc=$rc)" "$out"
fi

echo "T18d a submodule's TRACKED change names the submodule, not the parent"
printf 'y\n' >> "$SUP/parent/child/f.txt"
out=$(bash "$SCRIPT" inspect --repo "$SUP/parent" --base master 2>&1)
if grep -q "^dirty=1" <<<"$out"; then
  ok "a tracked change inside a submodule still counts"
else
  no "a tracked submodule change was ignored" "$out"
fi
rm -rf "$SUP"

echo "T19 inspect reports the resolved OpenSpec root without enforcing it"
out=$(run_state inspect)
if grep -q "^openspec_root=.*/submodules/alpha$" <<<"$out"; then
  ok "inspect prints the resolved OpenSpec root"
else
  no "inspect does not report openspec_root" "$out"
fi

echo "T20 a repository that owns no OpenSpec root cannot pass an assert mode"
NR="$(mktemp -d)"
G init -q "$NR/store"; G -C "$NR/store" config user.email t@t.t; G -C "$NR/store" config user.name t
mkdir -p "$NR/store/openspec/specs"; printf 'store\n' > "$NR/store/openspec/repo.txt"
G -C "$NR/store" add openspec/repo.txt; G -C "$NR/store" commit -qm init
mkdir -p "$NR/store/submodules/spoke"
G init -q "$NR/store/submodules/spoke"
G -C "$NR/store/submodules/spoke" config user.email t@t.t; G -C "$NR/store/submodules/spoke" config user.name t
printf 'code\n' > "$NR/store/submodules/spoke/main.py"
G -C "$NR/store/submodules/spoke" add main.py; G -C "$NR/store/submodules/spoke" commit -qm init
out=$(bash "$SCRIPT" assert-change DEMO-1 --repo "$NR/store/submodules/spoke" --base master 2>&1); rc=$?
if [ "$rc" -ne 0 ] && grep -q "OpenSpec root is not this repository" <<<"$out" && grep -qE "resolved root: .*/store$" <<<"$out"; then
  ok "an un-onboarded repository is refused, and the hijacking root is named"
else
  no "a repository whose specs would land in the store was accepted (rc=$rc)" "$out"
fi

echo "T21 inspect still works in that same un-onboarded repository"
out=$(bash "$SCRIPT" inspect --repo "$NR/store/submodules/spoke" --base master 2>&1); rc=$?
if [ "$rc" -eq 0 ] && grep -qE "^openspec_root=.*/store$" <<<"$out"; then
  ok "inspect stayed evidence-only and reported the foreign root"
else
  no "inspect wrongly enforced the root (rc=$rc)" "$out"
fi
rm -rf "$NR"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
