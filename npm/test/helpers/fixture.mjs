import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Create a bare git repository (a stand-in remote) with one commit on `base`,
 * entirely on local disk — no network involved.
 * @param {string} name - a label, used only in the tmp dir prefix
 * @param {{base?: string}} [opts]
 * @returns {{remotePath: string, base: string, headCommit: string}}
 */
export function makeBareRemote(name, { base = 'develop' } = {}) {
  const base_ = base;
  const bareDir = mkdtempSync(join(tmpdir(), `serpens-sdd-remote-${name}-`));
  execFileSync('git', ['init', '--bare', '-b', base_, bareDir], { stdio: 'ignore' });

  // Populate it via a throwaway working clone, then discard the clone.
  const workDir = mkdtempSync(join(tmpdir(), `serpens-sdd-remote-work-${name}-`));
  execFileSync('git', ['clone', bareDir, workDir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: workDir });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: workDir });
  writeFileSync(join(workDir, 'README.md'), `# ${name} store\n`);
  // An established store already carries an openspec/ root from its own earlier setup —
  // repository-state.sh's assert modes refuse to run against a repo that isn't its own
  // OpenSpec root, so a realistic clone/local fixture must ship one too.
  mkdirSync(join(workDir, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(workDir, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(workDir, 'openspec', 'specs', '.gitkeep'), '');
  writeFileSync(join(workDir, 'openspec', 'changes', '.gitkeep'), '');
  execFileSync('git', ['add', '-A'], { cwd: workDir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: workDir });
  execFileSync('git', ['push', 'origin', base_], { cwd: workDir });
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8' }).trim();

  return { remotePath: bareDir, base: base_, headCommit };
}

/**
 * Build a local store git repository that already exists on this machine, with an
 * optional set of submodule rows recorded in .gitmodules (offline: submodule remotes
 * are themselves local bare repos, never fetched).
 * @param {Array<{name: string, url?: string, base_branch?: string}>} [rows]
 * @param {{base?: string}} [opts]
 * @returns {{storeRoot: string, base: string}}
 */
export function makeStoreWithSubmodules(rows = [], { base = 'develop' } = {}) {
  const storeRoot = mkdtempSync(join(tmpdir(), 'serpens-sdd-store-'));
  execFileSync('git', ['init', '-b', base, storeRoot], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: storeRoot });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: storeRoot });
  writeFileSync(join(storeRoot, 'README.md'), '# store\n');

  if (rows.length) {
    const lines = rows.map((r) => [
      `[submodule "submodules/${r.name}"]`,
      `\tpath = submodules/${r.name}`,
      `\turl = ${r.url ?? `ssh://git@forge/proj/${r.name}.git`}`,
      `\tbranch = ${r.base_branch ?? 'develop'}`,
    ].join('\n')).join('\n');
    writeFileSync(join(storeRoot, '.gitmodules'), lines + '\n');
  }

  execFileSync('git', ['add', '-A'], { cwd: storeRoot });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: storeRoot });

  return { storeRoot, base };
}

/**
 * Put a fake `openspec` on PATH at `<dir>/bin/openspec`. The behaviour lives in the real file
 * `test/helpers/fake-openspec-bin.mjs` (see its header for the contract it implements); this
 * only writes a two-line wrapper that points at it and at this fixture's own registry file, so
 * no part of the stub has to survive two layers of string escaping.
 *
 * This stub serves the BREADTH suite (every stage, end to end). The store-registration
 * acceptance tests run against the REAL binary — see test/helpers/real-openspec.mjs.
 * @param {string} dir - a directory to create `bin/` inside (a mkdtempSync directory)
 * @param {{version?: string, supportsStore?: boolean}} [opts] - `supportsStore: false` models an
 *   OpenSpec with no `store` subcommand at all (Commander's unknown-command error, no JSON).
 * @returns {{binDir: string, binPath: string, registryPath: string, pathPrepend(env: object): object}}
 */
export function fakeOpenspec(dir, { version = '1.2.3', supportsStore = true } = {}) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, 'openspec');
  const registryPath = join(binDir, 'openspec-registry.json');
  const confPath = join(binDir, 'openspec-fake-config.json');
  writeFileSync(registryPath, '{"stores":[]}\n', 'utf8');
  writeFileSync(confPath, JSON.stringify({ version, supportsStore, registryPath }), 'utf8');

  const body = fileURLToPath(new URL('./fake-openspec-bin.mjs', import.meta.url));
  writeFileSync(binPath, [
    '#!/usr/bin/env node',
    `process.env.FAKE_OPENSPEC_CONFIG = ${JSON.stringify(confPath)};`,
    `await import(${JSON.stringify(pathToFileURL(body).href)});`,
    '',
  ].join('\n'), 'utf8');
  chmodSync(binPath, 0o755);

  return {
    binDir,
    binPath,
    registryPath,
    /** Return a copy of env with binDir prepended to PATH, so `openspec` resolves to this stub. */
    pathPrepend(env = process.env) {
      return { ...env, PATH: `${binDir}:${env.PATH ?? ''}` };
    },
  };
}
