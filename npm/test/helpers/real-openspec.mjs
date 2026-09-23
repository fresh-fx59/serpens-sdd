import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_MINORS } from '../../src/openspecversion.mjs';

// Running the store-registration acceptance suite against a REAL `@fission-ai/openspec`, in a
// temp dir, with the registry pointed away from the developer's own.
//
// WHY NOT THE STUB. Every fact this feature depends on is a fact about OpenSpec's behaviour, not
// about ours: that a `--id` disagreeing with committed metadata THROWS rather than losing, that
// `--yes` is mandatory non-interactively, that a second checkout of the same id is refused, that
// an unregistered reference still yields an index entry. A stub asserts our beliefs about those.
// The real binary asserts the behaviour.
//
// WHY THE ISOLATION IS SAFE. `dist/core/global-config.js:44-51`: `getGlobalDataDir()` returns
// `XDG_DATA_HOME/openspec` whenever XDG_DATA_HOME is set, on EVERY platform, before any
// homedir fallback is consulted — and `dist/core/store/foundation.js:20` derives the store
// registry path from exactly that. So setting XDG_DATA_HOME into a mkdtemp dir moves the whole
// registry there. `assertRegistryIsolated()` below proves it per test rather than trusting it:
// it requires the registry OpenSpec actually reports writing to be inside the temp dir, and
// checks the developer's real registry is untouched.

/** Where OpenSpec would keep the registry for a given XDG_DATA_HOME. */
export function registryPathFor(xdgDataHome) {
  return join(xdgDataHome, 'openspec', 'stores', 'registry.yaml');
}

/** The developer's REAL registry — never read for content, only for "did we touch it?". */
export function realRegistryPath() {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && !xdg.startsWith(tmpdir()) && !xdg.startsWith('/private/tmp')
    ? join(xdg, 'openspec', 'stores', 'registry.yaml')
    : join(homedir(), '.local', 'share', 'openspec', 'stores', 'registry.yaml');
}

/** A byte-level fingerprint of the real registry: its content, or `null` when it does not exist. */
export function realRegistrySnapshot() {
  const p = realRegistryPath();
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function versionOf(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function inWindow(version) {
  return typeof version === 'string' && SUPPORTED_MINORS.some((m) => version.startsWith(`${m}.`));
}

/**
 * Find a real `@fission-ai/openspec` entry script on this machine.
 * Order: an explicit `SERPENS_TEST_OPENSPEC_BIN` override, then `openspec` on PATH, then every
 * `@fission-ai/openspec` in the npm `_npx` cache — highest in-window version wins.
 * @returns {{entry: string, version: string, viaPath?: boolean}|null}
 */
export function findRealOpenspec() {
  const override = process.env.SERPENS_TEST_OPENSPEC_BIN;
  if (override && existsSync(override)) {
    return { entry: override, version: 'override', viaPath: true };
  }
  try {
    const onPath = execFileSync('/bin/sh', ['-c', 'command -v openspec'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (onPath) {
      // Only accept it if it reports a version inside the window this package supports — a
      // stale `openspec` on PATH must not quietly become the thing the acceptance suite proves.
      const reported = execFileSync(onPath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
      const m = /(\d+\.\d+\.\d+)/.exec(reported);
      if (m && inWindow(m[1])) return { entry: onPath, version: m[1], viaPath: true };
    }
  } catch {
    // not on PATH, or it refused --version; fall through to the npx cache
  }
  const cache = join(homedir(), '.npm', '_npx');
  if (!existsSync(cache)) return null;
  const found = [];
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(cache, entry.name, 'node_modules', '@fission-ai', 'openspec');
    const bin = join(pkgDir, 'bin', 'openspec.js');
    const version = versionOf(pkgDir);
    if (existsSync(bin) && inWindow(version)) found.push({ entry: bin, version });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => (a.version < b.version ? 1 : -1));
  return found[0];
}

/**
 * A real `openspec` on PATH, with its registry inside a fresh temp dir.
 *
 * THROWS, never skips, when no real binary can be found: a suite that quietly turns itself off
 * is indistinguishable from a suite that passes, and this whole feature is a claim about the
 * real CLI's behaviour. The message says exactly how to supply one.
 * @returns {{binDir: string, xdgDataHome: string, registryPath: string, env: object,
 *   run(args: string[], opts?: object): {code: number, stdout: string, stderr: string},
 *   json(args: string[]): object}}
 */
export function realOpenspec() {
  const found = findRealOpenspec();
  if (!found) {
    throw new Error(
      'No real @fission-ai/openspec found. The store-registration suite runs against the real CLI '
      + 'on purpose (see test/helpers/real-openspec.mjs). Install one of '
      + `${SUPPORTED_MINORS.join(', ')} (e.g. \`npx -y @fission-ai/openspec@${SUPPORTED_MINORS[0]} --version\` to seed the npx cache), `
      + 'or point SERPENS_TEST_OPENSPEC_BIN at an openspec entry script.',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'serpens-sdd-real-openspec-'));
  const binDir = join(dir, 'bin');
  const xdgDataHome = join(dir, 'xdg-data');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(xdgDataHome, { recursive: true });

  const binPath = join(binDir, 'openspec');
  writeFileSync(binPath, found.viaPath
    ? `#!/bin/sh\nexec ${JSON.stringify(found.entry)} "$@"\n`
    : `#!/bin/sh\nexec node ${JSON.stringify(found.entry)} "$@"\n`, 'utf8');
  chmodSync(binPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    XDG_DATA_HOME: xdgDataHome,
    // Keep the CLI non-interactive and quiet about updates no matter what the developer's shell
    // looks like.
    CI: '1',
    NO_COLOR: '1',
  };

  function run(args, opts = {}) {
    try {
      const stdout = execFileSync(binPath, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return { code: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  return {
    dir,
    binDir,
    binPath,
    xdgDataHome,
    registryPath: registryPathFor(xdgDataHome),
    env,
    version: found.version,
    run,
    json(args, opts = {}) {
      const r = run(args, opts);
      return JSON.parse(r.stdout);
    },
  };
}

/**
 * Prove, from the CLI's own output, that this test's registry is the temp one — not the
 * developer's. Called by every test that mutates the registry.
 * @param {{registryPath: string}} oss
 * @param {object} registerPayload - the JSON `store register` printed
 * @param {import('node:assert')} assert
 */
export function assertRegistryIsolated(oss, registerPayload, assert) {
  const reported = registerPayload?.registry?.path;
  assert.equal(typeof reported, 'string', 'store register did not report a registry path');
  assert.equal(reported, oss.registryPath, 'OpenSpec wrote a registry somewhere other than the temp XDG_DATA_HOME');
  assert.ok(
    !reported.startsWith(join(homedir(), '.local')),
    `the test wrote into the developer's real data dir: ${reported}`,
  );
}
