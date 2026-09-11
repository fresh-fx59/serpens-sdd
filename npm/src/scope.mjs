import { mkdirSync, existsSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toolPath } from './cli/tools.mjs';

// A real write probe, never a stat: write a marker file and delete it, catching any error
// (permissions, missing parent, read-only filesystem) as "not writable". A stat of the parent
// only proves the directory exists, not that this process can write into it.
// Returns { writable, created } — `created` is true iff this call is the one that made `dir`
// exist, so a caller that ends up NOT choosing this scope can undo exactly that side effect and
// never leave a directory behind under the operator's home for a scope that was not chosen.
function probeWritable(dir) {
  const preexisted = existsSync(dir);
  let created = false;
  try {
    mkdirSync(dir, { recursive: true });
    created = !preexisted;
  } catch {
    return { writable: false, created: false };
  }
  const probe = join(dir, '.serpens-sdd-write-probe');
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
    return { writable: true, created };
  } catch {
    return { writable: false, created };
  }
}

/**
 * Resolve which scope (user vs project) a port installs into, honoring an optional forced
 * scope from --port-scope. Walks port.scope_preference in order; `user` resolves
 * `$HOME/<agent_dir>` and is decided by a real write probe; `project` resolves
 * `<repoRoot>/<agent_dir>` unconditionally. A forced scope that is unavailable throws with
 * exitCode 3 rather than silently falling back — a CI run must never install somewhere other
 * than intended. Nothing real is left behind under the operator's home as a side effect of a
 * check: if probing `user` creates `$HOME/<agent_dir>` and `user` is not the scope ultimately
 * chosen, that directory is removed again; a directory that already existed is never touched.
 * @param {object} port - a loaded port (from loadPort)
 * @param {{home: string, repoRoot: string, force?: string}} opts
 * @returns {{scope: string, agentRoot: string, reason: string}}
 */
export function resolveScope(port, { home, repoRoot, force } = {}) {
  const candidates = force ? [force] : port.scope_preference;
  const skipped = [];
  let userProbeCreated = null; // agentRoot this call created under $HOME, if any

  const cleanupUserProbe = () => {
    if (userProbeCreated) {
      try { rmdirSync(userProbeCreated); } catch { /* not empty or already gone: leave it */ }
    }
  };

  for (const scope of candidates) {
    if (scope === 'user') {
      const agentRoot = join(home, port.agent_dir);
      const { writable, created } = probeWritable(agentRoot);
      if (created) userProbeCreated = agentRoot;
      if (writable) {
        // user scope wins: the directory we may have created is the chosen one, keep it.
        return { scope: 'user', agentRoot, reason: `user scope chosen: ${agentRoot} is writable` };
      }
      cleanupUserProbe();
      userProbeCreated = null;
      if (force) {
        const err = new Error(`--port-scope user forced, but ${agentRoot} is not writable`);
        err.exitCode = 3;
        throw err;
      }
      skipped.push(`user scope skipped: ${agentRoot} is not writable`);
      continue;
    }
    if (scope === 'project') {
      cleanupUserProbe();
      const agentRoot = join(repoRoot, port.agent_dir);
      const prefix = skipped.length ? `${skipped.join('; ')} — ` : '';
      return { scope: 'project', agentRoot, reason: `${prefix}project scope chosen: ${agentRoot}` };
    }
    cleanupUserProbe();
    const err = new Error(`unknown scope "${scope}" in scope_preference for port "${port.id}"`);
    err.exitCode = 2;
    throw err;
  }

  cleanupUserProbe();
  const err = new Error(`no scope in scope_preference for port "${port.id}" could be resolved`);
  err.exitCode = 3;
  throw err;
}

/**
 * Run the packaged serpens-lint.mjs against repoRoot for agentRoot's scope, and prove — by making
 * it fire, not by hoping the tree already has a violation —
 * that the lint actually read this scope rather than silently dropping it (serpens-lint.mjs:19-35
 * falls back to '' — and drops the agent-dir scope from SCOPES entirely — when it cannot
 * discover an agent home). Plants a deliberately over-cap probe file at
 * `<agentRoot>/skills/spns-sdd-scope-probe/SKILL.md` (a name that cannot collide with a real
 * port's skill), runs the lint, and requires it to FAIL naming that exact file — proof the scope
 * was walked for real, on a genuinely clean customer install and not only when the tree happens
 * to already contain a violation. The probe is always removed in a `finally`, and a pre-existing
 * `spns-sdd-scope-probe` directory is refused rather than clobbered.
 * The lint is run with `SERPENS_AGENT_DIR` REMOVED from the environment and `git config
 * serpens.agentDir` checked first, so what is proven is the git-config route the daily flow
 * actually depends on — an environment variable would take precedence and prove nothing.
 * @param {{repoRoot: string, agentRoot: string, run: Function, lang?: string}} opts
 * @returns {Promise<{ok: boolean, error?: string, agentDir?: string}>}
 */
export async function assertLintScope({ repoRoot, agentRoot, run, lang = 'en' }) {
  const agentDirName = relative(repoRoot, agentRoot);
  const probeSkillDir = join(agentRoot, 'skills', 'spns-sdd-scope-probe');
  if (existsSync(probeSkillDir)) {
    return {
      ok: false,
      error: `refusing to probe: ${probeSkillDir} already exists — remove it or choose a different agentRoot`,
    };
  }
  const probeFile = join(probeSkillDir, 'SKILL.md');
  const probeRel = relative(repoRoot, probeFile);

  const lintPath = toolPath('lint', lang);

  // The route that has to work is `git config serpens.agentDir`: that is the ONLY one the daily
  // flow has, since nothing sets SERPENS_AGENT_DIR in a lefthook hook or a CI job. So the config
  // value is checked first (a missing or wrong one fails here, rather than being papered over),
  // and the lint below is then run with SERPENS_AGENT_DIR deliberately REMOVED from the
  // environment — with the variable present it takes precedence in serpens-lint.mjs:20 and the
  // git-config route would never be exercised at all.
  const configured = await run('git', ['-C', repoRoot, 'config', '--get', 'serpens.agentDir'], { cwd: repoRoot });
  const configuredValue = (configured.stdout || '').trim();
  if (configured.code !== 0 || configuredValue === '') {
    return {
      ok: false,
      error: `git config serpens.agentDir is not set in ${repoRoot} — the lint has no way to find ${agentRoot} in the daily flow (SERPENS_AGENT_DIR is not set by hooks or CI)`,
    };
  }
  if (configuredValue !== agentDirName) {
    return {
      ok: false,
      error: `git config serpens.agentDir is "${configuredValue}" but this scope resolved to "${agentDirName}" — the lint would read a different directory than the install wrote`,
    };
  }

  const env = { ...process.env };
  delete env.SERPENS_AGENT_DIR;

  try {
    mkdirSync(probeSkillDir, { recursive: true });
    // serpens-lint caps skills/spns-*/*.md at 250 lines for our own skill docs; 260 trips it.
    writeFileSync(probeFile, Array.from({ length: 260 }, (_, i) => `line ${i}`).join('\n'), 'utf8');

    const result = await run('node', [lintPath, repoRoot], { cwd: repoRoot, env });
    const output = `${result.stdout}\n${result.stderr}`;

    if (result.code === 0 || !output.includes(probeRel)) {
      return {
        ok: false,
        error: `serpens-lint did not fail on the planted over-cap probe ${probeRel} — the agent-dir scope was not actually read through git config serpens.agentDir ("${configuredValue}"):\n${output}`,
      };
    }
    return { ok: true, agentDir: configuredValue };
  } finally {
    try { unlinkSync(probeFile); } catch { /* already gone */ }
    try { rmdirSync(probeSkillDir); } catch { /* not empty or already gone */ }
  }
}
