/**
 * Detect and classify the installed `@fission-ai/openspec` CLI version, replacing the old
 * single-version pin with a rolling support window of its three latest minor releases.
 */

// The three latest OpenSpec (`@fission-ai/openspec`) minor lines this package supports,
// newest first. TO BUMP: run `npm view @fission-ai/openspec versions --json`, take the highest
// patch of each of the three newest `major.minor` lines, prepend the new one here, and drop
// the oldest entry — always exactly three. Never remove the middle-of-window check anywhere
// this constant is consumed; a wider window is a deliberate, evidenced decision, not a default.
//
// Evidence (2026-09-11): `npm view @fission-ai/openspec versions --json` lists ...1.10.0,
// 1.11.0, 1.12.0, 1.13.0 as the tail of the published version list; `npm view
// @fission-ai/openspec version` reports 1.13.0 as `latest`. The three newest minors are
// therefore 1.13, 1.12, 1.11.
export const SUPPORTED_MINORS = ['1.13', '1.12', '1.11'];

/**
 * Parse an OpenSpec `--version` style output into its numeric parts. Tolerant of a bare
 * `1.12.0` line and of surrounding text (a banner, a trailing newline, extra words) as long as
 * an `X.Y.Z` triple appears somewhere in the text.
 * @param {string} text
 * @returns {{major: number, minor: number, patch: number, raw: string}|null}
 */
export function parseOpenspecVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: m[0] };
}

/**
 * Classify a detected OpenSpec version against the supported window.
 * @param {string} text - raw `--version` stdout
 * @returns {{ok: true, version: object, minorKey: string}
 *   | {ok: false, reason: 'unparseable', supported: string[]}
 *   | {ok: false, reason: 'unsupported', version: object, minorKey: string, supported: string[]}}
 */
export function classifyOpenspecVersion(text) {
  const version = parseOpenspecVersion(text);
  if (!version) {
    return { ok: false, reason: 'unparseable', supported: SUPPORTED_MINORS };
  }
  const minorKey = `${version.major}.${version.minor}`;
  if (!SUPPORTED_MINORS.includes(minorKey)) {
    return { ok: false, reason: 'unsupported', version, minorKey, supported: SUPPORTED_MINORS };
  }
  return { ok: true, version, minorKey };
}

/**
 * Behavioural capabilities that genuinely differ between the supported minors, keyed by
 * `minorKey` (e.g. '1.13'). Checked by actually RUNNING the real `@fission-ai/openspec@1.11.0`,
 * `@1.12.0` and `@1.13.0` CLIs (via `npx --yes`, real network installs, offline-irrelevant to
 * this package) against the exact surface serpens-sdd drives:
 *   - `--version`: bare `X.Y.Z\n` on all three (commander's own `.version()`, unchanged).
 *   - `init --tools none --force`: identical `openspec/specs`, `openspec/changes`,
 *     `openspec/config.yaml` scaffolding on all three.
 *   - `store register --id <id> <path>` and `store list`: byte-identical prompts, errors
 *     (including the kebab-case id rejection and the "turn this into a store?" interactive
 *     gate) and output on all three; `dist/commands/store.js` itself is also byte-identical
 *     across the three npm-packed tarballs.
 * `dist/core` and `dist/commands` do differ between these minors elsewhere (see git history
 * for the byte-diff), but nothing in that diff touches a path serpens-sdd calls. Found no
 * behavioural difference serpens-sdd depends on. This function intentionally returns an
 * empty, frozen object — add a boolean only when a real, evidenced difference is found in the
 * CLI's actual behaviour; never speculate one in.
 * @param {string} _minorKey
 * @returns {Readonly<Record<string, boolean>>}
 */
export function capabilitiesFor(_minorKey) {
  return Object.freeze({});
}
