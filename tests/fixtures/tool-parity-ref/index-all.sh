#!/usr/bin/env bash
# corp-version: 2026-08-26.8
# Rebuild the optional Zoekt index for every registered Git submodule.
set -euo pipefail

usage() {
  echo "usage: index-all.sh [--store-root <path>] [--index-dir <path>]" >&2
}

STORE_ROOT="${CORP_SYSTEM_STORE_ROOT:-}"
INDEX_DIR="${CORP_ZOEKT_INDEX_DIR:-}"
ZOEKT_GIT_INDEX="${ZOEKT_GIT_INDEX:-zoekt-git-index}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --store-root) [ "$#" -ge 2 ] || { usage; exit 2; }; STORE_ROOT="$2"; shift 2 ;;
    --index-dir) [ "$#" -ge 2 ] || { usage; exit 2; }; INDEX_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [ -z "$STORE_ROOT" ]; then
  STORE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$STORE_ROOT" ] || { echo "✗ system-store root is required" >&2; exit 2; }
STORE_ROOT="$(cd "$STORE_ROOT" && pwd -P)"
GITMODULES="$STORE_ROOT/.gitmodules"
INDEX_DIR="${INDEX_DIR:-$STORE_ROOT/.cache/zoekt/index}"

[ -f "$GITMODULES" ] || { echo "✗ missing $GITMODULES; run sync-submodules.sh first" >&2; exit 1; }
command -v ctags >/dev/null 2>&1 && ctags --version 2>/dev/null | grep -q 'Universal Ctags' || {
  echo "✗ universal-ctags not on PATH — sym: search would be silently dead" >&2
  exit 1
}
command -v "$ZOEKT_GIT_INDEX" >/dev/null 2>&1 || {
  echo "✗ $ZOEKT_GIT_INDEX not on PATH" >&2
  exit 1
}

paths_file="$(mktemp)"
trap 'rm -f "$paths_file"' EXIT
git config -f "$GITMODULES" --get-regexp '^submodule\..*\.path$' | awk '{print $2}' > "$paths_file"
[ -s "$paths_file" ] || { echo "✗ no submodules registered in $GITMODULES" >&2; exit 1; }

# Validate every path before creating output or invoking the indexer.
while IFS= read -r relative_path; do
  name="$(basename "$relative_path")"
  case "$name" in ''|.|..|*[!A-Za-z0-9._-]*) echo "✗ unsafe submodule name: $name" >&2; exit 1 ;; esac
  [ "$relative_path" = "submodules/$name" ] || {
    echo "✗ unsafe submodule path: $relative_path (expected submodules/$name)" >&2
    exit 1
  }
done < "$paths_file"

mkdir -p "$INDEX_DIR"
rc=0
while IFS= read -r relative_path; do
  repo="$STORE_ROOT/$relative_path"
  name="$(basename "$relative_path")"
  if [ ! -e "$repo/.git" ]; then
    echo "✗ registered submodule is not materialized: $relative_path" >&2
    rc=1
    continue
  fi
  echo "→ indexing $name"
  if ! (cd "$repo" && "$ZOEKT_GIT_INDEX" -require_ctags -incremental -index "$INDEX_DIR" .); then
    echo "✗ index FAILED for $name" >&2
    rc=1
  fi
done < "$paths_file"

shards="$(find "$INDEX_DIR" -name '*.zoekt' -type f | wc -l | tr -d ' ')"
echo "✓ index dir $INDEX_DIR holds $shards shard(s)"
exit "$rc"
