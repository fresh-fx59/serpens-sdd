import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = 'serpens-sdd shim — generated; do not edit.';

/**
 * The one canonical way to call the generated shim: `<repo>/tools/serpens-sdd`, with the repository
 * root resolved at run time by git so the string is correct from any working directory and in a
 * user-scoped command file shared across repositories. This is the single source of truth for
 * BOTH substitution sites — the `<serpens-sdd>` token in every installed command and skill (stage 6)
 * and the `run:` lines of the generated `lefthook.yml` (stage 5) — so an install can never
 * disagree with itself about how it calls the package.
 */
export const SHIM_INVOCATION = '"$(git rev-parse --show-toplevel)"/tools/serpens-sdd';

/**
 * POSIX-sh single-quote a path so nothing inside it is ever expanded by the shell. The only
 * character that needs handling inside single quotes is `'` itself, closed and re-opened as
 * `'\''`.
 * @param {string} value
 * @returns {string}
 */
export function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Write the language-agnostic POSIX-sh shim at <repoRoot>/tools/serpens-sdd.
 * Never overwrites a file at that path that isn't a shim it generated.
 * Never creates repoRoot itself — only tools/ within an already-existing repoRoot.
 * @param {string} repoRoot
 * @param {{binPath: string}} opts - absolute path of bin/serpens-sdd.mjs
 * @returns {string} the shim path
 */
export function writeShim(repoRoot, { binPath }) {
  if (!existsSync(repoRoot)) {
    const err = new Error(`repoRoot does not exist: ${repoRoot}`);
    err.exitCode = 3;
    throw err;
  }

  const toolsDir = join(repoRoot, 'tools');
  const shimPath = join(toolsDir, 'serpens-sdd');

  if (existsSync(shimPath)) {
    const existing = readFileSync(shimPath, 'utf8');
    if (!existing.includes(MARKER)) {
      throw new Error(`refusing to overwrite ${shimPath}: not a serpens-sdd generated shim`);
    }
  }

  if (existsSync(toolsDir) && !statSync(toolsDir).isDirectory()) {
    throw new Error(`cannot create tools/ directory, a file already exists at ${toolsDir}`);
  }
  if (!existsSync(toolsDir)) mkdirSync(toolsDir);

  // Both paths are SINGLE-quoted and escaped: a `$`, a backtick or a `"` anywhere in the
  // installed path (or in the node executable's path) would otherwise be expanded by /bin/sh
  // and yield a broken hook in every repository that got this shim.
  const body = `#!/bin/sh
# ${MARKER} Routes to the installed package, no registry access.
exec ${shQuote(process.execPath)} ${shQuote(binPath)} "$@"
`;
  writeFileSync(shimPath, body, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}


/**
 * Decide which of the three call routes a repository should use.
 * The shim is the default for every repository, whatever language it is written in,
 * whenever a shim is available. Otherwise fall back to node_modules/.bin (only when the
 * repository already has a package.json), and last to npx --no-install, which fails fast
 * rather than installing mid-commit.
 * @param {{repoRoot: string, hasNodeModules: boolean, shimAvailable?: boolean}} opts
 * @returns {{route: string, invocation: string}}
 */
export function resolveCallRoute({ repoRoot, hasNodeModules, shimAvailable = true }) {
  void repoRoot;
  if (shimAvailable) {
    return { route: 'shim', invocation: SHIM_INVOCATION };
  }
  if (hasNodeModules) {
    return { route: 'node_modules', invocation: 'node_modules/.bin/serpens-sdd' };
  }
  return { route: 'npx', invocation: 'npx --no-install @fresh-fx59/serpens-sdd' };
}

const LEFTHOOK_COMMENTS = {
  en: {
    branchConvention: `    # The branch name is checked HERE as well as on push, and this is the copy that always runs.
    # lefthook skips any pre-push command when the push carries no files it can list — which is
    # exactly the push that publishes a brand-new branch, the first time the name matters. Verified
    # in lefthook's own build_command.go: \`SkipError{"no matching push files"}\`, with no YAML-level
    # override (only \`lefthook run pre-push --force\`). A commit always has staged files, so this
    # copy cannot be skipped, and a bad branch name is refused before the first commit lands on it.`,
    commitMsgArg: `      # {1} is the commit-message file lefthook passes through.`,
    prePushBackstop: `      # Backstop only — see the pre-commit note; this one is skipped on a new-branch push.`,
  },
  ru: {
    branchConvention: `    # Имя ветки проверяется ЗДЕСЬ и при push — и это копия, которая срабатывает всегда.
    # lefthook пропускает pre-push команду, если push не несёт файлов, которые он может
    # перечислить, — а это ровно тот push, который публикует совсем новую ветку, когда имя
    # впервые имеет значение. Проверено в build_command.go самого lefthook:
    # \`SkipError{"no matching push files"}\`, без переопределения на уровне YAML (только
    # \`lefthook run pre-push --force\`). У коммита staged-файлы есть всегда, так что эта копия
    # пропущена быть не может, и плохое имя ветки отклоняется ещё до первого коммита в неё.`,
    commitMsgArg: `      # {1} — файл сообщения коммита, который передаёт lefthook.`,
    prePushBackstop: `      # Только страховка — см. заметку у pre-commit; эта копия пропускается при push новой ветки.`,
  },
};

/**
 * Render the lefthook config, reproducing kits/<lang>/config/lefthook.yml.example verbatim
 * (including its comments), with each `<serpens-sdd> <subcommand>` placeholder replaced by the
 * resolved invocation. The YAML structure and every `run:` line are identical across
 * languages; only the inline comments differ, taken verbatim from each kit's own example.
 * @param {string} invocation
 * @param {'en'|'ru'} [lang]
 * @returns {string}
 */
export function renderLefthook(invocation, lang = 'en') {
  const c = LEFTHOOK_COMMENTS[lang] ?? LEFTHOOK_COMMENTS.en;
  return `pre-commit:
  parallel: true
  commands:
    docs-disposer:
      run: ${invocation} verify-docs
${c.branchConvention}
    branch-convention:
      run: ${invocation} git-naming --branch

commit-msg:
  commands:
    message-convention:
${c.commitMsgArg}
      run: ${invocation} git-naming --commit-msg {1}

pre-push:
  commands:
    branch-convention:
${c.prePushBackstop}
      run: ${invocation} git-naming --branch
`;
}
