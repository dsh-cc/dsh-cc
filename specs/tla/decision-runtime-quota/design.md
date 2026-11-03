# Design: decision-runtime-quota (SystemOne S1-02 reserve/dispatch/settle ledger)

Model directory: `specs/tla/decision-runtime-quota`. Module `Model`,
spec `Spec`, safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request "run formal-design over
  the SystemOne design docs" 2026-11-02, full-program adoption confirmed via
  ask_user_question; manual adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T2 (429 retries re-reserve; the same permit never serves two
  attempts), FD-T3 (crash recovery decides whether an unpaired reserve keeps
  its full amount — deduplication and persistence order in the JSONL ledger),
  FD-T4 (the `quota.lock` file is cross-crash resource ownership a human must
  clear), plus FD-L2 (reserve = settled + in-flight conservation with
  unknown retained as upper bound — the Lean face is tracked separately).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/decision-runtime-quota"}`.
- behavioral source: `docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md`
  §Execution state machine, §Durable quota and concurrency, §Failure table.
  The feature is **not implemented yet**; the design doc is the semantic
  source of truth. Existing code that constrains it:
  `packages/llm-tuning/systemone/src/client.ts` (transport and legacy retry
  budget), the VWA `lock.ts` torn-lock history (issue #307, deliberately
  NOT reused here).

## Requirements

- **REQ-1** Every attempt reserves one attempt slot, per-attempt input and
  output upper bounds from the global provider before dispatch; a rejected
  reservation yields `budget` with no fetch.
- **REQ-2** The dispatch record is durable before the fetch; a failed ledger
  write settles the attempt `not-dispatched` and performs no fetch.
- **REQ-3** Settlement is single-invocation: each attempt has at most one
  terminal settle row; a conflicting terminal state freezes the quota.
- **REQ-4** Valid usage settles `actual` (only the difference over actual is
  returned); timeout/unknown network settles `unknown` and keeps the full
  reservation; only a durable `not-dispatched` entry refunds.
- **REQ-5** No free quota across crash: recovery keeps unpaired reserves at
  their full amount; a torn tail freezes the session quota rather than
  silently continuing; a dispatched-but-unsettled attempt keeps its full
  reservation after recovery.
- **REQ-6** The transaction lock protects check-then-append as one critical
  section; two concurrent requests can never over-reserve. A crashed lock
  holder leaves the lock file, which blocks new transactions until a human
  clears it — v1 never auto-deletes.
- **REQ-7** Caller cancellation refunds before dispatch (settled
  `not-dispatched`) and never after dispatch (finally settles `unknown`).
- **REQ-8** Only a 429 retries, and it re-reserves (a new attempt row) under
  the same decisionId; at most `1+max-retries` attempts per decision.
- **REQ-9** Once frozen (conflicting settle, torn tail, settle failure,
  overrun), nothing is appended to the ledger.

## State variables

| Variable | Meaning | Durability |
|---|---|---|
| `led` | durable JSONL rows: reserve / dispatch / settled (leaseId = did+attempt, seq-ordered) | survives crashes |
| `torn` | the tail line of `led` was torn by a crash mid-settle | durable |
| `lock`, `lockFile` | in-memory transaction owner and the on-disk `quota.lock` | owner lost on crash; file survives |
| `frozen`, `freezeSeq` | quota frozen and the highest ledger seq at freeze | durable |
| `runs` | the two concurrent in-flight request state machines (phase, did, attempt, planned terminal) | lost on crash |
| `alive` | the owning process | lost on crash |
| `plannedTerm` | in-memory settle plan per request | lost on crash |

Derived accounting (no separate state): an attempt retains `actual` usage,
its full reservation when `unknown` or unsettled, and zero when
`not-dispatched`; `RetainedIn/Out/AttemptsUsed` sum over the ledger — this
is the accounting probe the invariants read.

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `QuotaAttempts`, `QuotaIn`, `QuotaOut` | REQ-1/6 | two requests check-then-append interleaved (the A/B example in the design doc) |
| `DispatchAfterReserve` | REQ-2 | dispatch appended before/without a durable reserve |
| `NotDispNoDispatch` | REQ-7 | abort after dispatch seeking a refund |
| `SettleAtMostOnce` | REQ-3 | `ConflictingSettle` probe: a second, different terminal |
| `UnsettledKeepsFull`, `NoFreeDispatched` | REQ-5 | `RefundUnpaired` probe: recovery deletes unpaired reserves |
| `TornImpliesFrozen`, `FrozenStopsAppends` | REQ-5/9 | `AdoptTorn` probe: recovery continues on a torn ledger |

Invariant refinements made during checking (modeling defects, not design
defects — the design text governs):
- `TornImpliesFrozen` is `alive /\ torn => frozen`: the freeze is a
  recovery-time decision, not a crash-time one; between crash and restart the
  process is dead and issues no calls anyway.
- `FrozenStopsAppends` stops only new **spend** rows (reserve/dispatch)
  after `freezeSeq`; settle rows of already-reserved attempts remain
  legitimate bookkeeping ("stop new decisions without deleting records").
- Every ledger append (reserve, dispatch and settle rows alike) runs inside
  the transaction lock, per the design's "reserve, settle and recovery all
  run inside the same short transaction lock" — the model gates dispatch and
  settle writes on a free lock exactly like reserves.
| `AttemptsBound` | REQ-8 | 429 → retry → re-reserve |
| `LockOwnerAlive` | REQ-6 | crash while holding the lock |
| `TypeOK` | — | — |

Probes (expansion cases, expected counterexample — the fault switches make
the guarded path reachable, demonstrating the guard is load-bearing):
`strict-steal-lock` (mutual exclusion ignored → over-reserve),
`strict-adopt-torn` (torn ledger adopted → freeze violated),
`strict-refund-unpaired` (recovery refunds unpaired reserves → dispatched
attempt loses its reservation / dispatch loses its reserve row),
`strict-conflicting-settle` (double settlement → SettleAtMostOnce red).

## Bounds and assumptions

- Two concurrent requests (`p1`, `p2`), at most 4 decisionIds, at most 2
  attempts per decision (`MAX_RETRIES=1`), fixed request shape (input 2 or
  none, output 1), `MAX_IN=6`, `MAX_OUT=4`, `MAX_ATTEMPTS=3`.
- The HTTP layer is abstracted to four outcomes: valid usage (actual 2/1),
  429, timeout, other HTTP error — the design's only billing-relevant
  distinction. Answer-level malformedness is S1-01's concern and does not
  change settlement (usage valid ⇒ actual even when the answer is
  malformed).
- The lock wait/retry (100ms/20ms) and the 3000ms retry-wait budget are
  timing concerns outside a safety model; they appear only as the budget
  outcome on lock-file presence.
- fsync is modeled as atomic append: a torn line appears only through the
  `Crash` action while a settle is being written.
- Liveness, `/cost` rendering, pricing, and the settings cascade are out of
  scope.
