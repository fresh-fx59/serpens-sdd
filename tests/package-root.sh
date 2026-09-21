#!/usr/bin/env bash
# Shared by shell suites: the vault and public repository name the package differently.
serpens_package_root() {
  local root candidate
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || return 1
  for candidate in "$root/serpens-sdd-npm" "$root/npm"; do
    if [ -f "$candidate/package.json" ] && [ -d "$candidate/tools" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf 'Cannot locate the package (package.json and tools/ required). Tried:\n  %s\n  %s\n' \
    "$root/serpens-sdd-npm" "$root/npm" >&2
  return 1
}
