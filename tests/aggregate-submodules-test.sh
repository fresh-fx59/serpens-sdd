#!/usr/bin/env bash
# Throwaway test for aggregate-index.mjs reading .gitmodules instead of repos.json.
set -uo pipefail

SCRIPT="${1:?path to aggregate-index.mjs}"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; printf '%s\n' "$2" | sed 's/^/      /'; }
G() { git -c init.defaultBranch=master -c user.email=test@example.invalid -c user.name=test -c commit.gpgsign=false "$@"; }

STORE="$TEST_ROOT/store"
mkdir -p "$STORE/submodules/alpha/openspec" "$STORE/submodules/beta"
G -C "$STORE" init --quiet
for repo in alpha beta; do
  G -C "$STORE/submodules/$repo" init --quiet
  printf '%s\n' "$repo" > "$STORE/submodules/$repo/README.md"
  G -C "$STORE/submodules/$repo" add README.md
  G -C "$STORE/submodules/$repo" commit --quiet -m init
done
cat > "$STORE/.gitmodules" <<EOF
[submodule "alpha"]
  path = submodules/alpha
  url = ssh://forge.example/team/alpha.git
  branch = develop
[submodule "beta"]
  path = submodules/beta
  url = ssh://forge.example/team/beta.git
  branch = master
EOF
cat > "$STORE/submodules/alpha/openspec/index.json" <<'EOF'
{"schema_version":1,"source_digest":"digest-alpha","capabilities":[{"id":"orders","title":"Orders","summary":"Order lifecycle"}]}
EOF
cat > "$STORE/catalog.json" <<'EOF'
{"schema_version":1,"entries":[{"name":"beta","url":"old","head":"abc","digest":"old","capabilities":[]}],"red":[]}
EOF

echo "T1 catalog is generated from .gitmodules metadata"
out=$(node "$SCRIPT" "$STORE" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && node - "$STORE/catalog.json" <<'NODE'
const c = require(process.argv[2]);
const alpha = c.entries.find(x => x.name === 'alpha');
if (!alpha || alpha.url !== 'ssh://forge.example/team/alpha.git' || alpha.base_branch !== 'develop') process.exit(1);
if (alpha.capabilities?.[0]?.id !== 'orders') process.exit(1);
if (!c.red.some(x => x.name === 'beta')) process.exit(1);
const beta = c.entries.find(x => x.name === 'beta');
if (!beta?.stale) process.exit(1);
NODE
then
  ok "read submodules and retained last-good red data"
else
  no "catalog did not use .gitmodules (rc=$rc)" "$out"
fi

echo "T2 strict mode fails when a registered submodule has no index"
out=$(node "$SCRIPT" --strict "$STORE" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "beta: openspec/index.json missing" <<<"$out"; then
  ok "strict mode exposed the red submodule"
else
  no "strict mode did not fail correctly (rc=$rc)" "$out"
fi

echo "T3 an unsafe submodule path fails before catalog output changes"
before=$(shasum -a 256 "$STORE/catalog.json" | awk '{print $1}')
G -C "$STORE" config -f .gitmodules submodule.alpha.path ../escape
out=$(node "$SCRIPT" "$STORE" 2>&1); rc=$?
after=$(shasum -a 256 "$STORE/catalog.json" | awk '{print $1}')
if [ "$rc" -eq 2 ] && grep -q "invalid submodule path" <<<"$out" && [ "$before" = "$after" ]; then
  ok "path input gate failed atomically"
else
  no "unsafe path was not rejected safely (rc=$rc)" "$out"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
