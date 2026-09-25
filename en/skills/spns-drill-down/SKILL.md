---
name: spns-drill-down
description: How to gather system knowledge — catalog to repo to live code. Use whenever work on a Serpens change (spns-* commands or a change with `.serpens.yaml`) needs facts about a capability, module, or contract.
serpens-version: 2026-09-25.1
---
## Trust order (absolute)
live code > repo living spec > repo index > central catalog > wiki. Each level may only ROUTE you
to the level above it; only code and living specs may be QUOTED as fact.

## The walk (≤3 content-bearing hops; no sibling preloading)
1. Central catalog (system store catalog.md): find which repo owns the capability. A ⚠ STALE or
   🔴 RED marker means: do not trust the entry — go to the repo directly.
2. That repo's serpens/index.md: find the capability's living spec + relevant module. If the
   catalog and the repo index disagree, the repo index wins — note the mismatch in the tracker
   so DevOps re-aggregates.
3. The living spec, then the ACTUAL code it points to (registered Git submodule; run
   `<serpens-sdd> sync-submodules` if it is stale — the lint warns). For contract facts
   (field names, and the surface shapes `serpens/testing-stack.md` names):
   read the source and EMBED it (`<!-- embed: path#Lx-Ly -->`) — never transcribe by hand, never
   quote a spec's prose for a shape when the source is one hop away.

## Recording (pointers, not payloads)
Every verified fact → one line in the change's research.md: path#Lstart-Lend + a one-line finding.
Never paste file contents into research.md — pointers stay fresh, payloads rot and bloat context.

## Cold start (capability in no index)
Search the catalog for related terms → search code across `system-store/submodules/` → still nothing?
STOP and ask a human which repo should own it. NEVER scaffold a new capability without a confirmed
home; the first commit claims the name, and a wrong claim creates a duplicate-ownership mess.
New capability confirmed → create openspec/specs/<kebab-id>/spec.md in the owning repo; the index
regenerates; the catalog picks it up.

## Context discipline
Load only what the current hop needs. When assembling a large working context: spec sections
early, navigation material in the middle (disposable), code next, and RE-PASTE the exact verified
contract snippets at the very bottom, immediately before generating — recency wins for facts that
must be transcribed exactly. No single loaded artifact over ~4K tokens; use the spec's section
anchors instead of whole files.
