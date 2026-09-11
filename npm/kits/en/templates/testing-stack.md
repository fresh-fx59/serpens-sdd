# Testing stack — <repository or project name> (recorded YYYY-MM-DD)

Everything `spns-tdd`, `spns-debugging`, `spns-test-plan` and `spns-autotest` need to know about
THIS repository. None of those name a framework, a store or a transport of their own — they read
this file. Fill it in once per repository, from what the build and the dev stand actually do, not
from what the team intends to use. Real commands, real names: an entry nobody can run is worse
than an empty line.

Every `UNFILLED — ` line and every `UNFILLED` answer below is a gate. The `verify-docs` step
fails while one remains, and it names the section. Where a slot offers `none`, `none` is a
COMPLETE answer — "this repository has no such surface" — and it is not the same as "nobody has
said yet", which is what the `UNFILLED` text means. Leave `UNFILLED` in place until you know.

Do not delete the `<!-- serpens:section ... -->` comments. They are how the gate finds a section
whose heading your team reworded, and how an upgrade appends a section added in a later edition
without touching a word you wrote.

<!-- serpens:section fast-tier -->
## FAST tier — the inner loop, run after EVERY green step, must stay in seconds
| Component / module | What a fast test is here | Command that runs only these |
|---|---|---|
| ... | e.g. plain unit tests, no DI container | ... |

UNFILLED — the FAST tier rows for this repository (component, what counts as fast here, and the exact command that runs only those), from the team that owns its build

<!-- serpens:section slow-tier -->
## SLOW tier — run at TASK boundaries and before the PR, never inside the micro-loop
| Component / module | What a slow test is here | Command that runs only these |
|---|---|---|
| ... | e.g. container-backed integration tests, end-to-end pass | ... |

UNFILLED — the SLOW tier rows for this repository (component, what counts as slow here, and the exact command that runs only those), from the team that owns its build

<!-- serpens:section wiring-bugs -->
## Wiring bugs
Name the boundaries in this stack that ONLY the slow tier can catch (dependency injection,
serialization, configuration profiles). A task touching one of them is not done on fast-tier
green alone.

UNFILLED — the boundaries in this stack that only the slow tier catches, from the team

<!-- serpens:section debugging-order -->
## Debugging boundary order
The chain `spns-debugging` walks from symptom to cause in this stack, innermost first — e.g.
the failing unit → its direct inputs → serialization/config boundaries → stored state →
upstream systems. Name the concrete technologies at each step.

UNFILLED — the debugging boundary order for this stack, innermost first, naming the concrete technology at each step, from the team

<!-- serpens:section manual-access -->
## Manual testing access — what a tester can send, produce and query from OUTSIDE
`spns-test-plan` writes only steps a tester can actually run on the dev stand, and it names no
technology, protocol or query language this table did not supply. Answer every slot in this
repository's own terms — the words you use here are the words the plan will use.

When the answer is estate-wide rather than repository-specific, name the authoritative document
in `estate-reference` and answer `inherit` in every slot it already covers; answer here only
what differs for this repository or environment. Thirty copied estate policies drift; one
referenced document does not. `inherit` is only accepted while `estate-reference` names a
document.

Keep this table exactly three columns. A fourth column of your own would put the answer where
the gate cannot find it.

| Slot | What to answer | Answer |
|---|---|---|
| `estate-reference` | the estate-wide testing-access document this table defers to, or `none` if there is not one | UNFILLED |
| `request-client` | how a tester makes ONE direct call into the running service by hand — with what, and in what form the plan should hand them a call so they can run it — or `none` if nothing here answers a caller directly | UNFILLED |
| `request-idiom` | what a complete single call consists of here: every part a tester must be given to make one, and how permission to make it is obtained on the stand, or `none` | UNFILLED |
| `event-transport` | the asynchronous transport a tester can put a message into and observe, named, or `none` if this repository neither sends nor consumes anything asynchronously | UNFILLED |
| `event-produce-path` | the exact way a tester puts ONE message in — a command, a screen, an admin call — or `TODO(produce path)` if the estate has no sanctioned way yet, or `none` | UNFILLED |
| `event-addressing` | what names a destination here, and what — if anything — decides ordering or grouping within it, or `none` | UNFILLED |
| `event-payload-format` | the form a message body takes on the wire, and whatever travels alongside it, or `none` | UNFILLED |
| `data-stores` | every store a tester may read or seed for this repository, each named with what it holds, or `none` | UNFILLED |
| `store-query-idiom` | how a tester reads one record back out of those stores — with what, and in what form — or `none` | UNFILLED |
| `store-seed-idiom` | how a tester puts seed data in, and which of the available ways is sanctioned on the stand, or `none` | UNFILLED |
| `error-routing` | where a rejected call or an undeliverable message ends up, and how a tester sees it there, or `none` | UNFILLED |
| `observation-access` | what the stand lets a tester read about a run without changing anything, and how they reach it, or `none` | UNFILLED |
