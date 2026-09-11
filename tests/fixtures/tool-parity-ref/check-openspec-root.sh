#!/usr/bin/env bash
# corp-version: 2026-08-26.8
# check-openspec-root.sh — refuse to run the SDD flow against the wrong OpenSpec root.
#
# OpenSpec resolves its root by walking UP from the current directory looking for openspec/.
# The walk does NOT stop at a .git boundary (verified, OpenSpec 1.7.0). So a code repo that was
# never `openspec init`-ed — or that sits inside another OpenSpec root's directory tree —
# silently resolves to the PARENT root, and every spec the agent writes lands there.
#
# This asserts: the resolved OpenSpec root is THIS git repo's root. Run it before any spec work.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "✗ not inside a git repository" >&2
  exit 1
fi

if [ ! -d "$repo_root/openspec" ]; then
  echo "✗ no openspec/ in this repo ($repo_root)" >&2
  echo "  ↳ this repo was never onboarded; specs would be written to a parent root" >&2
  echo "  ↳ run: npx @fission-ai/openspec init --tools <your-agent> ." >&2
  exit 1
fi

# walk up from cwd exactly the way OpenSpec does, and report the FIRST openspec/ found
dir="$PWD"
resolved=""
while :; do
  if [ -d "$dir/openspec" ]; then resolved="$dir"; break; fi
  parent="$(dirname "$dir")"
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

if [ -z "$resolved" ]; then
  echo "✗ no OpenSpec root found from $PWD" >&2
  exit 1
fi

if [ "$resolved" != "$repo_root" ]; then
  echo "✗ WRONG OpenSpec root" >&2
  echo "    resolved: $resolved" >&2
  echo "    this repo: $repo_root" >&2
  echo "  ↳ specs would be written OUTSIDE this repo. Fix the nesting or onboard this repo." >&2
  exit 1
fi

echo "✓ OpenSpec root = $repo_root (this repo)"
