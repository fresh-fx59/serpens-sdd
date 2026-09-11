#!/usr/bin/env bash
# corp-version: 2026-08-26.8
# kit-version.sh — identify which Corp SDD kit edition a command, skill or tool came from.
# Every shipped command, skill and tool carries a `corp-version:` stamp; VERSION holds the
# edition; MANIFEST.sha256 pins the exact bytes of each stamped file for that edition.
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  bash kit-version.sh show                        print the kit edition
  bash kit-version.sh list [--root <kit>]         list every stamped file and its stamp
  bash kit-version.sh check [--root <kit>]        fail if any stamp differs from VERSION
  bash kit-version.sh verify [--root <kit>]       fail if any file differs from MANIFEST.sha256
  bash kit-version.sh identify <file> [...]       report the edition of an installed copy
EOF
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# The stamp is the last frontmatter key in markdown, and line 2 in a script.
stamp_of() {
  awk '
    NR > 40 { exit }
    /corp-version:/ { sub(/^.*corp-version:[[:space:]]*/, ""); print; exit }
  ' "$1"
}

MODE=${1:-}
[ -n "$MODE" ] || { usage; exit 2; }
shift

ROOT=""
FILES=()
if [ "$MODE" = identify ]; then
  [ "$#" -gt 0 ] || { usage; exit 2; }
  FILES=("$@")
else
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) ROOT=${2:-}; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
    esac
  done
fi

# The kit root is where VERSION lives: the --root override, else this script's grandparent.
if [ -z "$ROOT" ]; then
  ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
fi
[ -f "$ROOT/VERSION" ] || { echo "✗ no VERSION file in $ROOT" >&2; exit 2; }
KIT_VERSION=$(tr -d '[:space:]' < "$ROOT/VERSION")
MANIFEST="$ROOT/MANIFEST.sha256"

stamped_files() {
  { find "$ROOT/commands" -name '*.md' -type f 2>/dev/null
    find "$ROOT/skills" -name 'SKILL.md' -type f 2>/dev/null
    find "$ROOT/scripts/tools" -type f \( -name '*.sh' -o -name '*.mjs' \) 2>/dev/null
  } | LC_ALL=C sort
}

case "$MODE" in
  show)
    printf '%s\n' "$KIT_VERSION"
    ;;
  list)
    while IFS= read -r f; do
      printf '%s\t%s\n' "$(stamp_of "$f")" "${f#"$ROOT"/}"
    done < <(stamped_files)
    ;;
  check)
    bad=0
    while IFS= read -r f; do
      got=$(stamp_of "$f")
      if [ "$got" != "$KIT_VERSION" ]; then
        echo "✗ ${f#"$ROOT"/}: stamp '${got:-NONE}', expected '$KIT_VERSION'" >&2
        bad=$((bad + 1))
      fi
    done < <(stamped_files)
    if [ "$bad" -eq 0 ]; then echo "✓ every stamped file is $KIT_VERSION"; exit 0; fi
    exit 1
    ;;
  verify)
    [ -f "$MANIFEST" ] || { echo "✗ no MANIFEST.sha256 in $ROOT" >&2; exit 2; }
    bad=0
    while read -r want rel; do
      [ -n "${rel:-}" ] || continue
      if [ ! -f "$ROOT/$rel" ]; then echo "✗ $rel: missing" >&2; bad=$((bad + 1)); continue; fi
      got=$(sha256 "$ROOT/$rel")
      if [ "$got" != "$want" ]; then echo "✗ $rel: modified since $KIT_VERSION" >&2; bad=$((bad + 1)); fi
    done < "$MANIFEST"
    if [ "$bad" -eq 0 ]; then echo "✓ $(grep -c . "$MANIFEST") file(s) match $KIT_VERSION"; exit 0; fi
    exit 1
    ;;
  identify)
    rc=0
    for f in "${FILES[@]}"; do
      if [ ! -f "$f" ]; then echo "✗ $f: not a file" >&2; rc=1; continue; fi
      got=$(sha256 "$f")
      stamp=$(stamp_of "$f")
      hit=""
      [ -f "$MANIFEST" ] && hit=$(awk -v h="$got" '$1 == h { print $2; exit }' "$MANIFEST")
      if [ -n "$hit" ]; then
        printf '%s\tpristine %s\t(kit path %s)\n' "$f" "${stamp:-NONE}" "$hit"
      elif [ -n "$stamp" ]; then
        printf '%s\tstamped %s but MODIFIED (bytes not in this kit edition)\n' "$f" "$stamp"
        rc=1
      else
        printf '%s\tUNSTAMPED — predates versioning or is your own copy\n' "$f"
        rc=1
      fi
    done
    exit "$rc"
    ;;
  *) echo "✗ unknown mode: $MODE" >&2; usage; exit 2 ;;
esac
