#!/usr/bin/env bash
# corp-version: 2026-08-26.8
# Reconcile a normalized project repository inventory into system-store/submodules/.
# Adds and validates only. Removed bindings are reported and never deleted automatically.
set -uo pipefail

usage() {
  echo "usage: bash sync-submodules.sh --inventory <json> [--store-root <path>]" >&2
}

INVENTORY=""
STORE_ROOT="${CORP_SYSTEM_STORE_ROOT:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --inventory) INVENTORY=${2:-}; shift 2 ;;
    --store-root) STORE_ROOT=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$INVENTORY" ] || [ ! -f "$INVENTORY" ]; then
  echo "✗ --inventory must name normalized project repository JSON" >&2
  exit 2
fi

if [ -z "$STORE_ROOT" ]; then
  script_dir=$(cd "$(dirname "$0")" && pwd -P)
  installed_candidate=$(cd "$script_dir/.." && pwd -P)
  installed_top=$(git -C "$installed_candidate" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$installed_top" ] \
    && [ "$(cd "$installed_top" && pwd -P)" = "$installed_candidate" ]; then
    STORE_ROOT="$installed_candidate"
  else
    starter_root=$(cd "$script_dir/../.." && pwd -P)
    STORE_ROOT=$(cd "$starter_root/.." && pwd -P)/system-store
  fi
fi
if [ ! -d "$STORE_ROOT" ]; then
  echo "✗ system store does not exist: $STORE_ROOT" >&2
  echo "  ↳ copy system-store-template/ there and initialize Git first" >&2
  exit 2
fi
STORE_ROOT=$(cd "$STORE_ROOT" && pwd -P)
if ! git -C "$STORE_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "✗ system store is not a Git repository: $STORE_ROOT" >&2
  exit 2
fi
if [ "$(cd "$(git -C "$STORE_ROOT" rev-parse --show-toplevel)" && pwd -P)" != "$STORE_ROOT" ]; then
  echo "✗ store root must be its own Git repository: $STORE_ROOT" >&2
  exit 2
fi

inventory_rows=$(node - "$INVENTORY" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
let data;
try { data = JSON.parse(fs.readFileSync(path, 'utf8')); }
catch (error) { console.error(`✗ invalid inventory JSON: ${error.message}`); process.exit(2); }
if (data.schema_version !== 1 || typeof data.project !== 'string' || !data.project.trim()) {
  console.error('✗ inventory requires schema_version 1 and a non-empty project');
  process.exit(2);
}
if (!Array.isArray(data.repositories)) {
  console.error('✗ inventory requires repositories[]');
  process.exit(2);
}
const seen = new Set();
for (const repo of data.repositories) {
  if (!repo || !/^[a-z0-9][a-z0-9._-]*$/.test(repo.name ?? '')) {
    console.error(`✗ invalid repository name: ${JSON.stringify(repo?.name)}`);
    process.exit(2);
  }
  if (seen.has(repo.name)) {
    console.error(`✗ duplicate repository name: ${repo.name}`);
    process.exit(2);
  }
  seen.add(repo.name);
  for (const key of ['url', 'base_branch']) {
    if (typeof repo[key] !== 'string' || !repo[key] || /[\s\t\r\n]/.test(repo[key])) {
      console.error(`✗ ${repo.name}: ${key} must be a non-empty value without whitespace`);
      process.exit(2);
    }
  }
  process.stdout.write(`${repo.name}\t${repo.url}\t${repo.base_branch}\n`);
}
NODE
) || exit $?

normalize_url() {
  printf '%s' "${1%/}" | sed -e 's#/*$##' -e 's#\.git$##'
}

# Validate every input and existing target before the first write.
validation_failed=0
while IFS=$'\t' read -r name url branch; do
  [ -n "$name" ] || continue
  if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
    echo "✗ $name: invalid base branch '$branch'" >&2
    validation_failed=1
    continue
  fi
  expected_path="submodules/$name"
  registered_path=$(git -C "$STORE_ROOT" config -f .gitmodules --get "submodule.$name.path" 2>/dev/null || true)
  registered_url=$(git -C "$STORE_ROOT" config -f .gitmodules --get "submodule.$name.url" 2>/dev/null || true)
  if [ -n "$registered_path" ] && [ "$registered_path" != "$expected_path" ]; then
    echo "✗ $name: registered path is '$registered_path', expected '$expected_path'" >&2
    validation_failed=1
  elif [ -n "$registered_url" ] && [ "$(normalize_url "$registered_url")" != "$(normalize_url "$url")" ]; then
    echo "✗ $name: registered URL does not match project inventory" >&2
    echo "    registered: $registered_url" >&2
    echo "    inventory:  $url" >&2
    validation_failed=1
  elif [ -e "$STORE_ROOT/$expected_path" ] && [ -z "$registered_path" ]; then
    echo "✗ $name: target exists but is not a registered submodule" >&2
    echo "    target: $STORE_ROOT/$expected_path" >&2
    validation_failed=1
  fi
done <<< "$inventory_rows"
[ "$validation_failed" -eq 0 ] || exit 1

mkdir -p "$STORE_ROOT/submodules"
configured_names=" "
while IFS=$'\t' read -r name url branch; do
  [ -n "$name" ] || continue
  configured_names="$configured_names$name "
  path="submodules/$name"
  registered=$(git -C "$STORE_ROOT" config -f .gitmodules --get "submodule.$name.path" 2>/dev/null || true)
  if [ -z "$registered" ]; then
    echo "→ adding $name on $branch"
    if ! git -C "$STORE_ROOT" submodule add --quiet --name "$name" -b "$branch" "$url" "$path"; then
      echo "✗ $name: git submodule add failed" >&2
      exit 1
    fi
    echo "✓ $name (added at $path)"
  else
    if ! git -C "$STORE_ROOT" submodule update --init -- "$path" >/dev/null; then
      echo "✗ $name: submodule initialization failed" >&2
      exit 1
    fi
    echo "✓ $name (registered)"
  fi
  git -C "$STORE_ROOT" config -f .gitmodules "submodule.$name.branch" "$branch"
done <<< "$inventory_rows"

if [ -f "$STORE_ROOT/.gitmodules" ]; then
  while read -r key path; do
    [ -n "$key" ] || continue
    name=${key#submodule.}
    name=${name%.path}
    case "$configured_names" in
      *" $name "*) ;;
      *) echo "⚠ orphaned submodule binding: $name ($path) — absent from inventory; preserved" ;;
    esac
  done < <(git -C "$STORE_ROOT" config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null || true)
fi

count=$(printf '%s\n' "$inventory_rows" | sed '/^$/d' | wc -l | tr -d ' ')
echo "✓ reconciled $count project-bound submodule(s) in $STORE_ROOT/submodules"
