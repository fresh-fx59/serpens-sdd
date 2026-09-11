#!/usr/bin/env bash
# No serpens-version stamp: this file ships in the npm package, whose version IS its edition.
# kit-version.sh — identify which Serpens SDD kit edition an installed command or skill came from.
# Every shipped command and skill carries a `serpens-version` stamp; VERSION holds the edition;
# MANIFEST.sha256 pins the exact bytes of each stamped file for that edition. The package's own
# tools/ executables are deliberately NOT in the stamped set (spec section 5) and carry no stamp:
# their edition is the npm package version they ship in.
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  --root <kit> is REQUIRED in every mode: this script ships in the npm package and no longer
  lives inside a kit, so it cannot guess which kit tree you mean.

  bash kit-version.sh show   --root <kit>                  print the kit edition
  bash kit-version.sh list   --root <kit>                  list every stamped file and its stamp
  bash kit-version.sh check  --root <kit>                  fail if any stamp differs from VERSION
  bash kit-version.sh verify --root <kit>                  fail if any file differs from MANIFEST.sha256
  bash kit-version.sh identify --root <kit> <file> [...]   report the edition of an installed copy

  The stamped set is exactly <kit>/commands/*.md and <kit>/skills/*/SKILL.md.

  Called as `serpens-sdd version [mode]`, the CLI supplies --root for you when you omit it,
  pointing at the package's own vendored kit (src/cli/tools.mjs, defaultVersionArgv).
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
    /serpens-version:/ { sub(/^.*serpens-version:[[:space:]]*/, ""); print; exit }
  ' "$1"
}

MODE=${1:-}
[ -n "$MODE" ] || { usage; exit 2; }
shift

ROOT=""
FILES=()
if [ "$MODE" = identify ]; then
  # identify takes --root like every other mode (it needs MANIFEST.sha256 under ROOT for its
  # pristine-file check below), plus one or more positional FILES to identify. (No upfront
  # `$# -gt 0` precheck here: the FILES-empty check after the loop already covers "identify
  # with zero arguments" — an upfront check would be dead code duplicating that one.)
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) [ "$#" -ge 2 ] || { echo "✗ --root needs a value" >&2; exit 2; }; ROOT=$2; shift 2 ;;
      --root=*) ROOT="${1#--root=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      --) shift; while [ "$#" -gt 0 ]; do FILES+=("$1"); shift; done ;;
      -*) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
      *) FILES+=("$1"); shift ;;
    esac
  done
  [ "${#FILES[@]}" -gt 0 ] || { usage; exit 2; }
else
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) [ "$#" -ge 2 ] || { echo "✗ --root needs a value" >&2; exit 2; }; ROOT=$2; shift 2 ;;
      --root=*) ROOT="${1#--root=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
    esac
  done
fi

# The kit root is where VERSION lives. This script no longer lives inside a kit (it ships from
# the npm package's own tools/), so there is no grandparent fallback any more: every caller must
# pass --root explicitly.
if [ -z "$ROOT" ]; then
  echo "✗ --root <kit-root> is required: this script no longer lives inside a kit" >&2
  exit 2
fi
[ -f "$ROOT/VERSION" ] || { echo "✗ no VERSION file in $ROOT" >&2; exit 2; }
KIT_VERSION=$(tr -d '[:space:]' < "$ROOT/VERSION")
MANIFEST="$ROOT/MANIFEST.sha256"

stamped_files() {
  { find "$ROOT/commands" -name '*.md' -type f 2>/dev/null
    find "$ROOT/skills" -name 'SKILL.md' -type f 2>/dev/null
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
