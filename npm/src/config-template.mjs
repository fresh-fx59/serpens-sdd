import { SHIM_INVOCATION } from './shim.mjs';
import { SUPPORTED_MINORS } from './openspecversion.mjs';

/**
 * The template's default OpenSpec invocation, derived from the newest supported minor rather
 * than typed as its own literal. `SUPPORTED_MINORS[0]` is `'1.13'`-shaped (major.minor only);
 * a caret range on `${minor}.0` (`^1.13.0`) accepts every patch of that minor line and nothing
 * from 1.14 — the same boundary `classifyOpenspecVersion` enforces, so the template and the
 * validator can never silently drift apart the way a hand-typed `@latest` or `@1.10.3` did.
 * Confirmed npx actually accepts a caret range spec (2026-09-11): `npx --yes
 * @fission-ai/openspec@^1.13.0 --version` printed `1.13.0`.
 */
export const DEFAULT_OPENSPEC_INVOCATION = `npx @fission-ai/openspec@^${SUPPORTED_MINORS[0]}.0`;

/**
 * Return the config template as a JSON string — the single source of truth for what a fresh
 * config file looks like. `init --print-config-template` prints this verbatim; `--config
 * <path>` reads exactly this shape back in. `schema_version` is numeric here (never a string),
 * matching what `validateConfig` actually expects — a JSON string value would otherwise make
 * this template fail its own validator.
 * With `topology: 'repo-local'` (step 6, gap 3) it returns the single-repository shape instead:
 * `topology` + `repo:` and NO `store:`/`repositories:` keys — validateConfig forbids both there.
 * @param {string} lang - Language tag, e.g. 'en'
 * @param {{topology?: 'store'|'repo-local'}} [opts]
 * @returns {string}
 */
export function configTemplate(lang = 'en', { topology = 'store' } = {}) {
  if (topology === 'repo-local') {
    return `${JSON.stringify({
      schema_version: 1,
      topology: 'repo-local',
      project: 'my-project',
      lang,
      port: 'claude',
      port_scope: 'auto',
      openspec: { invocation: DEFAULT_OPENSPEC_INVOCATION },
      serpens_sdd: { invocation: SHIM_INVOCATION },
      repo: { root: '.', name: 'my-project', base_branch: 'main' },
      facts: { forge: 'anything', tracker: 'anything', repository_source: 'manual' },
    }, null, 2)}\n`;
  }
  const obj = {
    schema_version: 1,
    project: 'my-project',
    lang,
    port: 'gigacode',
    port_scope: 'auto',
    // `openspec.pinned_version` is deliberately absent: proveOpenspec (src/config.mjs) now
    // checks the DETECTED version against a rolling window of the three latest supported
    // minors (src/openspecversion.mjs) instead of one frozen release, so the template no
    // longer bakes an exact version into either field. The invocation below is a caret range
    // on `SUPPORTED_MINORS[0]`, not `@latest`: `@latest` would drift PAST the window the
    // moment upstream ships a new minor (a fresh install then fails stage 0 with no
    // configuration change by anyone), while the caret range can only ever resolve inside the
    // newest minor this build actually supports. A shop that needs an exact, audited version
    // still sets `pinned_version` explicitly; that path is honoured (and still enforced as an
    // exact match) when present.
    openspec: {
      invocation: DEFAULT_OPENSPEC_INVOCATION,
    },
    // How the installed commands, skills and hooks call THIS package. The default below is the
    // generated shim; change it only if this shop reaches serpens-sdd another way.
    serpens_sdd: {
      invocation: SHIM_INVOCATION,
    },
    store: {
      remote: 'ssh://git@forge/example/system-store.git',
      base_branch: 'main',
      id: 'my-project-store',
      root: '../system-store',
    },
    repositories: [
      { name: 'service-a', url: 'ssh://git@forge/example/service-a.git', base_branch: 'main' },
    ],
    facts: {
      forge: 'anything',
      tracker: 'anything',
      repository_source: 'manual',
    },
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}
