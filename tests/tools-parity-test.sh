#!/usr/bin/env bash
# Parity gate for kit edition 2026-08-26.9: every serpens-sdd subcommand must behave like the
# script it replaces.
#
# The reference bytes are VENDORED into tests/fixtures/tool-parity-ref/ (see manifest.json in
# that directory for provenance: which commit and historical path each file was pulled from).
# This suite must run unmodified in a repo that carries NONE of this vault's git history — the
# public `fresh-fx59/serpens-sdd` repo is published as a snapshot commit with no imported
# ancestry, on purpose, so `git rev-list` over vault history finds nothing there. Vendoring
# means the gate still works: the bytes travel in the tree, not in an ancestry that may not.
#
# Where this vault's OWN history IS present (this checkout), verify_vendor_drift() below still
# re-derives each file from git history and diffs it against the vendored copy, so a vendored
# file can never silently drift from the commit its provenance record claims. Where history is
# absent (the public-repo layout), that check reports SKIP with a reason — it never silently
# passes as though it had run.
set -u
SERPENS_SDD_ARG="${1:?usage: tools-parity-test.sh <path to bin/serpens-sdd.mjs>}"
# Resolve to an absolute path up front: parity_case cd's into throwaway fixture dirs before
# invoking $SERPENS_SDD, so a relative path (the common invocation form) would silently break.
SERPENS_SDD="$(cd "$(dirname "$SERPENS_SDD_ARG")" && pwd)/$(basename "$SERPENS_SDD_ARG")"
# HISTORICAL path, and it must stay spelled `corp-sdd-starter`: this is a git-history
# coordinate, not a current identifier, used only by verify_vendor_drift()'s re-derivation
# below (and recorded per-file in manifest.json). The 2026-09-09.1 rename moved the live tree
# to serpens-sdd-starter/, but the reference bytes were pulled from commits made BEFORE the
# rename, where the only path that ever existed is the corp- one. Renaming this string makes
# the drift check fail to re-derive every file. Same reason `lint`'s reference file below is
# still corp-lint.mjs.
KIT_PREFIX="content/enterprise-sdd-agents/corp-sdd-starter/scripts/tools"
# VAULT_ROOT is only consulted by verify_vendor_drift() (re-deriving from git history when it's
# present); the actual test bytes come from VENDOR_DIR below regardless of whether VAULT_ROOT
# turns out to be a git repo with the relevant history.
VAULT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VENDOR_DIR="$(cd "$(dirname "$0")/fixtures/tool-parity-ref" && pwd)"
# One level up from tests/ — content/enterprise-sdd-agents/ in this vault, the repository root
# in the public layout (npm/, en/, ru/, tests/ side by side). Used below to locate the `en` kit
# tree under either of its two names, same candidate order as scripts/kit-source.mjs's
# resolveKitSource('en'): this vault calls it serpens-sdd-starter, the public repo calls it en.
ENTERPRISE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -d "$ENTERPRISE_ROOT/serpens-sdd-starter" ]; then
  EN_KIT_DIR="$ENTERPRISE_ROOT/serpens-sdd-starter"
elif [ -d "$ENTERPRISE_ROOT/en" ]; then
  EN_KIT_DIR="$ENTERPRISE_ROOT/en"
else
  printf 'FATAL: cannot locate the en kit tree — neither %s/serpens-sdd-starter nor %s/en exists\n' \
    "$ENTERPRISE_ROOT" "$ENTERPRISE_ROOT" >&2
  exit 1
fi
MANIFEST="$VENDOR_DIR/manifest.json"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS+1)); }
fail() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1" >&2; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP %s\n' "$1" >&2; }

# manifest_get <file> <field> — read one field of tests/fixtures/tool-parity-ref/manifest.json's
# per-file provenance record. Uses node (always present — this is an npm package's test suite)
# rather than jq, which is not a guaranteed dependency in every layout this runs in.
manifest_get() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = m.files[process.argv[2]];
    if (!entry || !(process.argv[3] in entry)) process.exit(1);
    process.stdout.write(String(entry[process.argv[3]]));
  ' "$MANIFEST" "$1" "$2"
}

# manifest_files — newline-separated list of every file name the manifest tracks.
manifest_files() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const name of Object.keys(m.files)) process.stdout.write(name + "\n");
  ' "$MANIFEST"
}

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# apply_redactions_sha256 <file> <hist_bytes_path> — reads manifest.json's per-file
# `redactions` list ({line, find_sha256, replace}), applies it to the raw historical
# bytes at <hist_bytes_path>, and prints the sha256 of the result. Each recorded line must hash
# EXACTLY ONCE in the bytes at the time it is applied — zero occurrences means the redaction
# no longer describes the history (drifted or corrupted entry), more than one means the
# redaction is ambiguous about which occurrence it redacts. Either is a distinct, named
# failure rather than a silent no-op or a silent pick of "the first match".
apply_redactions_sha256() {
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = m.files[process.argv[2]];
    let text = fs.readFileSync(process.argv[3], "utf8");
    const redactions = (entry && entry.redactions) || [];
    // A redaction is recorded as {line, find_sha256, replace}: the line number in the ORIGINAL
    // historical bytes, the sha256 of that line, and the safe text it becomes. The original
    // text is deliberately NOT quoted here — it is what the redaction removes, and quoting it
    // in a file that ships publicly would put the noun straight back. Anyone holding this
    // vault history can re-derive it from the recorded commit and path.
    if (redactions.length) {
      const lines = text.split("\n");
      for (const r of redactions) {
        const i = r.line - 1;
        if (!Number.isInteger(i) || i < 0 || i >= lines.length) {
          process.stderr.write("REDACTION_LINE_OUT_OF_RANGE\n");
          process.exit(4);
        }
        const actual = crypto.createHash("sha256").update(lines[i], "utf8").digest("hex");
        if (actual !== r.find_sha256) {
          process.stderr.write("REDACTION_NOT_FOUND\n");
          process.exit(2);
        }
        lines[i] = r.replace;
      }
      text = lines.join("\n");
    }
    process.stdout.write(crypto.createHash("sha256").update(text, "utf8").digest("hex"));
  ' "$MANIFEST" "$1" "$2"
}

# verify_vendor_drift — for every vendored file, confirm its bytes still match:
#   (a) the sha256 recorded in manifest.json (catches a corrupted provenance record OR a
#       vendored file edited without updating its record), and
#   (b) when this vault's git history is reachable from VAULT_ROOT: the RAW historical bytes
#       git history yields for that file's recorded commit + historical_path still match
#       manifest.json's recorded original_sha256 (catches drift in the unredacted source),
#       AND those same historical bytes, with every recorded redaction applied in order,
#       hash to the vendored/manifest sha256 (catches a vendored file that no longer equals
#       "history + the redactions this record claims to have applied" — a corrupted
#       redaction entry, a corrupted vendored file, or a real silent drift, all named
#       distinctly).
# The real invariant this enforces: history bytes, with the recorded redactions applied,
# equal the vendored bytes. Comparing raw history to the vendored sha directly (the old
# check) would now fail forever on any file with a non-empty `redactions` list — that is
# expected and correct, not a regression: a comment can be redacted without weakening the
# gate only because this check verifies the redaction is exactly what's recorded, not that
# nothing changed.
# When history is unreachable (public-repo layout, no ancestry), (b) is SKIPPED with a named
# reason per file — never silently treated as passed.
verify_vendor_drift() {
  local history_available=1
  git -C "$VAULT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || history_available=0

  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    local vendored="$VENDOR_DIR/$name"
    if [ ! -f "$vendored" ]; then
      fail "vendor-drift $name: no vendored file at $vendored"
      continue
    fi
    local recorded_sha; recorded_sha="$(manifest_get "$name" sha256)" || {
      fail "vendor-drift $name: manifest.json has no sha256 entry"
      continue
    }
    local actual_sha; actual_sha="$(sha256_of "$vendored")"
    if [ "$actual_sha" != "$recorded_sha" ]; then
      fail "vendor-drift $name: vendored bytes (sha256 $actual_sha) do not match manifest.json's recorded sha256 ($recorded_sha)"
      continue
    fi

    if [ "$history_available" -eq 0 ]; then
      skip "vendor-drift $name: VAULT_ROOT ($VAULT_ROOT) is not a git working tree — this is the public-repo layout with no imported ancestry, by design; provenance is recorded in manifest.json instead"
      continue
    fi
    local hist_path; hist_path="$(manifest_get "$name" historical_path)" || {
      fail "vendor-drift $name: manifest.json has no historical_path entry"
      continue
    }
    local expected_commit; expected_commit="$(manifest_get "$name" commit)" || {
      fail "vendor-drift $name: manifest.json has no commit entry"
      continue
    }
    local recorded_original_sha; recorded_original_sha="$(manifest_get "$name" original_sha256)" || {
      fail "vendor-drift $name: manifest.json has no original_sha256 entry"
      continue
    }
    local resolved_commit
    resolved_commit="$(resolve_ref_commit "$hist_path")"
    if [ -z "$resolved_commit" ]; then
      skip "vendor-drift $name: '$hist_path' not found in any ancestor of HEAD in $VAULT_ROOT — history for this path is not reachable here"
      continue
    fi
    local hist_bytes; hist_bytes="$(mktemp)"
    git -C "$VAULT_ROOT" show "$resolved_commit:$hist_path" > "$hist_bytes" 2>/dev/null
    local hist_sha; hist_sha="$(sha256_of "$hist_bytes")"
    if [ "$hist_sha" != "$recorded_original_sha" ]; then
      rm -f "$hist_bytes"
      fail "vendor-drift $name: git history at $resolved_commit:$hist_path (sha256 $hist_sha) no longer matches manifest.json's recorded original_sha256 ($recorded_original_sha)"
      continue
    fi
    local redacted_sha; redacted_sha="$(apply_redactions_sha256 "$name" "$hist_bytes")"; local redact_rc=$?
    rm -f "$hist_bytes"
    if [ "$redact_rc" -eq 2 ]; then
      fail "vendor-drift $name: a recorded redaction does not match the historical bytes at its recorded line — the line number or its recorded hash is stale or corrupted"
      continue
    elif [ "$redact_rc" -eq 3 ]; then
      fail "vendor-drift $name: a recorded redaction points outside the historical bytes (line number out of range)"
      continue
    elif [ "$redact_rc" -ne 0 ]; then
      fail "vendor-drift $name: applying manifest.json's recorded redactions failed (exit $redact_rc)"
      continue
    fi
    if [ "$redacted_sha" != "$recorded_sha" ]; then
      fail "vendor-drift $name: history at $resolved_commit:$hist_path with manifest.json's recorded redactions applied (sha256 $redacted_sha) does not match the vendored bytes (sha256 $recorded_sha) — the vendored copy is not exactly 'history + these redactions'"
      continue
    fi
    if [ "$resolved_commit" != "$expected_commit" ]; then
      fail "vendor-drift $name: resolve_ref_commit now finds $resolved_commit but manifest.json records $expected_commit for the same path — bytes still match by content, but the recorded commit is stale"
      continue
    fi
    pass
  done < <(manifest_files)
}

# The reference bytes must survive the scripts' own removal: once Task 3 deletes
# serpens-sdd-starter/scripts/tools/, HEAD no longer has the path at all, so `git show HEAD:...`
# goes blind (fails) the moment the deleting commit lands. Instead, resolve the LAST commit in
# which the path still existed: `git rev-list -1 HEAD -- <path>` finds the commit that most
# recently touched the path; if that commit no longer has the file (it was the deletion), its
# first parent is the last commit that did. This keeps working forever as more commits land on
# top — it is pinned to history, not to a moving branch tip. Do NOT hard-code a SHA here: a
# hard-coded SHA rots on the first rebase and would read as a pass while comparing against
# nothing. Used only by verify_vendor_drift() now (the actual test bytes come from VENDOR_DIR);
# if the path cannot be found in any ancestor, callers treat that as "history unreachable here",
# not a hard failure — see verify_vendor_drift above.
resolve_ref_commit() {
  local path="$1"
  local last; last="$(git -C "$VAULT_ROOT" rev-list -1 HEAD -- "$path" 2>/dev/null)"
  [ -n "$last" ] || return 1
  if git -C "$VAULT_ROOT" cat-file -e "$last:$path" 2>/dev/null; then
    printf '%s\n' "$last"
    return 0
  fi
  # $last is the commit that removed the path (its tree no longer has it) — the last commit
  # that DID have it is $last's first parent.
  local parent; parent="$(git -C "$VAULT_ROOT" rev-parse "$last^" 2>/dev/null)" || return 1
  git -C "$VAULT_ROOT" cat-file -e "$parent:$path" 2>/dev/null || return 1
  printf '%s\n' "$parent"
}

# Materialize the pre-move script into $ROOT/old/<name> from the VENDORED reference bytes
# (tests/fixtures/tool-parity-ref/<name> — see manifest.json for provenance). This works
# identically whether or not this checkout carries the git history the bytes were pulled from;
# verify_vendor_drift() above is what checks the vendored copy against history when it can.
old_script() {
  local name="$1"
  mkdir -p "$ROOT/old"
  local vendored="$VENDOR_DIR/$name"
  [ -f "$vendored" ] || return 1
  cp "$vendored" "$ROOT/old/$name" || return 1
  chmod +x "$ROOT/old/$name"
  printf '%s\n' "$ROOT/old/$name"
}

# A throwaway git repository with one commit on the given base branch.
fixture() {
  local dir="$ROOT/fix/$1"; shift
  mkdir -p "$dir"; git -C "$dir" init --quiet -b main
  git -C "$dir" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m "chore(T-1): base"
  printf '%s\n' "$dir"
}

# parity_case <label> <script-name> <subcommand> [argv...]
parity_case() {
  local label="$1" name="$2" sub="$3"; shift 3
  local script; script="$(old_script "$name")" || { fail "$label: no vendored reference bytes for $name in $VENDOR_DIR"; return; }
  local script_dir; script_dir="$(cd "$(dirname "$script")" && pwd)"
  local a b; a="$(fixture "${label}-a")"; b="$(fixture "${label}-b")"
  local runner=bash
  case "$name" in *.mjs) runner=node ;; esac
  local out_a rc_a err_a out_b rc_b err_b
  local err_a_file err_b_file
  err_a_file="$(mktemp)"; err_b_file="$(mktemp)"
  out_a="$(cd "$a" && "$runner" "$script" "$@" 2>"$err_a_file")"; rc_a=$?
  err_a="$(cat "$err_a_file")"
  out_b="$(cd "$b" && node "$SERPENS_SDD" "$sub" "$@" 2>"$err_b_file")"; rc_b=$?
  err_b="$(cat "$err_b_file")"
  rm -f "$err_a_file" "$err_b_file"
  # Fixture paths and the reference script's temp directory differ by design; normalize
  # both out before comparing stdout and stderr.
  out_a="${out_a//$a/REPO}"; out_b="${out_b//$b/REPO}"
  err_a="${err_a//$a/REPO}"; err_b="${err_b//$b/REPO}"
  out_a="${out_a//$script_dir/KIT}"; out_b="${out_b//$script_dir/KIT}"
  err_a="${err_a//$script_dir/KIT}"; err_b="${err_b//$script_dir/KIT}"
  # Fix round 4 (Task 12's weak-model gate) removed a dead-path remediation hint from
  # gen-index.mjs's own drift message: it used to tell the reader to run `node
  # tools/gen-index.mjs`, a script this edition deleted from the kit. The reference script here
  # is frozen from BEFORE that fix (resolve_ref_commit above finds the last commit that still
  # had the pre-move path, by design — it predates fix round 4 entirely). Normalize that one
  # known, deliberate wording change so this gate keeps asserting real behavioral parity (exit
  # code, drift detection, every other byte) without re-demanding the very defect fix round 4
  # exists to remove.
  # The 2026-09-09.1 rename: the frozen reference script is corp-lint.mjs and prints its own
  # name; the package prints serpens-lint. A tool naming itself is not behaviour, so normalize
  # the old name to the new one for this case only, and keep comparing every other byte.
  if [ "$label" = "lint" ]; then
    out_a="${out_a//corp-lint/serpens-lint}"; err_a="${err_a//corp-lint/serpens-lint}"
  fi
  if [ "$label" = "index-check" ]; then
    # A bash `${var//search/replace}` pattern with escaped literal slashes (`\/`) in `search`
    # is NOT portable: bash 3.2 (macOS's /bin/bash, where this passed for months) and bash 5.2
    # (Debian/Ubuntu, incl. every GitHub Actions runner) disagree on how `\/` unescapes inside
    # that construct, so the exact same line normalizes cleanly on a dev Mac and corrupts the
    # string (partial, duplicated replacement) on the real CI target — reproduced with Docker
    # `node:22-bookworm` (bash 5.2.15) against this exact line. `sed` with a `#`-delimited
    # literal substitution needs no slash-escaping and behaves identically on both, so this is
    # done with `sed`, not bash pattern matching, specifically because it must run unmodified on
    # a target CLI/shell this dev machine does not natively provide.
    err_a="$(printf '%s' "$err_a" | sed 's#node tools/gen-index.mjs && git add openspec/index.json openspec/index.md openspec/repo.txt#serpens-sdd index \&\& git add openspec/index.json openspec/index.md openspec/repo.txt#')"
  fi
  # spec-drop-inventory-file-2026-09-11.md §6: sync-submodules.sh gained `--repos-from -`
  # alongside the unchanged `--inventory`. The frozen reference script predates that change and
  # only knows the one-flag usage line; normalize it to the current two-flag usage so this case
  # keeps asserting real behavioral parity (exit code, the rest of the message) rather than
  # re-demanding a usage string this edition deliberately extended.
  if [ "$label" = "sync-submodules" ]; then
    err_a="${err_a//usage: bash sync-submodules.sh --inventory <json> \[--store-root <path>\]/usage: bash sync-submodules.sh (--inventory <json>|--repos-from -) [--store-root <path>]}"
  fi
  # spec-org-facts-slice-branching-2026-09-11.md: assert-change gained an optional
  # `--conventions <path>` flag (tools/lib/branch-contract.sh — the one contract
  # check-git-naming.sh and repository-state.sh now both read). The frozen reference script
  # predates that flag and only knows the old, shorter usage line; normalize it to the current
  # one so these two cases keep asserting real behavioral parity (exit code, the rest of the
  # usage dump) rather than re-demanding a usage string this edition deliberately extended.
  if [ "$label" = "state-bad-mode" ] || [ "$label" = "state-no-args" ]; then
    err_a="${err_a//bash repository-state.sh assert-change <TICKET> \[--repo <path>\] \[--allow-dirty\] \[--checkout\]/bash repository-state.sh assert-change <TICKET> [--repo <path>] [--allow-dirty] [--checkout] [--conventions <path>]}"
  fi
  local diverged=()
  [ "$rc_a" = "$rc_b" ] || diverged+=("rc $rc_a vs $rc_b")
  [ "$out_a" = "$out_b" ] || diverged+=("stdout")
  [ "$err_a" = "$err_b" ] || diverged+=("stderr")
  if [ "${#diverged[@]}" -eq 0 ]; then
    pass
  else
    fail "$label: ${diverged[*]}"
    if [ "$out_a" != "$out_b" ]; then
      echo "-- stdout diff --" >&2
      diff <(printf '%s\n' "$out_a") <(printf '%s\n' "$out_b") >&2 || true
    fi
    if [ "$err_a" != "$err_b" ]; then
      echo "-- stderr diff --" >&2
      diff <(printf '%s\n' "$err_a") <(printf '%s\n' "$err_b") >&2 || true
    fi
  fi
}

# --- vendored-bytes provenance gate --------------------------------------
# Must run before the parity cases below use old_script(), which now reads VENDOR_DIR
# unconditionally — this is what actually guards those bytes against drift.
verify_vendor_drift

parity_case state-prepare-base repository-state.sh state prepare-base --base main

# --- success invocations -------------------------------------------------
parity_case state-inspect        repository-state.sh          state          inspect
parity_case state-archivable     repository-state.sh          state          assert-archivable --base main
parity_case git-naming-branch    check-git-naming.sh          git-naming     --branch
parity_case openspec-root        check-openspec-root.sh       openspec-root
parity_case lint                 corp-lint.mjs                   lint
parity_case index-check          gen-index.mjs                index          --check
parity_case split-brain          check-contract-split-brain.mjs split-brain
parity_case catalog              aggregate-index.mjs          catalog        --strict
parity_case sync-submodules      sync-submodules.sh           sync-submodules --help
parity_case index-code           index-all.sh                 index-code     --help
# The 2026-09-09.1 rename renamed the frontmatter stamp key `corp-version:` to
# `serpens-version:`. The frozen reference kit-version.sh only knows the OLD key, so pointed at
# the live kit it reports every file as stamp 'NONE' while the package reports green — a diff
# that says nothing about behaviour and everything about the key's name. Fix: hand BOTH sides
# one byte-identical throwaway copy of the kit that carries BOTH keys, so each side reads the
# key it knows from the same bytes and the case still asserts what it exists to assert — does
# `version check --root` see the stamps and agree on exit code and wording. Do NOT point this
# case back at the live kit tree, and do NOT normalize the stderr away: that would delete the
# assertion instead of repairing it.
KIT_ROOT_ABS="$ROOT/kit-dual"
cp -R "$EN_KIT_DIR" "$KIT_ROOT_ABS"
while IFS= read -r f; do
  perl -pi -e 's/^(serpens-version: (.*))$/corp-version: $2\n$1/' "$f"
done < <(find "$KIT_ROOT_ABS/commands" -name '*.md'; find "$KIT_ROOT_ABS/skills" -name 'SKILL.md')
parity_case version-check-root   kit-version.sh               version        check --root "$KIT_ROOT_ABS"
# version --help, version-no-root, and version-identify all removed: kit-version.sh (see
# serpens-sdd-starter/scripts/tools/kit-version.sh) sets MODE=$1 then shift (~line 32-34); its
# flag loop only sees args AFTER the mode (~line 43-46), so a leading --help is consumed as
# MODE and never reaches the `-h|--help) usage; exit 0` arm. With no --root, ROOT falls back
# to the script's own grandparent (~line 53-55), and the `[ -f "$ROOT/VERSION" ]` check at
# line 56 is UNCONDITIONAL — it runs before the `case "$MODE"` dispatch (~line 66) for every
# mode, `identify` included. `identify` (~line 38-40) skips the flag-parsing loop and takes
# FILES=("$@") instead, which means it has NO way to be handed a `--root` at all — it still
# requires the fallback root, it just cannot override it. So every mode depends on the
# fallback, and the two sides sit in different directories by construction (old_script()
# always relocates the reference script to a temp dir) — any case exercising the fallback
# measures where the file landed, not behaviour. The only meaningful kit-version parity case
# is version-check-root above, where an explicit --root is handed identically to both sides.
# Do not re-add version --help, version-no-root, or version-identify.

# --- failure invocations: a swallowed non-zero is the bug we are hunting ---
parity_case state-bad-mode       repository-state.sh          state          not-a-mode
parity_case git-naming-bad-arg   check-git-naming.sh          git-naming     --nonsense
parity_case state-no-args        repository-state.sh          state

# verify-docs: package-implemented. Assert it runs all three checks against the git root and
# that any one of them failing fails the whole command.
vd="$(fixture verify-docs)"
mkdir -p "$vd/openspec" "$vd/docs" "$vd/deep/nested"
out="$(cd "$vd/deep/nested" && node "$SERPENS_SDD" verify-docs 2>&1)"
if printf '%s' "$out" | grep -q 'index' \
  && printf '%s' "$out" | grep -q 'lint' \
  && printf '%s' "$out" | grep -q 'split-brain'; then pass; else fail "verify-docs: not all three checks named in output"; fi
printf 'malformed\n' > "$vd/openspec/broken.md"
out=$(cd "$vd" && node "$SERPENS_SDD" verify-docs 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then pass; else fail "verify-docs: a bad file did not fail the command"; fi

printf 'PASS=%d FAIL=%d SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
