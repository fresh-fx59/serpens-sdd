---
name: spns-debugging
description: Systematic root-cause debugging. Use when ANY test fails unexpectedly or behavior contradicts the spec — BEFORE attempting fixes.
serpens-version: 2026-09-21.1
---
## The law
No fix before diagnosis. A fix without a named root cause is a guess; guesses that pass are the
most expensive bugs you will ship.

## The four phases
1. READ: the actual error, verbatim, top frame first. Read the failing assertion and its actual-vs-
   expected values. Do not skim — half of all debugging ends here.
2. REPRODUCE minimally: the smallest command that shows the failure (single test > suite > app).
   Cannot reproduce → you do not understand it yet; vary one factor at a time until you can.
3. LOCATE the mechanism: trace from symptom to cause, checking boundaries from the inside out:
   the failing unit itself → its direct inputs (what did it actually receive? log/inspect, don't
   assume) → serialization and configuration boundaries (is the message shape what you think? is
   the dependency actually the one wired in? is the config value actually loaded?) → stored state
   (what the store really holds vs what you expect) → only then upstream systems. The concrete
   technologies at each step belong to the repository: read `docs/testing-stack.md` §Debugging
   boundary order and walk the chain it names. Cross-component bugs are found at a boundary where
   reality stops matching assumption — find THAT boundary before touching code.
4. FIX THE CLASS, verify, then ask: can this same mistake exist elsewhere? Fix the pattern (or
   file it), not just the instance. Add the missing test that would have caught it.

## Forbidden moves
Shotgun edits ("try this") · adding sleeps/retries to hide race conditions · catching-and-ignoring
to silence a failure · "fixing" a held-out or contract test · deleting the failing test.
Note the finding in research.md if it revealed a spec/code mismatch → spns-implement's a/b/c flow.
