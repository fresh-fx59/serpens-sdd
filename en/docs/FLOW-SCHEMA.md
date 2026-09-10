# Serpens SDD flow — schema

> The one-screen view. The full workflow reference, with the per-command table, is
> [`FLOW.md`](FLOW.md), and the wide per-step table is [`FLOW-TABLE.md`](FLOW-TABLE.md);
> installation is [`SETUP.md`](SETUP.md), upgrading is [`UPGRADE.md`](UPGRADE.md), and daily
> use is [`OPERATIONS.md`](OPERATIONS.md).

```text
Story / request
  │
  ▼
1. SPECIFY  — Analyst, spns-spec
  input:   intent only, or a story + wiki + living specification + current code
  first:   when given intent only, triage it with the user before specification
  output:  proposal + delta specification + research + branch + commit + pull request
  gate:    checks green and `validate --type change --strict --json` says "valid": true,
           in every affected repository
  │
  ▼
2. PLAN  — Developer, spns-plan
  input:   approved delta + current code
  output:  design.md (<200 lines) + risk-first tasks.md, committed by the command
  gate:    checks pass; developer approves the plan
  │
  ▼
3. IMPLEMENT  — Developer, spns-implement
  loop:    failing scenario test → smallest change → fast tests → refactor
  output:  code + tests + checked tasks + test evidence, in ONE commit at the end
  gate:    all tasks complete; full suite and final checks pass; work pushed
  │
  ▼
4. REVIEW  — Reviewer, spns-review
  checks:  coverage → spec fit → test honesty → correctness → scripted checks
  output:  findings with severity, file:line, and fix; or clean result
  gate:    blockers fixed and verification re-run
  │
  ├─────────────────────────────┐
  ▼                             ▼
5. BLACK-BOX TEST PLAN          6. AUTOMATED TEST SCAFFOLDS
  input: approved scenarios       input: approved scenarios
  output: runnable plan on the    output: one behaviour test skeleton per scenario
          same ticket             notes: missing setup stays TODO; run what can run
  notes: regression + exploratory;
         drift between spec and the built system STOPS the plan
         and asks the user: amend the delta, or file a defect
  └──────────────┬──────────────┘
                 ▼
7. ARCHIVE AFTER MERGE  — Developer or release owner, spns-archive
  input:   merged pull request + final evidence
  output:  living specs + ADR + index, in a `docs(<TICKET>): archive …` commit
  gate:    merge is complete; assert-archivable passes; records are retained
```

## Rules carried through every stage

- The OpenSpec proposal, delta specification, and task list are the delivery contract.
- A completed claim needs fresh evidence.
- A mismatch between specification and code stops work until it is classified.
- Documentation changes run the repository verification checks: `verify-docs.sh`, which runs the
  index check, `serpens-lint.mjs`, and the contract-split check — the last one reading each store's
  living specs AND the deltas and `store-contract.md` of its active changes, so it also covers the
  cross-repo window before the contract is archived.
- `serpens-lint.mjs` also refuses an unfilled `port-facts.md`: a `P`-row still holding the template
  placeholder `...`, or the template header `<port name + version> (probed YYYY-MM-DD)`, is an
  error, because the whole install derives from that file.
- Every asserting mode of `repository-state.sh` refuses a repository that does not own its own
  OpenSpec root (`✗ OpenSpec root is not this repository` · `↳ resolved root: <path>`); `inspect`
  only reports it. The branch-name guard runs at pre-commit as well as pre-push, because a
  new-branch push carries no listable files and lefthook skips the pre-push copy.
- OpenSpec is the authority on delta-spec grammar: every command that writes or reviews a spec
  runs `<openspec> validate <change-id> --type change --strict --json`. The lint keeps only what
  the CLI is blind to — including a `MODIFIED`/`REMOVED`/`RENAMED` delta with no living spec to
  act on, which validates as `"valid": true` and only fails at `openspec archive`, after merge.
- Each command finishes its own Git work: staged BY PATH, committed, pushed. Never `git add -A`.
- Humans approve plans, execute manual testing, approve, and merge; automation does not claim those actions.
