---
description: Turn an approved delta spec's scenarios into a black-box integration test plan QA can run on the dev stand (tester flow)
serpens-version: 2026-09-23.1
---
Build the black-box integration test plan for change {{args}}.

AUDIENCE — read this before writing anything. The testers only see the application deployed
on the dev stand. They do not read the code and they do not test methods. Every item you
produce must be something they can send, produce, query or observe from OUTSIDE the running
system. Payloads and queries must be copy-paste ready, not described in prose. A check that
needs internal calls or private state belongs in `spns-autotest`, not here.

WHAT THE TESTERS CAN ACTUALLY DO is a fact about THIS repository, not about this command. Read
`serpens/testing-stack.md` and follow its `Manual testing access` section. If that file does not
exist, or the facts you need from it are incomplete, stop and ask the team once, then write it
from `templates/testing-stack.md` — never guess a client, a transport, a store or a query
language, and never name a technology that file did not name. `<serpens-sdd> verify-docs` tells
you which slots are still open.

Its slots ARE the parts you build each step out of: `request-client` and `request-idiom` for a
direct call, `event-transport`, `event-produce-path`, `event-addressing` and
`event-payload-format` for a message, `data-stores`, `store-query-idiom` and `store-seed-idiom`
for state, `error-routing` for a rejection, `observation-access` for anything the tester can
only read. Use the words those answers use.
A slot answered `none` means that shape of test does not exist in this repository — leave it out
of the plan instead of inventing one. A slot answered `inherit` points at the document named in
`estate-reference`: read that document for the real answer. A slot answered `TODO(produce path)`
means the estate has no sanctioned way to do it yet: print what the tester must send as DATA,
carry that TODO once per plan, and do not invent a command.

0. Set `REPO_ROOT="$(git rev-parse --show-toplevel)"`. Run
   `<serpens-sdd> state inspect`. If this is a local change branch, also
   run `<serpens-sdd> state assert-change <TICKET> --allow-dirty`.
1. The delta spec's scenarios ARE the expected behaviour — you render them into runnable form, you
   do not re-derive them. Read them and the living spec sections the change modifies (regressions
   live there), then the change's `research.md` OBSERVABLE CONTRACT block, which pins the
   surfaces, destinations and stores with source pointers. The built system supplies only
   CONCRETE VALUES the spec cannot hold: generated ids, actual error bodies, real rejection
   destinations, real wait times.
   DRIFT IS NOT YOURS TO FIX. If the built system contradicts a scenario, STOP and ask the user
   how to proceed: print the scenario, the observed behaviour and the source pointer, and offer
   the two ways out — (1) amend the delta on that branch through `spns-implement` step 4(a)
   because the built behaviour is right, or (2) leave the spec and file the mismatch as a defect.
   Do not pick for them and do not continue the plan until they answer. Writing the
   tester a plan that matches the code instead of the spec turns the plan into a description of
   whatever was built — the one thing a black-box plan must never be. Never invent a field name.
2. One test case per scenario, in this shape:
   - **ID + title** (the scenario name) and the requirement ID (e.g. R3).
   - **Preconditions** — stand, user/role and permission, obtained the way `request-idiom` says
     it is obtained, and the exact seed data written the way `store-seed-idiom` sanctions,
     including the reference records the flow reads for enrichment.
   - **Action** — exactly one, fully written out:
     - *Direct call*: every part `request-idiom` names, as separate labeled fields, and then once
       more in the exact form `request-client` takes, so the tester can run it without editing.
     - *Message*: the destination as `event-addressing` names it, whatever that slot says decides
       ordering or grouping, and the complete body in the form `event-payload-format` gives — the
       exact bytes the tester sends, put in the way `event-produce-path` says.
     - *UI or scheduled job*: the click path, or how the run is triggered.
   - **Expected observable result** — all that apply:
     - *What comes back*: the outcome the caller sees, in full, in whatever form `request-idiom`
       says a call answers. Mark generated values as `<uuid>`, `<timestamp>` instead of
       inventing them.
     - *Data*: for each affected store in `data-stores`, name it and the record, give the read
       the tester runs in the `store-query-idiom` form, and the expected values field by field —
       including which ones are enriched or normalized and what they must become.
       State also what must NOT change.
     - *Messages*: the expected outgoing message(s), their destination and full body.
     - *Observed*: anything the tester can only read, and where `observation-access` says to
       read it.
     - *Timing*: for asynchronous flows, the maximum wait before the result must be visible and
       how to re-check.
   - **Cleanup**, if the case leaves state behind.
3. Negative and boundary cases for the same surface, in the same shape: malformed payload,
   missing required field, wrong type, unknown enrichment key, duplicate or replayed message,
   out-of-order message. Give the exact error body, or — where `error-routing` names one — the
   destination a rejection lands in and exactly what lands there; "returns an error" is not an
   expected result.
4. Regression items for every MODIFIED requirement: the request or message as it is sent today and
   the result expected after the change, so the tester can prove nothing else moved.
5. Add a "worth exploring" section, clearly marked as suggestions rather than requirements: state
   transitions, permissions, concurrency, empty and overflow inputs, and — where the stores or
   transport in `serpens/testing-stack.md` have them — retention and partitioning.
6. Anything you could not verify becomes `TODO(<what>)`. Never fill a payload field or an expected
   value with a guess — an unmarked guess costs the tester a false failure.
7. `test-plan-posted-to` (from `<serpens-sdd> delivery --print-contract`) is
   `same-ticket-comment` in every shipped shop: post the plan as a COMMENT on the SAME ticket this
   spec was written on — for a cross-repo story that is the repository's own child ticket. Do NOT
   create a separate test ticket: the testers work inside that ticket and leave their findings
   there. If the field is `print-only`, or no tracker integration is configured, print the plan
   ready to paste. Do not mark anything passed; the tester's additions
   outrank yours.
