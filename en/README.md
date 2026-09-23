# Serpens SDD starter kit

This kit installs a project-level SDD system store and repository-level OpenSpec
workflow. It is self-contained for restricted networks after your organization
mirrors the required binaries and npm package.

Start with [`docs/SETUP.md`](docs/SETUP.md): it is the installation runbook for a
new workspace. An existing workspace moves to a newer kit edition through
[`docs/UPGRADE.md`](docs/UPGRADE.md). Daily use and recovery are in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Resulting workspace

```text
<workspace>/
├── serpens-sdd/                  # this kit, settings, commands, skills
└── system-store/              # independent Git repository
    ├── .gitmodules            # the repository list — no separate inventory file
    ├── openspec/              # cross-repository contracts and ADRs
    ├── serpens/
    │   └── bin/
    └── submodules/
        ├── <repository-a>/
        └── <repository-b>/
```

Repository bindings come from the project's MCP integration when available.
The same normalized rows can be supplied manually, so MCP is not an installer
dependency. The kit ships its own `spns-*` skills. Upstream Superpowers is not
required.

## Shipped components

- `system-store-template/`: plain files copied to create the sibling store;
- submodule sync, repository-state gates, docs checks, and indexes: reached through the `<serpens-sdd>` token in commands and skills, backed by the `@fresh-fx59/serpens-sdd` package and the generated `serpens/bin/serpens-sdd` shim in each repository;
- `commands/`: seven Serpens workflow command templates with explicit OpenSpec calls;
- `skills/`: six self-contained Serpens skills;
- `templates/`: research, ADR, contract, testing stack, port facts, and branch conventions;
- `config/`: normalized inventory example and lefthook example;
- `slides/`: the talk deck and its editable source.

The acceptance suites that gate this kit are maintained in the vault beside it,
not shipped inside it.

The template is deliberately not a nested Git repository. Setup copies it beside
`serpens-sdd`, initializes Git there, and never modifies or removes an existing store.
