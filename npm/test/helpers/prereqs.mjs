import { execFileSync } from 'node:child_process';
import { findRealOpenspec } from './real-openspec.mjs';

// One place that decides, for real, whether an optional external dependency is present —
// PyYAML (python3's `yaml` module), the real `@fission-ai/openspec` CLI, and the real
// `lefthook` binary. Tests that need one of these call the matching `require*(t)` guard as
// their FIRST statement; when the dependency is missing it either skips the test with a clear,
// actionable reason (default) or fails it (CI / SERPENS_REQUIRE_ALL_PREREQS=1 — see
// `enforceMode()` below), so the gate never silently weakens in CI.
//
// Detection is real, not a PATH guess: each check actually runs the tool (`python3 -c "import
// yaml"`, `openspec --version`, `lefthook version`) with a short timeout, once per process
// (memoized below).

const TIMEOUT_MS = 5000;

function detectPyyaml() {
  try {
    execFileSync('python3', ['-c', 'import yaml'], { timeout: TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true, reason: null };
  } catch (err) {
    return {
      ok: false,
      reason: 'PyYAML not installed — install python3\'s yaml module '
        + '(e.g. `nix-shell -p python3Packages.pyyaml`, or `pip install pyyaml`) to run this test',
    };
  }
}

function detectOpenspec() {
  try {
    const found = findRealOpenspec();
    if (found) return { ok: true, reason: null };
    return {
      ok: false,
      reason: 'real @fission-ai/openspec CLI not found on PATH or in the npx cache — run '
        + '`npx -y @fission-ai/openspec@1.13 --version` (or install a supported minor) to run this test',
    };
  } catch {
    return {
      ok: false,
      reason: 'real @fission-ai/openspec CLI not found — run '
        + '`npx -y @fission-ai/openspec@1.13 --version` to seed the npx cache, then re-run',
    };
  }
}

function detectLefthook() {
  try {
    execFileSync('lefthook', ['version'], { timeout: TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true, reason: null };
  } catch {
    return {
      ok: false,
      reason: 'real lefthook binary not on PATH — install one (e.g. `brew install lefthook` on '
        + 'macOS, or the fleet package manager on contabo/NixOS) to run this test',
    };
  }
}

let _pyyaml;
let _openspec;
let _lefthook;

export function pyyaml() { return _pyyaml ??= detectPyyaml(); }
export function openspecCli() { return _openspec ??= detectOpenspec(); }
export function lefthook() { return _lefthook ??= detectLefthook(); }

/** CI=true or SERPENS_REQUIRE_ALL_PREREQS=1: a missing dependency must FAIL the test, not skip
 * it — otherwise the gate silently weakens whenever the environment is short a tool. */
export function enforceMode() {
  return process.env.CI === 'true' || process.env.SERPENS_REQUIRE_ALL_PREREQS === '1';
}

/**
 * Guard a test on one prerequisite check `{ok, reason}`. Call as the first statement of a test
 * body with the test's own `t` (TestContext): `if (guard(t, pyyaml())) return;`
 * Skips (printing `reason`) unless `enforceMode()`, in which case it throws — failing the test
 * with the same actionable reason instead of a bare crash.
 * @returns {boolean} true when the caller must return immediately (skipped or about to throw).
 */
function guard(t, check) {
  if (check.ok) return false;
  if (enforceMode()) {
    throw new Error(`${check.reason} (CI/SERPENS_REQUIRE_ALL_PREREQS=1: missing prereqs fail, never skip)`);
  }
  t.skip(check.reason);
  return true;
}

export function requirePyyaml(t) { return guard(t, pyyaml()); }
export function requireOpenspec(t) { return guard(t, openspecCli()); }
export function requireLefthook(t) { return guard(t, lefthook()); }
