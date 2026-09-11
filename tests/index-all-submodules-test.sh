#!/usr/bin/env bash
set -u

SCRIPT_UNDER_TEST="${1:?usage: index-all-submodules-test.sh <index-all.sh>}"
PASS=0
FAIL=0
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

STORE="$TEST_ROOT/system-store"
BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/zoekt.log"
mkdir -p "$STORE/submodules/alpha/.git" "$STORE/submodules/beta/.git" "$BIN"
cat > "$STORE/.gitmodules" <<'EOF'
[submodule "alpha"]
	path = submodules/alpha
	url = ssh://git.example.test/team/alpha.git
	branch = develop
[submodule "beta"]
	path = submodules/beta
	url = ssh://git.example.test/team/beta.git
	branch = master
EOF

printf '#!/usr/bin/env bash\nprintf "Universal Ctags 6.1.0\\n"\n' > "$BIN/ctags"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$PWD" >> "$ZOEKT_TEST_LOG"\ntouch "$ZOEKT_INDEX_DIR/$(basename "$PWD").zoekt"\n' > "$BIN/zoekt-git-index"
chmod +x "$BIN/ctags" "$BIN/zoekt-git-index"

printf 'T1 indexes only registered submodules\n'
STORE_REAL="$(cd "$STORE" && pwd -P)"
if PATH="$BIN:$PATH" ZOEKT_TEST_LOG="$LOG" ZOEKT_INDEX_DIR="$TEST_ROOT/index" \
  bash "$SCRIPT_UNDER_TEST" --store-root "$STORE" --index-dir "$TEST_ROOT/index" >/dev/null 2>&1 &&
  grep -Fxq "$STORE_REAL/submodules/alpha" "$LOG" &&
  grep -Fxq "$STORE_REAL/submodules/beta" "$LOG" &&
  [ "$(wc -l < "$LOG" | tr -d ' ')" = 2 ]; then
  pass "used .gitmodules paths"
else
  fail "did not index the registered paths"
fi

printf 'T2 rejects unsafe paths before running the indexer\n'
cp "$STORE/.gitmodules" "$TEST_ROOT/good.gitmodules"
cat > "$STORE/.gitmodules" <<'EOF'
[submodule "escape"]
	path = ../escape
	url = ssh://git.example.test/team/escape.git
	branch = develop
EOF
: > "$LOG"
if ! PATH="$BIN:$PATH" ZOEKT_TEST_LOG="$LOG" ZOEKT_INDEX_DIR="$TEST_ROOT/index" \
  bash "$SCRIPT_UNDER_TEST" --store-root "$STORE" --index-dir "$TEST_ROOT/index" >/dev/null 2>&1 &&
  [ ! -s "$LOG" ]; then
  pass "unsafe path failed closed"
else
  fail "unsafe path reached the indexer"
fi
mv "$TEST_ROOT/good.gitmodules" "$STORE/.gitmodules"

printf 'T3 fails clearly when universal-ctags is absent\n'
NO_CTAGS="$TEST_ROOT/no-ctags"
mkdir -p "$NO_CTAGS"
cp "$BIN/zoekt-git-index" "$NO_CTAGS/zoekt-git-index"
if ! PATH="$NO_CTAGS:/usr/bin:/bin" ZOEKT_TEST_LOG="$LOG" ZOEKT_INDEX_DIR="$TEST_ROOT/index" \
  bash "$SCRIPT_UNDER_TEST" --store-root "$STORE" --index-dir "$TEST_ROOT/index" >/dev/null 2>&1; then
  pass "missing ctags stopped indexing"
else
  fail "missing ctags was accepted"
fi

printf '\nPASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
