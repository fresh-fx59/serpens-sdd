# Serpens SDD

Spec-driven development across corporate repositories, for teams whose agent CLI is
whatever their employer approved and whose network is restricted. It wraps
[OpenSpec](https://github.com/Fission-AI/OpenSpec)'s lifecycle with deterministic
repository, branch, documentation and contract gates: the rules you were hoping the model
would remember become checks that run.

## Install

```bash
npm i -g @fresh-fx59/serpens-sdd
serpens-sdd version          # prints the kit edition
serpens-sdd init             # the staged installer, one gate per stage
```

`init` is the mechanical half: it resolves your agent port, creates the system store,
onboards repositories as submodules, installs the seven commands and six skills into your
agent's own config directory, wires the pre-commit gate, and writes an evidence file
recording exactly what it proved. It **never** deletes, resets, cleans, rebases or
force-checkouts anything it finds, and it stops at the first failed gate. Add `--dry-run`
to the same invocation and it prints every stage's plan — commands and file writes — while
touching nothing.

What `init` cannot prove, it refuses to guess: your tracker, your forge, the MCP tool
names, and your testing stack are written out as `UNFILLED` facts for a human to fill in,
and `serpens-sdd verify-docs` stays red until they are.

Requires `git` >= 2.13, `node` >= 18, `lefthook`, and the pinned OpenSpec CLI. That last
one matters: the package is **`@fission-ai/openspec`** — the bare name `openspec` on the
public registry is an unrelated empty `0.0.0` placeholder that installs nothing usable.
`ctags` (Universal) and Zoekt are optional; without them you lose code search and nothing
else. On a restricted network, mirror `@fission-ai/openspec` internally and record the
resolved registry in your handover.

## Or read the runbook first

`docs/SETUP.md` is not a manual — it is a **task written for an agent**, staged, with a gate
at every step. Hand it to your agent CLI and it performs the install:

```text
Read en/docs/SETUP.md and execute it as your task. Stop at every failed gate and
show me the output. Do not skip stage 0.
```

Stage 0 asks for these and stops if any is missing:

| Input | Example |
|---|---|
| Project id | `PROJ` |
| Agent port name | the agent CLI you run — 40 are supported; the registry is `ports/*.json` inside the package |
| Pinned OpenSpec version | for `@fission-ai/openspec` |
| System-store remote URL | an empty Git repository you own |
| Approved base branch | `develop` or `main` |

## Start here

| Language | Installation | Upgrade | Daily operations |
|---|---|---|---|
| English | [`en/docs/SETUP.md`](en/docs/SETUP.md) | [`en/docs/UPGRADE.md`](en/docs/UPGRADE.md) | [`en/docs/OPERATIONS.md`](en/docs/OPERATIONS.md) |
| Русский | [`ru/docs/SETUP.md`](ru/docs/SETUP.md) | [`ru/docs/UPGRADE.md`](ru/docs/UPGRADE.md) | [`ru/docs/OPERATIONS.md`](ru/docs/OPERATIONS.md) |

Setup creates this operational layout:

```text
<workspace>/
├── serpens-sdd/               # this repository, if you cloned it
└── system-store/              # independent Git repository
    ├── .gitmodules
    ├── project-repositories.json
    └── submodules/
        └── <project-repository>/
```

Repository bindings come from MCP when available. The same normalized inventory can be
supplied manually, so MCP is not required. The kit ships six self-contained `spns-` skills;
an external Superpowers installation is not required.

## One fact file per repository

The commands name no framework, transport, store or query language of their own. Every one
of those is a fact about YOUR repository, and they all live in one place —
`serpens/testing-stack.md`, written from `templates/testing-stack.md` at install:

- the FAST and SLOW test tiers and the exact command that runs each (`spns-tdd`);
- the boundaries only the slow tier catches, and the debugging boundary order
  (`spns-debugging`);
- **Manual testing access** — twelve slots naming what a tester can send, produce, query and
  observe from outside (`spns-test-plan`, `spns-autotest`).

`serpens-sdd verify-docs` schema-validates that file: every required section present, every
slot answered. `none` is a complete answer where a slot offers one — "this repository has no
such surface" — and it is not the same as leaving a slot blank. An answer that is the same
across your whole estate belongs in one document: name it in the `estate-reference` slot and
answer `inherit` in the slots it covers.

## Repository contents

- `en/` and `ru/`: equivalent English and Russian kits — commands, skills, templates, docs,
  config examples, slides;
- `docs/index.html`: the published five-minute presentation —
  <https://fresh-fx59.github.io/serpens-sdd/>;
- `docs/common-contract.html`: how a cross-repo contract stays single-owner —
  <https://fresh-fx59.github.io/serpens-sdd/common-contract.html>. Includes the two fetch
  routes a spoke delta needs (change-scoped while the contract change is open, spec-scoped
  once it is archived), measured against OpenSpec 1.11–1.13 (the currently supported window);
- `serpens-sdd-starter-en.zip` / `serpens-sdd-starter-ru.zip`: the same kits as archives;

**The executables are not in this repository.** The eleven deterministic scripts and the
`serpens-sdd` CLI ship in the npm package, which is also where their acceptance suites and
the package's own `npm test` live. Earlier editions copied the same scripts into
`<store>/tools/` and into every onboarded repository; that is what the package replaced, and
keeping a second copy here would be a second source of truth for the same bytes.

Background: [Enterprise spec-driven development with AI agents](https://aiengineerhelper.com/posts/enterprise-spec-driven-development-ai-agents/).

## Versioning

The kit is versioned as a whole, by **edition**, not per asset. `<kit>/VERSION` holds the
edition; every shipped command and skill carries a matching `serpens-version:` stamp in its
own header; `<kit>/MANIFEST.sha256` pins the exact bytes of each stamped file for that
edition. An installed copy can therefore be identified at any path, without this repository:

| Task | Command |
|---|---|
| Print the edition | `serpens-sdd version show` |
| List every stamped file and its stamp | `serpens-sdd version list` |
| Fail if any stamp differs from `VERSION` | `serpens-sdd version check` |
| Fail if any file differs from the manifest | `serpens-sdd version verify` |
| Report an installed copy: pristine / MODIFIED / UNSTAMPED | `serpens-sdd version identify <file>…` |

The npm package version is the edition as semver: edition `YYYY-MM-DD.N` is published as
`1.YYYYMMDD.N`, so `npm view @fresh-fx59/serpens-sdd version` and `<kit>/VERSION` can never
disagree about which edition you have.

## Licence

MIT — see [`LICENSE`](LICENSE).
