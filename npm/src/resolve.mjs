import { SHIM_INVOCATION } from './shim.mjs';

/**
 * The declarative list of every `init` input.
 * Resolution order (first hit wins): flag -> config file -> environment -> interactive prompt -> error.
 * @type {Array<{key: string, flag: string, env: string, question: string, required: boolean, default?: string}>}
 */
export const INPUTS = [
  {
    // Step 6 (gap 3): `store` (default, the sibling-store install) or `repo-local` (one
    // repository, no store). Resolved FIRST: every input below tagged `topology:` is only
    // resolved — and only required — when it matches, so a repo-local run is never asked for
    // store.remote/root/base_branch and a store run is never asked for repo.*. Never prompted:
    // the interactive flow of a store install stays exactly as it was.
    key: 'topology',
    flag: '--topology',
    env: 'SERPENS_SDD_TOPOLOGY',
    question: 'Topology (store | repo-local)',
    required: false,
    default: 'store',
    prompt: false,
  },
  {
    key: 'project',
    flag: '--project',
    env: 'SERPENS_SDD_PROJECT',
    question: 'Project name (lower-case kebab-case)',
    required: true,
  },
  {
    key: 'lang',
    flag: '--lang',
    env: 'SERPENS_SDD_LANG',
    question: 'Interface language',
    required: false,
    default: 'en',
  },
  {
    key: 'port',
    flag: '--port',
    env: 'SERPENS_SDD_PORT',
    question: 'Port/harness name',
    required: false,
  },
  {
    key: 'port_scope',
    flag: '--port-scope',
    env: 'SERPENS_SDD_PORT_SCOPE',
    question: 'Port scope',
    required: false,
    default: 'auto',
  },
  {
    key: 'openspec.invocation',
    flag: '--openspec-invocation',
    // The spec's published one-liner (§3) writes `--openspec`; the longer name stays canonical
    // (it is the one `--help` prints), and the short one is accepted as an alias so the
    // documented command actually runs.
    aliases: ['--openspec'],
    env: 'SERPENS_SDD_OPENSPEC_INVOCATION',
    question: 'Openspec invocation command',
    required: true,
  },
  {
    // How every installed command, skill and hook calls this package. The default is the shim
    // stages 3 and 5 write at `<repo>/serpens/bin/serpens-sdd`, resolved through `git rev-parse` so it is
    // correct from any working directory and inside a user-scoped command file. Optional: a shop
    // that reaches the package another way (a global install, `node_modules/.bin`, a wrapper)
    // sets it explicitly. Never leave it empty — a bare `serpens-sdd` is not on PATH in a
    // devDependency or `npx` install.
    key: 'serpens_sdd.invocation',
    flag: '--serpens-sdd-invocation',
    aliases: ['--serpens-sdd'],
    env: 'SERPENS_SDD_INVOCATION',
    question: 'Serpens SDD invocation command',
    required: false,
    default: SHIM_INVOCATION,
  },
  {
    // Optional: when unset, proveOpenspec's only constraint is the detected version falling
    // inside SUPPORTED_MINORS (openspecversion.mjs) — a shop that needs an exact, audited
    // version still sets this explicitly, and an explicit value here is still enforced as an
    // exact match against what's detected.
    key: 'openspec.pinned_version',
    flag: '--openspec-pinned-version',
    env: 'SERPENS_SDD_OPENSPEC_PINNED_VERSION',
    question: 'Openspec pinned version (optional)',
    required: false,
  },
  {
    key: 'store.remote',
    topology: 'store',
    flag: '--store-remote',
    env: 'SERPENS_SDD_STORE_REMOTE',
    question: 'Store git remote URL',
    required: true,
  },
  {
    key: 'store.base_branch',
    topology: 'store',
    flag: '--store-base-branch',
    // Spec §3's one-liner writes `--store-base`; see the note on openspec.invocation.
    aliases: ['--store-base'],
    env: 'SERPENS_SDD_STORE_BASE_BRANCH',
    question: 'Store base branch',
    required: true,
  },
  {
    key: 'store.root',
    topology: 'store',
    flag: '--store-root',
    env: 'SERPENS_SDD_STORE_ROOT',
    question: 'Store checkout root (outside this checkout)',
    required: true,
  },
  {
    key: 'store.id',
    topology: 'store',
    flag: '--store-id',
    env: 'SERPENS_SDD_STORE_ID',
    question: 'Store id',
    required: false,
  },
  {
    key: 'repo.root',
    topology: 'repo-local',
    flag: '--repo-root',
    env: 'SERPENS_SDD_REPO_ROOT',
    question: 'Repository root (its own git top-level)',
    required: false,
    default: '.',
  },
  {
    key: 'repo.name',
    topology: 'repo-local',
    flag: '--repo-name',
    env: 'SERPENS_SDD_REPO_NAME',
    question: 'Repository name (lower-case kebab-case)',
    required: true,
  },
  {
    key: 'repo.base_branch',
    topology: 'repo-local',
    flag: '--repo-base-branch',
    env: 'SERPENS_SDD_REPO_BASE_BRANCH',
    question: 'Repository base branch',
    required: true,
  },
];

function getDotted(obj, key) {
  return key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

function setDotted(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== 'object' || cur[part] === null) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Read one flag's value, trying its canonical name first and then each accepted alias, so an
 * alias can never shadow an explicitly-given canonical value.
 * @param {string[]} argv
 * @param {{flag: string, aliases?: string[]}} input
 * @returns {string|undefined}
 */
function readFlagWithAliases(argv, input) {
  for (const name of [input.flag, ...(input.aliases ?? [])]) {
    const v = readFlag(argv, name);
    if (isProvided(v)) return v;
  }
  return undefined;
}

function readFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1) {
    const next = argv[idx + 1];
    // A `--flag` with nothing after it, or followed by another flag, has no
    // value: treated as not provided (falls through to the next source)
    // rather than silently swallowing the next flag as this one's value.
    if (next !== undefined && !next.startsWith('--')) {
      return next;
    }
    return undefined;
  }
  const prefix = `${flag}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  if (found !== undefined) {
    return found.slice(prefix.length);
  }
  return undefined;
}

function isProvided(v) {
  return v !== undefined && v !== '';
}

/**
 * Resolve every `init` input in order: flag -> config file -> environment -> interactive prompt -> error.
 * Returns a NESTED value object built from the dotted INPUTS keys, matching validateConfig's shape.
 *
 * Contract: an optional input that resolves from none of the four sources and has no
 * `default` is left out of BOTH `value` and `sources` entirely -- it is not set to
 * undefined, null, or any placeholder. Callers must not assume every `INPUTS` key is
 * present on either object; only look up what you need and treat absence as "unset".
 *
 * @param {{argv: string[], config: object, env: object, tty: boolean, nonInteractive: boolean, ask?: Function}} opts
 * @returns {Promise<{value: object, missing: string[], sources: object, exitCode?: number}>}
 */
export async function resolveInputs({ argv, config, env, tty, nonInteractive, ask }) {
  const value = {};
  const sources = {};
  const missing = [];
  const canPrompt = tty === true && nonInteractive !== true;

  for (const input of INPUTS) {
    // Topology-tagged inputs apply to one topology only (see the `topology` input above).
    if (input.topology && input.topology !== (value.topology ?? 'store')) continue;
    const flagValue = readFlagWithAliases(argv, input);
    if (isProvided(flagValue)) {
      setDotted(value, input.key, flagValue);
      sources[input.key] = 'flag';
      continue;
    }

    const configValue = getDotted(config, input.key);
    if (isProvided(configValue)) {
      setDotted(value, input.key, configValue);
      sources[input.key] = 'config';
      continue;
    }

    const envValue = env?.[input.env];
    if (isProvided(envValue)) {
      setDotted(value, input.key, envValue);
      sources[input.key] = 'env';
      continue;
    }

    if (canPrompt && input.prompt !== false && typeof ask === 'function') {
      const answer = await ask({ key: input.key, question: input.question, default: input.default });
      if (isProvided(answer)) {
        setDotted(value, input.key, answer);
        sources[input.key] = 'prompt';
        continue;
      }
    }

    if (input.default !== undefined) {
      setDotted(value, input.key, input.default);
      sources[input.key] = 'default';
      continue;
    }

    if (input.required) {
      missing.push(input.flag);
    }
  }

  if (missing.length > 0) {
    return { value, missing, sources, exitCode: 2 };
  }

  return { value, missing, sources };
}
