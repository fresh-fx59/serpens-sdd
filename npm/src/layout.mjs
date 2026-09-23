// Where this kit's files live inside a repository it has onboarded — declared once.
//
// WHY A DIRECTORY OF OUR OWN. Until now the kit wrote into `docs/`, `conventions/`, `templates/`
// and `tools/`: four namespaces a brownfield repository almost certainly already uses, and none
// of which we own. That is not a tidiness complaint, it is the cause of a real defect already
// patched in this codebase — an unconditional copy into `templates/research.md` destroyed a
// team's own file (see the ownership check in `src/stages/stage5-onboard.mjs`), and
// `tools/serpens-lint.mjs` puts a team's entire `docs/` tree under OUR line caps because that is
// where our one document happened to sit. One owned directory removes the whole class: everything
// under `serpens/` is ours, everything outside it is theirs, and no content-identity heuristic is
// needed to tell them apart.
//
// WHY `serpens/`, NEXT TO `openspec/`. OpenSpec owns exactly one directory and hardcodes its
// name (`OPENSPEC_DIR_NAME = 'openspec'`, `dist/core/config.js:1`; the root constants in
// `dist/core/openspec-root.js` are literals too, there is no env var and no `--dir` flag, and
// upstream issue #697 asking for a configurable root is unassigned with its siblings closed
// NOT_PLANNED). It claims no other path. A sibling directory therefore collides with nothing and
// reads, to a human opening the repository, as obviously the other half of the same system.
//
// WHY THESE PATHS ARE CONSTANTS AND NOT CONFIGURATION. A configurable path has to be threaded
// through the installer, every gate, two shell tools AND the installed command/skill prose, which
// is plain markdown naming files by path — that last one means a new substitution token in ~40
// prose lines across two languages, re-applied on every upgrade, plus a default-path and a
// custom-path case in every gate test. Nobody has asked for it. The one file that plausibly
// predates the kit, the branching contract, already has its own escape hatch
// (`--conventions <path>` / `$SERPENS_SDD_CONVENTIONS_BRANCHING` in `tools/lib/branch-contract.sh`),
// and that hatch is unaffected by anything here. If a second override is ever genuinely needed,
// the same shape extends cheaply — on demand, not speculatively.
//
// WHY `repo.txt`, `adr/`, `index.json` AND `index.md` MOVED OUT OF `openspec/`. Those four are
// OURS — the pinned repo identity, the ADR archive `spns-archive` writes, and the capability
// index `serpens-sdd index` generates. None is an OpenSpec artifact: OpenSpec claims `specs/`,
// `changes/`, `config.yaml`, `project.md` and `AGENTS.md` inside its directory and nothing else.
// Sitting in OpenSpec's namespace they broke the same rule the move above exists to enforce, and
// with a concrete cost: `verify-docs` requires `index.json`, `index.md` and `repo.txt` to be
// tracked AND staged, so a team running vanilla OpenSpec beside this kit hits a red pre-commit
// naming an index file they have never heard of, inside the directory they believe OpenSpec owns.
// Under `serpens/` the gate names a file in our own directory, and `openspec/` holds only what
// OpenSpec itself put there.
//
// NOT IN HERE, deliberately: the command and skill directories, the port's instruction file
// (`CLAUDE.md`, `AGENTS.md`, …), `lefthook.yml`, `.gitmodules` and `.gitignore`. Those names are
// chosen by another tool — the agent harness, lefthook, git — which will only look in the place
// it chose. A file whose location someone else decides is not ours to move.

/** The one directory this kit owns inside an onboarded repository. */
export const SERPENS_DIR = 'serpens';

/**
 * Every path the kit writes or reads inside a repository, relative to that repository's root.
 *
 * `shim` sits under `bin/` rather than at the top because it is the only executable here and a
 * reader should not have to wonder which of these files is the one you run.
 */
export const LAYOUT = {
  /** The generated POSIX-sh entry point every command, skill and git hook calls. */
  shim: `${SERPENS_DIR}/bin/serpens-sdd`,
  /** Per-repository testing facts — the twelve slots. Lives in each onboarded spoke. */
  testingStack: `${SERPENS_DIR}/testing-stack.md`,
  /** The branching and ticket-naming contract. Lives in the system store. */
  branching: `${SERPENS_DIR}/branching.md`,
  /** The delivery-convention contract (forge word, who opens the PR, ticket topology, merge
   * order/style, integration/release branch, archive timing, hand-off routing). Lives in the
   * system store, same shape as `branching`. spec-org-facts-slice-delivery-2026-09-23.md. */
  delivery: `${SERPENS_DIR}/delivery.md`,
  /** The agent-port facts. Lives in the system store. */
  portFacts: `${SERPENS_DIR}/port-facts.md`,
  /** Document templates the commands render from. */
  templates: `${SERPENS_DIR}/templates`,
  /** The pinned repository identity — committed data, never the checkout folder name. */
  repoTxt: `${SERPENS_DIR}/repo.txt`,
  /** The ADR archive `spns-archive` writes into, as `NNNN-<slug>.md`. */
  adrDir: `${SERPENS_DIR}/adr`,
  /** The generated capability index, machine-readable half. */
  indexJson: `${SERPENS_DIR}/index.json`,
  /** The generated capability index, human-readable half. */
  indexMd: `${SERPENS_DIR}/index.md`,
  /** Where our lefthook config lands when a team's own main config (any of the 15 names
   * lefthook reads) is already present — never `lefthook.yml` itself in that case, so their
   * file is never shadowed or silently overwritten. Added to their config via `extends:`,
   * by hand (a `manual` line in stage 5's evidence). */
  lefthookFallback: `${SERPENS_DIR}/lefthook.yml`,
  /** The per-change ownership marker — a sibling of upstream's own `openspec/changes/<id>/
   * .openspec.yaml`, never inside it (gap 2, serpens-openspec-coexistence-gaps-2026-09-22.md).
   * `src/ownership.mjs` reads it via `isOwnedChange`/`isOwnedPath`; the shell twin is
   * `tools/lib/ownership.sh`. Not under `SERPENS_DIR`: it names a file inside a directory
   * OpenSpec owns, one per change, not a path under our own directory. */
  changeMarker: '.serpens.yaml',
  /** The install topology, one line: `repo-local` (step 6, gap 3 — no sibling store). Written by
   * stage 5 in repo-local mode only; read at HOOK time by the store-only tools
   * (`tools/aggregate-index.mjs`, `tools/sync-submodules.sh`), which have no config file to read,
   * so they can refuse with a clear message instead of guessing a store path. Absent = store
   * topology (every install before step 6). */
  topology: `${SERPENS_DIR}/topology`,
  /** Our own ignore file inside `serpens/` — repo-local mode writes the init run log into
   * `serpens/` (there is no store to hold it) and ignores it here, never in the team's root
   * `.gitignore`. */
  gitignore: `${SERPENS_DIR}/.gitignore`,
  /** step 7 (gap 6, spec-openspec-coexistence-2026-09-22.md): a JSON record of which ambiguous
   * files this install CREATED (the file did not exist before we wrote it) versus APPENDED
   * (the file existed and we edited it) — the HARD RULE instruction file and
   * `openspec/config.yaml`, the two writes `serpens-sdd uninstall` cannot classify from an
   * owner check alone. Written by stage 5/6 as they make each write; consulted, never
   * required, by uninstall — a missing record degrades to owner checks alone. Removed last by
   * uninstall itself. */
  installRecord: `${SERPENS_DIR}/.install-record.json`,
};

/**
 * The paths this kit owns, for a caller that needs to answer "is this file ours?" — the lint
 * scope, for one. Everything under `SERPENS_DIR` is ours; nothing outside it is. As of gap 2
 * (serpens-openspec-coexistence-gaps-2026-09-22.md) this is no longer the whole answer for a
 * change under `openspec/changes/`: a marked change dir (`LAYOUT.changeMarker` present, `owner:
 * serpens-sdd`) is ours too even though it sits outside `SERPENS_DIR` — `src/ownership.mjs`'s
 * `isOwnedPath` is the caller that combines both; this array alone answers only the
 * prefix-owned half.
 */
export const OWNED_PREFIXES = [`${SERPENS_DIR}/`];

/**
 * The heading `stage5-onboard.mjs` appends to a port's instruction file (its own
 * `HARD_RULE_MARKER`, kept private there). Declared here too, read-only, so a tool that must
 * recognise the block WITHOUT owning it — `verify-docs --staged-scope` (does a staged diff of a
 * root instruction file touch the block?) and `serpens-lint.mjs` (root ALL-CAPS docs: only the
 * block itself is in scope, never the rest of a team's file) — does not import the stage module
 * that writes it (gap 1, serpens-openspec-coexistence-gaps-2026-09-22.md, step 3). Keep this
 * string byte-identical to `HARD_RULE_MARKER` in `src/stages/stage5-onboard.mjs`.
 */
export const HARD_RULE_MARKER = '## HARD RULE — disposer self-check';
