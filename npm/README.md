# @fresh-fx59/serpens-sdd

Spec-driven development across corporate repositories, for teams whose agent CLI is
whatever their employer approved and whose network is restricted. This package is the
executable half of the **Serpens SDD** kit: the `serpens-sdd` CLI, the eleven deterministic
scripts it wraps, and the agent-port registry (`ports/*.json`, 40 supported CLIs). It wraps
[OpenSpec](https://github.com/Fission-AI/OpenSpec)'s lifecycle with deterministic
repository, branch, documentation and contract gates.

The English/Russian command-and-skill kits, the setup/operations runbooks and the
five-minute presentation live in the source repository:
<https://github.com/fresh-fx59/serpens-sdd>.

## Install

```bash
npm i -g @fresh-fx59/serpens-sdd
serpens-sdd version          # prints the kit edition
serpens-sdd init             # the staged installer, one gate per stage
```

## Quick start

```bash
serpens-sdd init             # onboard, staged, one gate per stage
serpens-sdd mode              # prints attended/unattended
serpens-sdd delivery --print-contract
serpens-sdd version show      # prints the installed kit edition
```

`init` resolves your agent port, creates the system store, onboards repositories as
submodules, installs the six commands and six skills into your agent's own config
directory, wires the pre-commit gate, and writes an evidence file recording exactly what it
proved. It **never** deletes, resets, cleans, rebases or force-checkouts anything it finds,
and it stops at the first failed gate. Add `--dry-run` to see every stage's plan first.

Requires `git` >= 2.13, `node` >= 18, `lefthook`, and the pinned OpenSpec CLI
(`@fission-ai/openspec`, currently supported minors 1.11–1.13). `ctags` (Universal) and
Zoekt are optional.

## Links

- Source & docs: <https://github.com/fresh-fx59/serpens-sdd>
- Setup runbook (EN): <https://github.com/fresh-fx59/serpens-sdd/blob/main/en/docs/SETUP.md>
- Setup runbook (RU): <https://github.com/fresh-fx59/serpens-sdd/blob/main/ru/docs/SETUP.md>
- Presentation: <https://fresh-fx59.github.io/serpens-sdd/>
- Licence: MIT — see [`LICENSE`](https://github.com/fresh-fx59/serpens-sdd/blob/main/LICENSE)

## Release 2026-10-01.1

- Retires `spns-autotest` intentionally. Code-level automated tests are planned by `spns-plan` and executed through `spns-implement`, using the repository's `serpens/testing-stack.md`. `spns-test-plan` produces manual checks.
- Accepts a ticket ID for `delivery --handoff --change` and `state assert-archivable --change` when it identifies exactly one marked change; ambiguous matches fail with candidate names.
- Requires a fresh handoff after pushing commits beyond the recorded handoff tip.
- Forwards piped rows to `sync-submodules --repos-from -` instead of silently synchronizing zero rows.

Rerun `serpens-sdd init` with the existing configuration to update installed commands and verify the new edition. Owned retired commands are archived outside the active command directory; custom unstamped commands are preserved.
