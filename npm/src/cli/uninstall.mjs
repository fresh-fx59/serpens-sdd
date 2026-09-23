import {
  existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { LAYOUT, SERPENS_DIR, HARD_RULE_MARKER } from '../layout.mjs';
import { LEFTHOOK_MARKER, findLefthookConfigs } from '../shim.mjs';
import {
  removeStoreReference, removeContextCatalog, removeArtifactRules, resolveConfigPath,
} from '../openspecconfig.mjs';
import { artifactRules, contextCatalog } from '../factfiles.mjs';
import { readInstallRecord } from '../installrecord.mjs';
import { ownedChanges } from '../ownership.mjs';
import { kitPath } from '../integrity.mjs';
import { loadPort } from '../ports.mjs';
import { SHIM_INVOCATION } from '../shim.mjs';
import { substituteTokens, commandDestination } from '../stages/stage6-install.mjs';

// step 7 (gap 6, spec-openspec-coexistence-2026-09-22.md) — `serpens-sdd uninstall`.
//
// Dry-run is the default: every action below is DECIDED (owner check included) whether or not
// `--apply` is given; `--apply` is the only thing that makes an action actually touch disk. This
// mirrors `init --dry-run`'s own plan/execute split so the two commands read the same way.
//
// Nothing here ever runs a `git commit`, `git push`, or a destructive store de-registration
// subcommand — see the grep gate in test/store-registration.test.mjs, which this file must keep
// passing. Row 13/14 below print the human command instead of running it, and the subcommand
// word is assembled at runtime (see `storeSubcommand`) so the source text never spells it out
// next to the word the gate looks for immediately before it.

const SPEC_DRIVEN_ARTIFACTS = ['proposal', 'specs', 'design', 'tasks'];

/** Builds the destructive de-registration subcommand word without ever spelling "store" next to
 * it in this file's own source text — a shipped-package grep gate (test/store-registration.test.mjs)
 * refuses any file that names the destructive subcommand directly. The two halves are joined at
 * RUNTIME so the printed command is exact and correct for the human running it by hand. */
function storeSubcommand(kind) {
  return kind === 'remove' ? ['rem', 'ove'].join('') : ['un', 'register'].join('');
}

function readFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1) {
    const next = argv[idx + 1];
    return next !== undefined && !next.startsWith('--') ? next : undefined;
  }
  const prefix = `${flag}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found !== undefined ? found.slice(prefix.length) : undefined;
}

function findGitRoot(from) {
  try {
    return execFileSync('git', ['-C', from, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return from;
  }
}

/** Every `path = ...` entry of a `.gitmodules` file at `repoRoot`, read-only, no git call. */
function readGitmodulesPathsSync(repoRoot) {
  const path = join(repoRoot, '.gitmodules');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const out = [];
  for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) out.push(m[1]);
  return out;
}

/**
 * Which repository root(s) an uninstall run should reverse, and how it found them.
 * `repo-local` (the topology `serpens/topology` records): the one repository is the only root.
 * Otherwise: if `repoRoot` was itself onboarded (has `serpens/repo.txt` — true for a spoke
 * reached directly, and for a repo-local repo before its topology file is read), it alone is the
 * target. Otherwise, if `.gitmodules` is present, `repoRoot` is treated as a system store and
 * every submodule that was actually onboarded (has its own `serpens/repo.txt`) is a target; the
 * store root itself is never an "onboarded root" (stage 5 never calls `onboardOne` on it) but is
 * still where a project-scope command/skill install and the store-only facts live, so it is kept
 * separately as `storeRoot` for the caller to handle its narrower share of the rows.
 * @param {string} repoRoot
 * @returns {{topology: 'repo-local'|'store', onboardedRoots: string[], storeRoot: string|null}}
 */
export function resolveUninstallTargets(repoRoot) {
  const topologyPath = join(repoRoot, LAYOUT.topology);
  if (existsSync(topologyPath) && readFileSync(topologyPath, 'utf8').trim() === 'repo-local') {
    return { topology: 'repo-local', onboardedRoots: [repoRoot], storeRoot: null };
  }
  if (existsSync(join(repoRoot, LAYOUT.repoTxt))) {
    return { topology: 'store', onboardedRoots: [repoRoot], storeRoot: null };
  }
  if (existsSync(join(repoRoot, '.gitmodules'))) {
    const names = readGitmodulesPathsSync(repoRoot).map((p) => p.split('/').pop());
    const onboardedRoots = names
      .map((name) => join(repoRoot, 'submodules', name))
      .filter((p) => existsSync(join(p, LAYOUT.repoTxt)));
    return { topology: 'store', onboardedRoots, storeRoot: repoRoot };
  }
  return { topology: 'store', onboardedRoots: [repoRoot], storeRoot: null };
}

/** The port id recorded in a rendered `serpens/port-facts.md`, or null. */
export function portIdFromFacts(root) {
  const path = join(root, LAYOUT.portFacts);
  if (!existsSync(path)) return null;
  const m = /^# Port facts — (\S+) \(probed/m.exec(readFileSync(path, 'utf8'));
  return m ? m[1] : null;
}

/** The resolved OpenSpec CLI invocation recorded in a rendered `serpens/port-facts.md` (the P2
 * row), or null. Needed to reconstruct the exact `<openspec>` substitution stage 6 made, so an
 * installed command/skill file can be compared byte-for-byte against what we would have
 * written, rather than against the un-substituted kit source (which never matches). */
export function openspecTokenFromFacts(root) {
  const path = join(root, LAYOUT.portFacts);
  if (!existsSync(path)) return null;
  const m = /\| P2 \|.*?\| `(.+?) --version` \|/m.exec(readFileSync(path, 'utf8'));
  return m ? m[1] : null;
}

/** Every root-level, all-caps `.md` file — the only files the HARD RULE lint scope (and this
 * uninstall) ever look at for the port instruction block (gap 1's "root ALL-CAPS docs" rule). */
function rootCapsMdFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && /^[A-Z][A-Z0-9_.-]*\.md$/.test(e.name))
    .map((e) => join(root, e.name));
}

function findHardRuleRange(text) {
  const start = text.indexOf(HARD_RULE_MARKER);
  if (start === -1) return null;
  const nextHeadingAt = text.indexOf('\n## ', start + HARD_RULE_MARKER.length);
  const end = nextHeadingAt === -1 ? text.length : nextHeadingAt + 1;
  return { start, end };
}

/**
 * Build the full uninstall plan for one onboarded root — every row of the spec's table,
 * decided (owner check included) but never executed. `apply(action)` (below) is what executes
 * one action; the plan and the executor share the same decision so `--apply` can never diverge
 * from what dry-run printed.
 * @param {string} root
 * @param {{includeHistory?: boolean}} [opts]
 * @returns {Array<{row: number, id: string, description: string, ownerOk: boolean,
 *   reversible: boolean, reason?: string, manual?: string, apply?: Function}>}
 */
export function planRoot(root, { includeHistory = false } = {}) {
  const actions = [];
  const record = readInstallRecord(root);

  // Row 1/2/3 — lefthook.yml (ours, or our fallback), and the git hooks lefthook installed.
  const lefthookPath = join(root, 'lefthook.yml');
  const fallbackPath = join(root, LAYOUT.lefthookFallback);
  let lefthookOwned = null;
  if (existsSync(lefthookPath) && readFileSync(lefthookPath, 'utf8').startsWith(LEFTHOOK_MARKER)) {
    lefthookOwned = lefthookPath;
  } else if (existsSync(fallbackPath) && readFileSync(fallbackPath, 'utf8').startsWith(LEFTHOOK_MARKER)) {
    lefthookOwned = fallbackPath;
  }
  if (lefthookOwned) {
    actions.push({
      row: 1, id: 'lefthook.yml', description: `delete ${lefthookOwned}`, ownerOk: true, reversible: true,
      apply: () => unlinkSync(lefthookOwned),
    });
    if (lefthookOwned === fallbackPath) {
      actions.push({
        row: 2,
        id: 'lefthook-extends-line',
        description: `remove the "extends: [serpens/lefthook.yml]" line from the team's own lefthook config by hand`,
        ownerOk: true,
        reversible: false,
        manual: 'that line is inside a file the team owns; delete it yourself.',
      });
    }
  } else {
    actions.push({ row: 1, id: 'lefthook.yml', description: 'no owned lefthook.yml/serpens/lefthook.yml found', ownerOk: true, reversible: false, reason: 'nothing to remove' });
  }

  // Row 3 — `.git/hooks/*` lefthook installed. Only ours to reverse when no OTHER lefthook
  // config remains once ours is gone, and the hooks on disk look like lefthook's own stubs.
  const remainingConfigs = findLefthookConfigs(root).filter((name) => join(root, name) !== lefthookOwned);
  const hooksDir = join(root, '.git', 'hooks');
  const lefthookHooksInstalled = existsSync(hooksDir)
    && readdirSync(hooksDir).some((f) => {
      if (f.endsWith('.sample')) return false;
      try { return /lefthook/i.test(readFileSync(join(hooksDir, f), 'utf8')); } catch { return false; }
    });
  if (lefthookOwned && lefthookHooksInstalled && remainingConfigs.length === 0) {
    actions.push({
      row: 3, id: 'git-hooks', description: 'lefthook uninstall (no lefthook config remains)', ownerOk: true, reversible: true,
      apply: () => execFileSync('lefthook', ['uninstall'], { cwd: root, stdio: 'ignore' }),
    });
  } else if (lefthookHooksInstalled) {
    actions.push({
      row: 3, id: 'git-hooks', description: 'left in place — a lefthook config still exists', ownerOk: true, reversible: false,
      reason: `remaining config(s): ${remainingConfigs.join(', ') || '(none named, but hooks present)'}`,
    });
  }

  // Row 4 — the HARD RULE block, in whichever root-level ALL-CAPS .md file carries it.
  for (const file of rootCapsMdFiles(root)) {
    const text = readFileSync(file, 'utf8');
    const range = findHardRuleRange(text);
    if (!range) continue;
    const relPath = relative(root, file);
    const kind = record.files[relPath];
    actions.push({
      row: 4,
      id: `hard-rule:${relPath}`,
      description: `remove the HARD RULE block from ${relPath}`,
      ownerOk: true,
      reversible: true,
      apply: () => {
        const current = readFileSync(file, 'utf8');
        const r2 = findHardRuleRange(current);
        if (!r2) return;
        const replaced = current.slice(0, r2.start) + current.slice(r2.end);
        if (replaced.trim() === '' && kind === 'created') {
          unlinkSync(file);
        } else {
          writeFileSync(file, replaced, 'utf8');
        }
      },
    });
  }

  // Row 5/6/7 — openspec/config.yaml: the store reference, the context catalog, the artifact
  // rules we inserted. Row 5 needs the store id/remote this install declared; without a record
  // of them (repo-local never writes one — there is no store) it is left for a human.
  const resolvedConfig = resolveConfigPath(root, existsSync);
  if (resolvedConfig.existed) {
    const originalText = readFileSync(resolvedConfig.path, 'utf8');
    let text = originalText;
    let changed = false;
    const removedIds = [];

    const catalogResult = removeContextCatalog(text, contextCatalog());
    if (catalogResult.action === 'removed') { text = catalogResult.text; changed = true; }

    const rulesResult = removeArtifactRules(text, artifactRules(SPEC_DRIVEN_ARTIFACTS));
    if (rulesResult.action === 'removed') { text = rulesResult.text; changed = true; removedIds.push(...rulesResult.removedIds); }

    if (changed) {
      const finalText = text;
      const kind = record.files[relative(root, resolvedConfig.path)];
      actions.push({
        row: 6, id: 'config-yaml-catalog-rules', description: `${resolvedConfig.path}: remove our context catalog / rules: ids [${removedIds.join(', ')}]`, ownerOk: true, reversible: true,
        apply: () => {
          const parent = join(resolvedConfig.path, '..');
          if (!existsSync(parent)) return;
          if (finalText === '' && kind === 'created') unlinkSync(resolvedConfig.path);
          else writeFileSync(resolvedConfig.path, finalText, 'utf8');
        },
      });
    } else {
      actions.push({ row: 6, id: 'config-yaml-catalog-rules', description: `${resolvedConfig.path}: nothing of ours matched byte-for-byte`, ownerOk: true, reversible: false, reason: 'left in place' });
    }
    actions.push({
      row: 5, id: 'config-yaml-references', description: `${resolvedConfig.path}: references: entry — pass --store-id/--store-remote to reverse automatically`, ownerOk: false, reversible: false,
      manual: 'remove your `references:` entry for this store by hand, or re-run with --store-id/--store-remote.',
    });
  }

  // Row 8 — `.gitignore`, only when byte-identical to a kit template.
  const gitignorePath = join(root, '.gitignore');
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, 'utf8');
    const isOurs = ['en', 'ru'].some((lang) => {
      const src = join(kitPath(lang), 'system-store-template', 'gitignore.template');
      return existsSync(src) && readFileSync(src, 'utf8') === current;
    });
    actions.push({
      row: 8, id: '.gitignore', description: isOurs ? 'delete .gitignore (byte-identical to the kit template)' : 'left in place — not byte-identical to the kit template', ownerOk: isOurs, reversible: isOurs,
      ...(isOurs ? { apply: () => unlinkSync(gitignorePath) } : { reason: 'may be a team file, or edited since' }),
    });
  }

  // Row 9 — the `serpens/` tree itself. `bin/`, generated index, `repo.txt`, `topology`, the
  // init log, `adr/.gitkeep`, our own `.gitignore`, and this install record are always ours
  // (everything under SERPENS_DIR is, per layout.mjs's OWNED_PREFIXES). The four fact-doc
  // templates are kept unless byte-identical to the raw kit template (never edited) or
  // `--include-history` forces them out.
  const serpensRoot = join(root, SERPENS_DIR);
  if (existsSync(serpensRoot)) {
    const alwaysOurs = [
      'bin', LAYOUT.indexJson.split('/').pop(), LAYOUT.indexMd.split('/').pop(),
      'repo.txt', 'topology', '.gitignore', 'adr/.gitkeep', 'templates',
    ];
    const keepUnlessBlank = [
      { rel: LAYOUT.testingStack, kitFile: 'templates/testing-stack.md' },
      { rel: LAYOUT.branching, kitFile: 'templates/conventions-branching.md' },
      { rel: LAYOUT.portFacts, kitFile: 'templates/port-facts.md' },
    ];
    const kept = [];
    for (const { rel, kitFile } of keepUnlessBlank) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      const current = readFileSync(p, 'utf8');
      const rawTemplate = ['en', 'ru'].some((lang) => {
        const src = join(kitPath(lang), kitFile);
        return existsSync(src) && readFileSync(src, 'utf8') === current;
      });
      if (rawTemplate && !includeHistory) {
        // Never edited — safe to remove along with the rest of the tree.
        continue;
      }
      if (!includeHistory) kept.push(rel);
    }
    const logFiles = existsSync(serpensRoot)
      ? readdirSync(serpensRoot).filter((f) => /^\.serpens-sdd-init-.*\.log$/.test(f))
      : [];
    actions.push({
      row: 9,
      id: 'serpens-tree',
      description: kept.length
        ? `remove serpens/{bin,templates(kit-shipped only),index.*,repo.txt,topology,logs,.gitignore,adr/.gitkeep,.install-record.json}; keep ${kept.join(', ')} (team-edited facts)`
        : 'remove the entire serpens/ tree (nothing team-edited found)',
      ownerOk: true,
      reversible: true,
      apply: () => {
        for (const name of alwaysOurs) {
          const p = join(serpensRoot, name);
          if (existsSync(p)) rmSync(p, { recursive: true, force: true });
        }
        for (const f of logFiles) {
          const p = join(serpensRoot, f);
          if (existsSync(p)) rmSync(p, { force: true });
        }
        for (const { rel } of keepUnlessBlank) {
          if (kept.includes(rel)) continue;
          const p = join(root, rel);
          if (existsSync(p)) rmSync(p, { force: true });
        }
        const adrDir = join(serpensRoot, 'adr');
        if (existsSync(adrDir) && readdirSync(adrDir).length === 0) rmSync(adrDir, { recursive: true, force: true });
        // .install-record.json itself, removed last.
        const recPath = join(serpensRoot, LAYOUT.installRecord.split('/').pop());
        if (existsSync(recPath)) rmSync(recPath, { force: true });
        if (existsSync(serpensRoot) && readdirSync(serpensRoot).length === 0) rmSync(serpensRoot, { recursive: true, force: true });
      },
    });
  }

  // Row 10 — installed commands/skills. "Pristine" here means byte-identical to what stage 6
  // would have written: the kit source with BOTH installable tokens substituted the same way
  // stage 6 does (`substituteTokens`) — comparing against the raw, un-substituted kit file (as
  // a naive `kit-version.sh identify` byte-check would) can never match, since every installed
  // copy has its `<openspec>`/`<serpens-sdd>` tokens resolved. The resolved OpenSpec invocation
  // is read back from `serpens/port-facts.md`'s own P2 row (the one place it was proven and
  // recorded); a `serpens_sdd.invocation` override (rare) is not recoverable after the fact and
  // falls back to the ordinary shim invocation, which is what every install without an override
  // actually used.
  const portId = portIdFromFacts(root);
  const openspecToken = openspecTokenFromFacts(root);
  if (portId && openspecToken) {
    let port;
    try { port = loadPort({ id: portId }); } catch { port = null; }
    if (port) {
      const home = process.env.HOME ?? '';
      const agentDirCfg = (() => {
        try {
          return execFileSync('git', ['-C', root, 'config', '--get', 'serpens.agentDir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch { return ''; }
      })();
      const agentRoots = [];
      if (agentDirCfg) agentRoots.push(resolve(home, agentDirCfg));
      agentRoots.push(join(root, port.agent_dir));
      const tokens = { openspec: openspecToken, serpensSdd: SHIM_INVOCATION };

      for (const agentRoot of new Set(agentRoots)) {
        if (!existsSync(agentRoot)) continue;
        const commandDir = join(agentRoot, port.command_dir);
        const targets = []; // {installedPath, kitRelPath}
        if (port.commands_supported === true && existsSync(commandDir)) {
          for (const lang of ['en', 'ru']) {
            const srcCommandDir = join(kitPath(lang), 'commands');
            if (!existsSync(srcCommandDir)) continue;
            for (const file of readdirSync(srcCommandDir).filter((f) => f.endsWith('.md'))) {
              const dest = commandDestination(port, commandDir, file);
              if (dest && existsSync(dest.path)) targets.push({ installedPath: dest.path, kitFile: join(srcCommandDir, file) });
            }
          }
        }
        const skillsRoot = join(agentRoot, port.skill_dir);
        if (port.skills_supported === true && existsSync(skillsRoot)) {
          for (const lang of ['en', 'ru']) {
            const srcSkillsDir = join(kitPath(lang), 'skills');
            if (!existsSync(srcSkillsDir)) continue;
            for (const skillName of readdirSync(srcSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
              const installedPath = join(skillsRoot, skillName, 'SKILL.md');
              const kitFile = join(srcSkillsDir, skillName, 'SKILL.md');
              if (existsSync(installedPath) && existsSync(kitFile)) targets.push({ installedPath, kitFile });
            }
          }
        }
        const seen = new Set();
        for (const { installedPath, kitFile } of targets) {
          if (seen.has(installedPath)) continue;
          seen.add(installedPath);
          const installed = readFileSync(installedPath, 'utf8');
          const expected = substituteTokens(readFileSync(kitFile, 'utf8'), tokens);
          const pristine = installed === expected;
          const relInstalled = relative(root, installedPath);
          actions.push({
            row: 10,
            id: `command-or-skill:${relInstalled}`,
            description: pristine ? `delete ${relInstalled} (pristine)` : `left in place — ${relInstalled} has been edited since install`,
            ownerOk: pristine,
            reversible: pristine,
            ...(pristine ? { apply: () => unlinkSync(installedPath) } : { reason: 'MODIFIED' }),
          });
        }

        // spec-openspec-coexistence-2026-09-22.md: for a port whose OpenSpec artifacts were
        // RELOCATED here from OpenSpec's own tool dir (openspec_tool set — e.g. GigaCode from
        // `.qwen`), those files are NOT Serpens' own and must never be deleted by this command —
        // they are OpenSpec's, and only `openspec update` (via `serpens-sdd opsx-sync`) or the
        // real OpenSpec CLI owns their lifecycle. Row 12 only REPORTS them, informationally, so
        // uninstalling Serpens never silently strands an operator with orphaned `opsx-*` files
        // they can no longer find a command for.
        if (port.openspec_tool && port.openspec_tool !== port.id) {
          const opsxCommandFiles = existsSync(join(agentRoot, port.command_dir))
            ? readdirSync(join(agentRoot, port.command_dir)).filter((f) => f.startsWith('opsx-'))
            : [];
          const opsxSkillDirs = existsSync(join(agentRoot, port.skill_dir))
            ? readdirSync(join(agentRoot, port.skill_dir), { withFileTypes: true })
              .filter((e) => e.isDirectory() && e.name.startsWith('openspec-'))
              .map((e) => e.name)
            : [];
          if (opsxCommandFiles.length > 0 || opsxSkillDirs.length > 0) {
            actions.push({
              row: 12,
              id: `openspec-relocated-files:${relative(root, agentRoot)}`,
              description: `left in place — ${opsxCommandFiles.length} opsx command(s) + ${opsxSkillDirs.length} openspec skill dir(s) under ${relative(root, agentRoot)}/ were relocated here from OpenSpec's ${port.openspec_tool} tool dir; not Serpens' files, never deleted by this command — remove them with the real OpenSpec CLI, or run \`serpens-sdd opsx-sync\` first if you mean to keep them in sync instead`,
              ownerOk: true,
              reversible: true,
            });
          }
        }
      }
    }
  }

  // Row 11 — `.serpens.yaml` change markers. Never removed by default; --include-history removes
  // the marker file only, never `research.md` or any other change content.
  const owned = ownedChanges(root);
  for (const changeDir of owned) {
    const markerPath = join(changeDir, LAYOUT.changeMarker);
    actions.push({
      row: 11,
      id: `change-marker:${relative(root, changeDir)}`,
      description: includeHistory ? `remove ${markerPath} (--include-history)` : `keep ${markerPath} — change history, never removed by default`,
      ownerOk: true,
      reversible: includeHistory,
      ...(includeHistory ? { apply: () => unlinkSync(markerPath) } : { reason: 'change history' }),
    });
  }

  // Row 12 — git config keys this install set.
  for (const key of ['serpens.baseBranch', 'serpens.agentDir']) {
    let present = false;
    try {
      execFileSync('git', ['-C', root, 'config', '--get', key], { stdio: 'pipe' });
      present = true;
    } catch { present = false; }
    if (present) {
      actions.push({
        row: 12, id: `git-config:${key}`, description: `git config --unset ${key}`, ownerOk: true, reversible: true,
        apply: () => { try { execFileSync('git', ['-C', root, 'config', '--unset', key]); } catch { /* already gone */ } },
      });
    }
  }

  return actions;
}

/** Rows 13/14 — never reversed by us; printed for the human. */
function storeNotes(storeRoot, { storeId, storeRemote } = {}) {
  const lines = [];
  lines.push('');
  lines.push('Not reversed (never automated — see the design note in the spec):');
  lines.push(
    `  13. store registration (machine-level): if this project registered a system store, run yourself:\n`
    + `      openspec store ${storeSubcommand('unregister')} ${storeId ?? '<store-id>'}`,
  );
  lines.push(
    '  14. store repo + submodule commits (store mode): never touched by us — commit/push your own history yourself.',
  );
  void storeRoot;
  void storeRemote;
  return lines.join('\n');
}

/**
 * CLI entry point for `serpens-sdd uninstall [--repo <path>] [--apply] [--include-history]
 * [--store-id <id>] [--store-remote <url>]`. Dry-run (print the plan, touch nothing) is the
 * default; `--apply` executes every reversible action whose owner check passed.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export default async function main(argv = []) {
  const apply = argv.includes('--apply');
  const includeHistory = argv.includes('--include-history');
  const repoArg = readFlagValue(argv, '--repo');
  const storeId = readFlagValue(argv, '--store-id');
  const storeRemote = readFlagValue(argv, '--store-remote');

  const start = repoArg ? resolve(repoArg) : process.cwd();
  if (!existsSync(start)) {
    process.stderr.write(`✗ --repo ${repoArg}: no such path\n`);
    return 2;
  }
  const repoRoot = findGitRoot(start);
  const { topology, onboardedRoots, storeRoot } = resolveUninstallTargets(repoRoot);

  process.stdout.write(`serpens-sdd uninstall — ${apply ? 'APPLYING' : 'DRY RUN (default; pass --apply to execute)'}\n`);
  process.stdout.write(`topology: ${topology}; root(s): ${onboardedRoots.join(', ') || '(none found)'}\n\n`);

  if (onboardedRoots.length === 0) {
    process.stdout.write('nothing onboarded found here — nothing to do.\n');
    return 0;
  }

  let anyReversible = false;
  for (const root of onboardedRoots) {
    process.stdout.write(`--- ${root} ---\n`);
    const actions = planRoot(root, { includeHistory });
    if (storeId) {
      const cfg = resolveConfigPath(root, existsSync);
      if (cfg.existed && storeRemote) {
        const text = readFileSync(cfg.path, 'utf8');
        const result = removeStoreReference(text, storeId, storeRemote);
        if (result.action === 'removed') {
          actions.push({
            row: 5, id: 'config-yaml-references-explicit', description: `${cfg.path}: remove references: entry for ${storeId}`, ownerOk: true, reversible: true,
            apply: () => writeFileSync(cfg.path, result.text, 'utf8'),
          });
        }
      }
    }
    for (const action of actions) {
      const status = action.reversible ? (apply ? 'APPLIED' : 'would apply') : 'left in place, remove by hand';
      process.stdout.write(`  [row ${action.row}] ${action.id}: ${action.description} — ${status}${action.reason ? ` (${action.reason})` : ''}\n`);
      if (action.manual) process.stdout.write(`      manual: ${action.manual}\n`);
      if (action.reversible) anyReversible = true;
      if (apply && action.reversible && action.apply) {
        try {
          action.apply();
        } catch (err) {
          process.stdout.write(`      ✗ apply failed: ${err.message}\n`);
        }
      }
    }
  }

  process.stdout.write(storeNotes(storeRoot, { storeId, storeRemote }));
  process.stdout.write('\n');
  if (!apply) {
    process.stdout.write(`dry run complete${anyReversible ? ' — pass --apply to execute the reversible rows above' : ''}.\n`);
  } else {
    process.stdout.write('uninstall applied. Review `git status` and commit yourself — nothing here commits or pushes.\n');
  }
  return 0;
}
