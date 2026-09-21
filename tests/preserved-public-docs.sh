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

# Per-kit docs/ filenames preserved verbatim (four per language: en/docs/, ru/docs/).
PRESERVED_PUBLIC_DOC_NAMES='FLOW.md FLOW-TABLE.md FLOW-SCHEMA.md'
# Glob (shell `case` pattern) form for the one name that is not a fixed literal.
PRESERVED_PUBLIC_DOC_GLOBS='MIGRATION-*-to-current.md'
# Repo-root files (relative to the public repo root, outside any kit) preserved verbatim.
PRESERVED_PUBLIC_ROOT_FILES='docs/RENAME.md docs/index.html docs/common-contract.html'
