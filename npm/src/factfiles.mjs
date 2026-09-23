// The fact files, declared once — what each answers, and which stage is required to read it.
//
// WHY THIS MODULE EXISTS. The kit's prose names no technology; it defers to files that answer
// org-specific questions ("what is a fast test here?", "what does a branch name look like?").
// Those files were referred to by literal path in the installer, in command prose and in tests,
// so adding one meant editing several places and nothing proved they agreed. This is the one
// list. `openspec/config.yaml` is rendered from it: `context:` gets the catalog, `rules:` gets
// the per-artifact orders.
//
// TWO FIELDS, TWO DIFFERENT JOBS.
//   `answers`  — one line, goes in the catalog OpenSpec injects into EVERY artifact instruction.
//                It exists so the agent can decide whether this file is relevant now. It is not
//                an instruction to read anything.
//   `requiredBy` — artifact ids whose instruction gets a hard "read this first" rule. Empty is
//                the common and correct case: `proposal` is intent, and needs none of our facts.
//                Only stages where guessing is expensive get an order.
//
// Artifact ids below are `spec-driven`'s (`proposal`, `specs`, `design`, `tasks`). A project-local
// schema may name its artifacts differently, which is why `artifactRules()` takes the ids the
// resolved schema actually declares and silently drops rules for artifacts that do not exist —
// a rule keyed to an unknown artifact is dead weight in every instruction.

import { LAYOUT } from './layout.mjs';

/** @typedef {{path: string, answers: string, requiredBy: string[], why: string}} FactFile */

/** @type {FactFile[]} */
export const FACT_FILES = [
  {
    path: LAYOUT.testingStack,
    answers: 'how tests run here, and what a tester can send, produce or query',
    requiredBy: ['design', 'tasks'],
    why: 'design picks a boundary to test and tasks lists the commands that run them; both are '
      + 'wrong if the fast/slow tiers are guessed',
  },
  {
    path: LAYOUT.branching,
    answers: 'branch and ticket naming',
    requiredBy: ['tasks'],
    why: 'tasks is where a branch name is first written down',
  },
  {
    path: `${LAYOUT.templates}/adr.md`,
    answers: 'the shape a decision record takes here',
    requiredBy: [],
    why: 'read only when a change actually records a decision',
  },
];

/**
 * The catalog lines for `context:` — every fact file, whether or not any stage requires it.
 * @param {FactFile[]} [files]
 * @returns {Array<{path: string, answers: string}>}
 */
export function contextCatalog(files = FACT_FILES) {
  return files.map(({ path, answers }) => ({ path, answers }));
}

/**
 * The `rules:` mapping — artifact id → the orders that artifact gets.
 *
 * @param {string[]} artifactIds - the ids the RESOLVED schema declares. A rule for an id not in
 *   this list is dropped: it would be injected nowhere, or worse, into an artifact whose job is
 *   something else entirely.
 * @param {FactFile[]} [files]
 * @returns {Record<string, string[]>}
 */
export function artifactRules(artifactIds, files = FACT_FILES) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const id of artifactIds) {
    const required = files.filter((f) => f.requiredBy.includes(id));
    if (!required.length) continue;
    out[id] = required.map((f) => `Read ${f.path} before writing this artifact — ${f.why}.`);
  }
  return out;
}
