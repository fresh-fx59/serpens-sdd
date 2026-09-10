---
title: SDD decks — source & rebuild
type: reference
status: active
created: 2026-07-22
updated: 2026-07-22
tags: [sdd, presentation, content, enterprise-sdd-agents]
links: []
---

# SDD decks — source

Reproducible source for the Russian HTML slide deck `../deck-ru-talk5.html` (the
5-minute solution talk). Data-driven: **one engine, content in JSON.**

> Older leadership and team decks were removed because they no longer matched the
> executable kit. Rebuild future material from `docs/SETUP.md`, `docs/OPERATIONS.md`,
> and the current command bodies.

## Files
- `deck-template.html` — the engine: CSS design system (two accents, light+dark themes),
  a data-driven renderer (12 slide layouts), keyboard nav, progress, height auto-fit,
  print-to-PDF. Placeholders: `/*__TOKENS_CSS__*/`, `/*__META_JSON__*/`, `/*__SLIDES_JSON__*/`.
- `build-decks.mjs` — injects per-deck color tokens + slide JSON into the template; emits a
  standalone `.html` (with `<head>`) **and** a `.artifact.html` (body-only, for the Artifact
  publisher) into `dist/`.
- `content/talk5.json` — the slide content (one array per deck).
  **This is the edit surface** — change wording here, not in the built HTML.

## Rebuild
```
node build-decks.mjs talk5                # -> dist/deck-ru-talk5.html (+ .artifact.html)
cp dist/deck-ru-talk5.html ../deck-ru-talk5.html
```
To re-publish an Artifact in-place, republish the matching `dist/*.artifact.html` with the
existing Artifact URL (see `../index.md`).

## Layouts (per slide `layout` field)
`title · bullets · statement · two-col · cards · stack · fanout · pipeline · timeline · table · map · closing`
See the schema comment block near the top of `deck-template.html`'s renderer.

## Provenance
Current claims must trace to `docs/SETUP.md`, `docs/OPERATIONS.md`, command bodies,
and tested commands. Last workflow update: 2026-08-20.
