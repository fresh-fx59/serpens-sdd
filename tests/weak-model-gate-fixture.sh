#!/usr/bin/env bash
# weak-model-gate-fixture.sh — build the Task 12 weak-model acceptance-gate fixture.
#
# Produces, under a target directory (arg 1, or a fresh `mktemp -d` when omitted):
#   <target>/sample-service/          a throwaway git repo (openspec/ + docs/ trees, one commit)
#   <target>/sample-service/.claude/  the seven kit commands + six kit skills, BOTH substitution
#                                      tokens resolved, installed by the package's own stage6
#                                      installer (src/stages/stage6-install.mjs:installCommands)
#   <target>/sample-service/serpens/bin/serpens-sdd        wrapper shim: logs, then execs the real one
#   <target>/sample-service/serpens/bin/.serpens-sdd-real   the real generated shim (src/shim.mjs:writeShim)
#   <target>/sample-service/lefthook.yml     rendered by src/shim.mjs:renderLefthook
#   <target>/bin/openspec             a stub OpenSpec CLI (NOT the real thing — see below)
#   <target>/openspec-calls.log            every invocation the OpenSpec stub received
#   <target>/independent-invocations.log   every serpens-sdd invocation, logged by the wrapper —
#                                           NOT written by the model, unlike its own transcript
#   <target>/bin/serpens-sdd          on-PATH alias for the wrapper (bare invocations captured too)
#   <target>/bin/corp-sdd             DEAD NAME decoy: logs and exits 127
#   <target>/dead-name-invocations.log  any use of the pre-rename name — must stay EMPTY
#   <target>/TASK.md                  the task text handed to the model under test
#
# This script does NOT reimplement token substitution: it drives the package's own
# `installCommands` (which calls the package's own `substituteTokens`) and the package's own
# `writeShim` / `renderLefthook`. It never writes inside THIS repository's working tree — only
# under the target directory.
#
# Usage: weak-model-gate-fixture.sh [target-dir] [--lang en|ru]
#
# Idempotent: re-running against the same target directory rebuilds sample-service from scratch
# (removed and recreated) and re-runs the installer; writeShim refuses to clobber a non-shim file
# but happily overwrites its own prior output.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"           # content/enterprise-sdd-agents
# The package directory is RESOLVED, not spelled. This vault names it `serpens-sdd-npm`; the
# public repository names the same tree `npm/`. Both are tried, vault spelling first, and a
# checkout with neither fails loudly below naming both candidates — never silently skipping.
PKG_CANDIDATES=("$VAULT_ROOT/serpens-sdd-npm" "$VAULT_ROOT/npm")
PKG_DIR=""
for candidate in "${PKG_CANDIDATES[@]}"; do
  if [ -d "$candidate/src/stages" ]; then PKG_DIR="$candidate"; break; fi
done

LANG_CODE="en"
TARGET=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lang=*) LANG_CODE="${1#--lang=}" ;;
    --lang)
      [ "$#" -ge 2 ] || { echo "FATAL: --lang requires a language (en or ru)" >&2; exit 1; }
      LANG_CODE="$2"
      shift
      ;;
    *)
      if [ -z "$TARGET" ]; then
        TARGET="$1"
      fi
      ;;
  esac
  case "$LANG_CODE" in
    en|ru) ;;
    *) echo "FATAL: unknown language '$LANG_CODE'; expected en or ru" >&2; exit 1 ;;
  esac
  shift
done

# --- fail loud on missing prerequisites ------------------------------------------------------
command -v git >/dev/null 2>&1 || { echo "FATAL: git not found on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FATAL: node not found on PATH" >&2; exit 1; }
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "FATAL: node >= 18 required, found $(node -v)" >&2
  exit 1
fi
if [ -z "$PKG_DIR" ]; then
  echo "FATAL: the serpens-sdd package was not found; none of these paths has src/stages:" >&2
  for candidate in "${PKG_CANDIDATES[@]}"; do echo "  $candidate" >&2; done
  exit 1
fi
[ -d "$PKG_DIR/kits/$LANG_CODE" ] || { echo "FATAL: kit dir kits/$LANG_CODE not found" >&2; exit 1; }

if [ -z "$TARGET" ]; then
  TARGET="$(mktemp -d)"
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

# Never write inside this repository's own working tree.
case "$TARGET" in
  "$VAULT_ROOT"*|"$(cd "$VAULT_ROOT/.." && pwd)"*)
    echo "FATAL: target dir $TARGET is inside the corp working tree — refusing" >&2
    exit 1
    ;;
esac

echo "== fixture target: $TARGET =="

REPO="$TARGET/sample-service"
rm -rf "$REPO"
mkdir -p "$REPO"

# --- Step 1: throwaway target repo ------------------------------------------------------------
git -C "$REPO" init --quiet -b main
mkdir -p "$REPO/openspec/specs" "$REPO/openspec/changes" "$REPO/docs"
# serpens/index.{json,md} + repo.txt are generated below (Step 1b) by the real gen-index.mjs,
# not hand-written here — a hand-written index.md previously disagreed with what `index --check`
# (part of verify-docs) expects, so verify-docs always failed on a freshly built fixture.
cat > "$REPO/docs/README.md" <<'EOF'
# sample-service

A small internal HTTP service (fixture — nothing real). Exposes a `/profile`
endpoint used by the account team's dashboard.
EOF
touch "$REPO/openspec/specs/.gitkeep" "$REPO/openspec/changes/.gitkeep"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=fresh.fx59@gmail.com -c user.name='Aleksey Aksenov' \
  commit --quiet -m "chore: base sample-service repo"

# --- Step 1b: generate the real openspec index (via the package's own gen-index.mjs) ----------
node "$PKG_DIR/tools/gen-index.mjs" "$REPO"

# --- OpenSpec stub -----------------------------------------------------------------------------
mkdir -p "$TARGET/bin"
CALL_LOG="$TARGET/openspec-calls.log"
: > "$CALL_LOG"
cat > "$TARGET/bin/openspec" <<STUB
#!/usr/bin/env node
// STUB OpenSpec CLI — NOT the real OpenSpec. Built for Task 12's weak-model gate fixture.
// Logs every invocation to $CALL_LOG; recognized commands return plausible output and exit 0.
// Unrecognized subcommands report an error on stderr and exit 1.
// It does not validate, does not persist real state across calls beyond a trivial change-id
// list, and does not implement OpenSpec's real semantics. It exists only so a model driving the
// installed kit commands can proceed far enough to reveal what it reaches for.
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG = '$CALL_LOG';
const args = process.argv.slice(2);
appendFileSync(LOG, new Date().toISOString() + ' openspec ' + args.map((a) => JSON.stringify(a)).join(' ') + '\n');

const cwd = process.cwd();
const changesDir = join(cwd, 'openspec', 'changes');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

if (args[0] === 'new' && args[1] === 'change') {
  const id = args[2];
  mkdirSync(join(changesDir, id), { recursive: true });
  writeFileSync(join(changesDir, id, 'proposal.md'), '# Proposal (stub)\n');
  out({ ok: true, change: id, created: true });
} else if (args[0] === 'status') {
  out({ ok: true, artifacts: [] });
} else if (args[0] === 'instructions') {
  const artifact = args[1] ?? 'unknown';
  out({ ok: true, artifact, instructions: \`stub instructions for \${artifact}\`, done: false });
} else if (args[0] === 'validate') {
  out({ ok: true, valid: true, errors: [] });
} else if (args[0] === 'archive') {
  const id = args[1];
  out({ ok: true, archived: id ?? null });
} else if (args[0] === 'list') {
  out({ ok: true, items: [] });
} else if (args[0] === 'show') {
  out({ ok: true, item: null });
} else if (args[0] === 'store') {
  out({ ok: true, stores: [] });
} else if (args[0] === '--version') {
  process.stdout.write('stub-openspec 0.0.0-fixture\n');
} else {
  process.stderr.write('ERROR: unrecognized OpenSpec subcommand: ' + (args.join(' ') || '(none)') + '\n');
  process.exit(1);
}
process.exit(0);
STUB
chmod +x "$TARGET/bin/openspec"

# --- Step 2: install the seven commands + six skills, tokens resolved by the real installer ---
INSTALL_SCRIPT="$TARGET/.install-fixture.mjs"
cat > "$INSTALL_SCRIPT" <<NODE
import { installCommands } from '$PKG_DIR/src/stages/stage6-install.mjs';
import { loadPort } from '$PKG_DIR/src/ports.mjs';
import { run } from '$PKG_DIR/src/run.mjs';
import { kitPath } from '$PKG_DIR/src/integrity.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = loadPort({ id: 'claude', registryDir: '$PKG_DIR/ports' });
const ctx = {
  config: {
    openspec: { invocation: '$TARGET/bin/openspec' },
    // serpens_sdd.invocation is deliberately NOT set: the gate must exercise the installer's own
    // default (src/resolve.mjs + stage6-install.mjs), which is the shim at
    // "\$(git rev-parse --show-toplevel)"/serpens/bin/serpens-sdd. Runs 1 and 2 hand-set it here, before
    // that default existed — see the limitations section of weak-model-gate-2026-09-08.md.
    store: { id: 'sample-service' },
    facts: { repository_source: 'manual' },
  },
  run,
  kitDir: kitPath('$LANG_CODE'),
  port,
  storeRoot: '$REPO',
  home: mkdtempSync(join(tmpdir(), 'serpens-sdd-fixture-unused-home-')),
};

const result = await installCommands(ctx);
if (!result.ok) {
  console.error('installCommands FAILED:', result.error);
  process.exit(result.exitCode ?? 1);
}
console.log(result.evidence.join('\n'));
NODE
node "$INSTALL_SCRIPT"
rm -f "$INSTALL_SCRIPT"

# --- Step 3: the real generated shim ------------------------------------------------------------
SHIM_SCRIPT="$TARGET/.shim-fixture.mjs"
cat > "$SHIM_SCRIPT" <<NODE
import { writeShim, renderLefthook, resolveCallRoute } from '$PKG_DIR/src/shim.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const shimPath = writeShim('$REPO', { binPath: '$PKG_DIR/bin/serpens-sdd.mjs' });
console.log('shim written at', shimPath);

// Same invocation stage 5 uses, from the same source of truth — not a hand-typed string.
const lefthook = renderLefthook(resolveCallRoute({ repoRoot: '$REPO', hasNodeModules: false }).invocation, '$LANG_CODE');
writeFileSync(join('$REPO', 'lefthook.yml'), lefthook, 'utf8');
console.log('lefthook.yml written');
NODE
node "$SHIM_SCRIPT"
rm -f "$SHIM_SCRIPT"

# --- Step 3b: independent invocation capture (Task 12 fix round 2, Finding 5) ------------------
# The rubric's greps previously only ever read a log the MODEL wrote about itself (its own
# transcript) — a model can misreport, and did. Wrap the real generated shim with a logger the
# model does not write to and has no reason to look at: `serpens/bin/serpens-sdd` becomes the wrapper,
# the real writeShim() output moves to `serpens/bin/.serpens-sdd-real`, and every invocation (argv, cwd,
# exit code, timestamp) is appended mechanically to `<target>/independent-invocations.log` BEFORE
# control returns to whatever called the shim — so it captures ground truth regardless of what
# the model later claims. Kept alongside is the model-written transcript; the rubric now scores
# BOTH and flags any disagreement between them as a finding in its own right.
REAL_SHIM="$REPO/serpens/bin/.serpens-sdd-real"
mv "$REPO/serpens/bin/serpens-sdd" "$REAL_SHIM"
INDEP_LOG="$TARGET/independent-invocations.log"
: > "$INDEP_LOG"
cat > "$REPO/serpens/bin/serpens-sdd" <<WRAP
#!/bin/sh
# serpens-sdd shim wrapper -- logs every invocation independently of the model's own transcript.
# Written by weak-model-gate-fixture.sh; the real shim (writeShim's own output) is
# serpens/bin/.serpens-sdd-real, execed after the log line is appended.
LOG='$INDEP_LOG'
HERE="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
REAL="\$HERE/.serpens-sdd-real"
"\$REAL" "\$@"
RC=\$?
{
  printf '%s cwd=%s exit=%s argv=' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$(pwd)" "\$RC"
  for a in "\$@"; do printf '%s ' "'\$a'"; done
  printf '\n'
} >> "\$LOG"
exit \$RC
WRAP
chmod +x "$REPO/serpens/bin/serpens-sdd"

# --- Step 3b2: capture BOTH names (2026-09-09.1 rename, spec §7) -----------------------------
# The pre-rename gate wrapped a binary literally named `corp-sdd`, so its evidence says nothing
# about `serpens-sdd`. This edition wraps both, on PATH:
#   `serpens-sdd`  -> the same wrapper as serpens/bin/serpens-sdd, so a bare invocation is captured in
#                     independent-invocations.log exactly like a repo-relative one;
#   `corp-sdd`     -> a DEAD NAME decoy that logs to dead-name-invocations.log and exits 127.
# A non-empty dead-name log is an automatic FAIL: it means the prose (or the model's memory of
# it) still teaches a name this edition removed.
#
# The decoys live in <target>/bin, NOT in the repo tree, and this is deliberate. A
# `tools/corp-sdd` file inside the fixture repo would ADVERTISE the dead name to any model that
# lists tools/ — the gate would then be measuring its own trap instead of the shipped prose.
# Nothing in the repository names corp-sdd; only a model reaching for it from memory or from a
# stale line of prose can hit these.
DEAD_LOG="$TARGET/dead-name-invocations.log"
: > "$DEAD_LOG"
cat > "$TARGET/bin/serpens-sdd" <<PATHSHIM
#!/bin/sh
# on-PATH alias for the wrapped shim, so a bare \`serpens-sdd\` is captured too.
exec '$REPO/serpens/bin/serpens-sdd' "\$@"
PATHSHIM
chmod +x "$TARGET/bin/serpens-sdd"
cat > "$TARGET/bin/corp-sdd" <<DECOY
#!/bin/sh
# DEAD NAME decoy -- edition 2026-09-09.1 renamed this binary to serpens-sdd.
LOG='$DEAD_LOG'
{
  printf '%s cwd=%s argv=' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$(pwd)"
  for a in "\$@"; do printf '%s ' "'\$a'"; done
  printf '\n'
} >> "\$LOG"
echo "corp-sdd: command not found" >&2
exit 127
DECOY
chmod +x "$TARGET/bin/corp-sdd"

# --- Step 3c: fill port-facts.md's UNFILLED sections with plausible FIXTURE values -------------
# stage6's renderPortFacts() always emits all four sections as literal `UNFILLED — ...` markers
# (Tracker, Forge, MCP tool names, Testing tiers) — there is no operator interview in this
# fixture to fill them for real, and verify-docs' own UNFILLED gate correctly refuses to go
# green while any remain. Without this step, criterion 3 ("the disposer runs after every write
# and the run ends green") could never be satisfied by ANY model — a fixture defect, not a kit
# defect. Every value below is invented for this fixture and says so.
FILL_SCRIPT="$TARGET/.fill-port-facts.py"
cat > "$FILL_SCRIPT" <<'PYFILL'
import re
import sys

path = sys.argv[1]
text = open(path).read()

fills = {
    "Tracker": (
        "FIXTURE VALUE -- no real tracker. Assume Linear, team FIXTURE, reached manually "
        "(no MCP tool wired in this fixture)."
    ),
    "Forge": (
        "FIXTURE VALUE -- no real forge. Assume GitHub, this repository is "
        "fixture-org/sample-service, no real remote configured."
    ),
    "MCP tool names": (
        "FIXTURE VALUE -- no MCP configured in this fixture. If it were, repository bindings, "
        "tracker, wiki and code search would each name their own MCP tool here."
    ),
    "Testing tiers": (
        "FIXTURE VALUE -- FAST tier: npm test (unit, seconds). SLOW tier: none configured for "
        "this fixture service. spns-tdd and spns-debugging should treat FAST as the only tier "
        "available here."
    ),
}

for title, body in fills.items():
    pattern = re.compile(
        r"(^## " + re.escape(title) + r"\n)UNFILLED \u2014 [^\n]*(\n)",
        re.MULTILINE,
    )
    text, n = pattern.subn(lambda m: m.group(1) + body + m.group(2), text)
    if n != 1:
        raise SystemExit(f"expected exactly one UNFILLED section for {title!r}, patched {n}")

text = re.sub(
    r"^STATUS: PARTIAL \u2014 \d+ UNFILLED section(s)?\n",
    "STATUS: COMPLETE (fixture values -- see FIXTURE VALUE markers below)\n",
    text, count=1, flags=re.MULTILINE,
)

open(path, "w").write(text)
print("port-facts.md: filled 4 UNFILLED sections with fixture values")
PYFILL
python3 "$FILL_SCRIPT" "$REPO/serpens/port-facts.md"
rm -f "$FILL_SCRIPT"

# --- Step 3d: serpens/testing-stack.md + templates/, FILLED with fixture answers ------------------
# Edition 2026-09-10.1 moved every tester-facing fact (what a tester can send, produce, query and
# observe from outside) out of `spns-test-plan` and into `serpens/testing-stack.md`, and made both
# `spns-test-plan` and `spns-autotest` STOP and ask the team when that file is absent or its
# facts are incomplete. A fixture without it therefore hands the model a dead end on two of the
# seven commands, and verify-docs correctly refuses to go green in a repository the kit was
# onboarded into — the same "unsatisfiable before any model starts" fixture defect that step 3c
# already fixed once for port-facts.md.
#
# So this writes what a real repository has once the team has filled it in: the kit's own
# templates/ copy (which is what marks the repository onboarded, and what the commands cite by
# path), plus serpens/testing-stack.md with every section and all twelve Manual testing access
# slots answered. Every answer is INVENTED FOR THIS FIXTURE, says so in its own text, and is
# deliberately generic — naming a real broker or query language here would put a customer
# technology back into the repository through the fixture, the exact leak the publish gate
# exists to catch. The script asserts the result schema-validates, so a schema that grows
# without this step growing with it is a loud fixture failure, never a silent partial fill.
mkdir -p "$REPO/serpens/templates" "$REPO/serpens"
cp "$PKG_DIR/kits/$LANG_CODE/templates/testing-stack.md" "$REPO/serpens/templates/testing-stack.md"
TS_SCRIPT="$TARGET/.fill-testing-stack.mjs"
cat > "$TS_SCRIPT" <<'TSFILL'
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , pkgDir, templatePath, outPath] = process.argv;
const mod = await import(new URL('src/testingstack.mjs', pathToFileURL(`${pkgDir}/`)).href);
const { renderTestingStack, validateTestingStack, MANUAL_ACCESS_SLOTS } = mod;

const ANSWERS = {
  'estate-reference': 'none (invented for this fixture)',
  'request-client': "the stand's own call console; give every part as a labeled field (fixture value)",
  'request-idiom': "the resource being asked for, who is asking, and the fields being sent; permission comes from the stand's login page (fixture value)",
  'event-transport': 'none (invented for this fixture: this service has no asynchronous surface)',
  'event-produce-path': 'none',
  'event-addressing': 'none',
  'event-payload-format': 'none',
  'data-stores': 'the profile store, one record per user (fixture value)',
  'store-query-idiom': "the stand's read-only data browser, one record by user id (fixture value)",
  'store-seed-idiom': 'the admin API on the stand; direct writes are not sanctioned (fixture value)',
  'error-routing': 'the response body carries the error; there is no separate rejection sink (fixture value)',
  'observation-access': "the stand's log viewer, filtered by request id (fixture value)",
};

const template = readFileSync(templatePath, 'utf8');
let text = renderTestingStack(template)
  .replace(/^STATUS: PARTIAL — .*$/m, 'STATUS: DONE (every answer below is invented for this fixture)')
  .replace(/^UNFILLED — .*$/gm, 'Invented for this fixture: the fixture module, exercised by the fixture suite command.');

text = text.split('\n').map((line) => {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return line;
  const cells = t.slice(1, -1).split('|').map((c) => c.trim());
  const m = /^`([a-z0-9-]+)`$/.exec(cells[0]);
  if (m && ANSWERS[m[1]] !== undefined) {
    cells[cells.length - 1] = ANSWERS[m[1]];
    return `| ${cells.join(' | ')} |`;
  }
  if (cells.some((c) => c === '...' || c === '…')) {
    return `| ${cells.map((c) => (c === '...' || c === '…' ? 'the fixture module, `run the fixture suite`' : c)).join(' | ')} |`;
  }
  return line;
}).join('\n');

if (Object.keys(ANSWERS).length !== MANUAL_ACCESS_SLOTS.length) {
  console.error(`FATAL: this fixture answers ${Object.keys(ANSWERS).length} slots, the schema has ${MANUAL_ACCESS_SLOTS.length} — add the new ones here rather than shipping a partly filled fixture`);
  process.exit(1);
}
const { ok, problems } = validateTestingStack(text, { path: outPath });
if (!ok) {
  console.error('FATAL: the fixture wrote an incomplete serpens/testing-stack.md — the schema grew and this step did not:');
  console.error(problems.join('\n'));
  process.exit(1);
}
writeFileSync(outPath, text, 'utf8');
console.log(`serpens/testing-stack.md: every section and all ${MANUAL_ACCESS_SLOTS.length} Manual testing access slots answered with fixture values`);
TSFILL
node "$TS_SCRIPT" "$PKG_DIR" "$REPO/serpens/templates/testing-stack.md" "$REPO/serpens/testing-stack.md"
rm -f "$TS_SCRIPT"

# --- Step 3e: commit the scaffolding (Task 12 fix round 3) -------------------------------------
# verify-docs' own index check now requires the index to be TRACKED, not just present on disk
# (fix round 3 — it used to report green on a repository whose committed/staged state had no
# index at all). Everything written since the base commit (the .claude install, the index, the
# shim, lefthook.yml, port-facts.md) must be committed here, exactly as a real onboarding pass
# would be closed out by an operator/agent before handing the repository to anyone — otherwise
# the fixture itself hands the model a repository where verify-docs is false RED from files the
# model never touched, which is the same class of "unsatisfiable before any model starts" defect
# fix round 2 already found and fixed once for port-facts.md's UNFILLED sections.
git -C "$REPO" add -A
git -C "$REPO" -c user.email=fresh.fx59@gmail.com -c user.name='Aleksey Aksenov' \
  commit --quiet -m "chore: serpens-sdd scaffolding (kit install, index, shim, lefthook) — fixture"

# --- TASK.md -------------------------------------------------------------------------------
cat > "$TARGET/TASK.md" <<'EOF'
# Task

This repository ("sample-service") uses the Serpens SDD workflow. Its installed
commands and skills (under `.claude/`) are the process to follow for any
change here — treat them as the process, not this file.

## The change

The account dashboard team asked for one small addition: the existing user
profile endpoint should also return the user's preferred display language
(a short code like "en" or "ru"), so the dashboard can stop guessing it from
browser headers. Nothing else about the endpoint should change.

Ticket: SVC-142.

Carry this change through the workflow this repository already has installed,
start to finish.
EOF

# --- Step 3e: prove the shim resolves ----------------------------------------------------------
# Bare `serpens/bin/serpens-sdd version` (no arguments) has printed the installed edition since fix round
# 1 (commit 83ed4e1: defaultVersionArgv supplies `show --root <the package's own kit>` when
# called with no arguments). The explicit `show --root "$PKG_DIR/kits/$LANG_CODE"` below is
# belt-and-braces on top of that, not a workaround for a missing default: it cross-checks
# against the SPECIFIC per-language kit tree this fixture actually installed from ($LANG_CODE),
# rather than the CLI's own built-in 'en' default, which would silently agree even if this
# fixture had installed the ru kit.
echo "== verifying the shim =="
(cd "$REPO" && serpens/bin/serpens-sdd version show --root "$PKG_DIR/kits/$LANG_CODE")

echo "== fixture built =="
echo "repo:        $REPO"
echo "openspec stub: $TARGET/bin/openspec"
echo "call log:    $CALL_LOG"
echo "task:        $TARGET/TASK.md"
echo "indep log:   $INDEP_LOG"
echo "dead-name log: $DEAD_LOG   (must stay EMPTY -- any line here is an automatic FAIL)"
echo "PATH:        prepend $TARGET/bin when running a model against this fixture"
