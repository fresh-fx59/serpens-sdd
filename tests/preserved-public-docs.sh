#!/usr/bin/env bash
# Single source of truth for spec-npm-oidc-publishing-2026-09-11.md §10's preserved
# public-only paths — the content that exists ONLY in github.com/fresh-fx59/serpens-sdd and
# is deliberately never synced from (or deleted by) the vault.
#
# Declared here ONCE. Consumers:
#   - tests/starter-contract-test.sh (bash) sources this file directly.
#   - serpens-sdd-npm/src/preserved-public-docs.mjs (Node) parses this same file so the two
#     never drift — do not restate these lists anywhere else.
#
# Format is deliberately flat (space-separated, single-quoted) so both a bash `source` and a
# small regex-based Node parser can read it without a shell subprocess or a new dependency.

# Per-kit docs/ filenames preserved verbatim (three per language: en/docs/, ru/docs/).
PRESERVED_PUBLIC_DOC_NAMES='FLOW.md FLOW-TABLE.md FLOW-SCHEMA.md'
# Glob (shell `case` pattern) form list. Empty since 2026-09-21: MIGRATION-*-to-current.md
# (the rename-era migration guide) is retired — @fresh-fx59/corp-sdd was never published to
# npm, so there was never an installed base to migrate off, and the guide had no reader.
PRESERVED_PUBLIC_DOC_GLOBS=''
# Repo-root files (relative to the public repo root, outside any kit) preserved verbatim.
# docs/RENAME.md dropped 2026-09-21: it existed only to narrate the corp-sdd -> serpens-sdd
# rename, which the operator wants gone, not preserved.
PRESERVED_PUBLIC_ROOT_FILES='docs/index.html docs/common-contract.html'
