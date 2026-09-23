# ownership.sh — the shell twin of src/ownership.mjs. Sourced by shell tools (serpens-lint.mjs
# is JS and uses ownership.mjs directly; check-git-naming.sh and other shell gates use this).
# Kept deliberately tiny and dependency-free (no yq/python) so it works in the same bare
# environment as the rest of tools/. A parity test (test/ownership.test.mjs) pins JS and shell
# to the same answers on the same fixture tree — see gap 2,
# serpens-openspec-coexistence-gaps-2026-09-22.md.
#
# Marker shape: openspec/changes/<id>/.serpens.yaml, flat key: value lines, first line a comment
# `# serpens-sdd:change-marker`. Never inside upstream's own .openspec.yaml.

# is_owned_change <change-dir>
# True (exit 0) iff <change-dir>/.serpens.yaml exists and its `owner:` value is `serpens-sdd`.
is_owned_change() {
  local dir="$1" marker
  marker="$dir/.serpens.yaml"
  [ -f "$marker" ] || return 1
  grep -Eq '^owner:[[:space:]]*serpens-sdd[[:space:]]*$' "$marker"
}

# is_owned_path <relative-path> <repo-root>
# True iff <relative-path> sits under an OWNED_PREFIXES entry (today: "serpens/") OR under a
# marked (owned) openspec/changes/<id>/ directory, active or archived.
is_owned_path() {
  local rel="$1" root="$2"
  case "$rel" in
    serpens/*) return 0 ;;
  esac
  case "$rel" in
    openspec/changes/archive/*/*|openspec/changes/*/*)
      local change_id rest change_dir
      case "$rel" in
        openspec/changes/archive/*)
          rest="${rel#openspec/changes/archive/}"
          change_id="${rest%%/*}"
          change_dir="$root/openspec/changes/archive/$change_id"
          ;;
        *)
          rest="${rel#openspec/changes/}"
          change_id="${rest%%/*}"
          change_dir="$root/openspec/changes/$change_id"
          ;;
      esac
      is_owned_change "$change_dir"
      return $?
      ;;
  esac
  return 1
}
