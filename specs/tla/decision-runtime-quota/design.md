# Design: decision-runtime-quota (SystemOne S1-02 reserve/dispatch/settle ledger)

Model directory: `specs/tla/decision-runtime-quota`. Module `Model`, 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
spec `Spec`, safety-only 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  screening clause at this revision — user request "run formal-design over 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L29-L94〕
  the SystemOne design docs" 2026-11-02, full-program adoption confirmed via 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  ask_user_question; manual adoption snippet at 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  `<skill>/references/agents-snippet.md`) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- decision: **enabled** 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
- triggerIds: FD-T2 (429 retries re-reserve; the same permit never serves two 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L29-L94〕
  attempts), FD-T3 (crash recovery decides whether an unpaired reserve keeps 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L29-L94〕
  its full amount — deduplication and persistence order in the JSONL ledger), 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  FD-T4 (the `quota.lock` file is cross-crash resource ownership a human must 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L29-L94〕
  clear), plus FD-L2 (reserve = settled + in-flight conservation with 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  unknown retained as upper bound — the Lean face is tracked separately) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/decision-runtime-quota"}` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L29-L94〕.
- behavioral source: `docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  §Execution state machine, §Durable quota and concurrency, §Failure table 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  The feature is **not implemented yet**; the design doc is the semantic 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  source of truth. Existing code that constrains it: 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  `packages/llm-tuning/systemone/src/client.ts` (transport and legacy retry 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  budget), the VWA `lock.ts` torn-lock history (issue #307, deliberately 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  NOT reused here) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.

## Requirements

- **REQ-1** Every attempt reserves one attempt slot, per-attempt input and 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  output upper bounds from the global provider before dispatch; a rejected 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  reservation yields `budget` with no fetch 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- **REQ-2** The dispatch record is durable before the fetch; a failed ledger 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  write settles the attempt `not-dispatched` and performs no fetch 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- **REQ-3** Settlement is single-invocation: each attempt has at most one 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  terminal settle row; a conflicting terminal state freezes the quota 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- **REQ-4** Valid usage settles `actual` (only the difference over actual is 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  returned); timeout/unknown network settles `unknown` and keeps the full 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  reservation; only a durable `not-dispatched` entry refunds 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- **REQ-5** No free quota across crash: recovery keeps unpaired reserves at 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  their full amount; a torn tail freezes the session quota rather than 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  silently continuing; a dispatched-but-unsettled attempt keeps its full 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  reservation after recovery 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- **REQ-6** The transaction lock protects check-then-append as one critical 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  section; two concurrent requests can never over-reserve. A crashed lock 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  holder leaves the lock file, which blocks new transactions until a human 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  clears it — v1 never auto-deletes 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- **REQ-7** Caller cancellation refunds before dispatch (settled 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  `not-dispatched`) and never after dispatch (finally settles `unknown`) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- **REQ-8** Only a 429 retries, and it re-reserves (a new attempt row) under 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  the same decisionId; at most `1+max-retries` attempts per decision 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- **REQ-9** Once frozen (conflicting settle, torn tail, settle failure, 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  overrun), nothing is appended to the ledger 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.

## State variables

| Variable | Meaning 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕| Durability |
|---|---|---|
| `led` | durable JSONL rows: reserve / dispatch / settled (leaseId = did+attempt, seq-ordered) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| survives crashes |
| `torn` | the tail line of `led` was torn by a crash mid-settle 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| durable |
| `lock`, `lockFile` | in-memory transaction owner and the on-disk `quota.lock` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| owner lost on crash; file survives |
| `frozen`, `freezeSeq` | quota frozen and the highest ledger seq at freeze 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| durable |
| `runs` | the two concurrent in-flight request state machines (phase, did, attempt, planned terminal) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| lost on crash |
| `alive` | the owning process 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| lost on crash |
| `plannedTerm` | in-memory settle plan per request 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| lost on crash |

Derived accounting (no separate state): an attempt retains `actual` usage, 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
its full reservation when `unknown` or unsettled, and zero when 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
`not-dispatched`; `RetainedIn/Out/AttemptsUsed` sum over the ledger — this 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
is the accounting probe the invariants read 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.

## Coverage matrix

| Invariant | Requirement 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕| Adverse trace challenged |
|---|---|---|
| `QuotaAttempts`, `QuotaIn`, `QuotaOut` | REQ-1/6 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| two requests check-then-append interleaved (the A/B example in the design doc) |
| `DispatchAfterReserve` | REQ-2 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| dispatch appended before/without a durable reserve |
| `NotDispNoDispatch` | REQ-7 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| abort after dispatch seeking a refund |
| `SettleAtMostOnce` | REQ-3 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕| `ConflictingSettle` probe: a second, different terminal |
| `UnsettledKeepsFull`, `NoFreeDispatched` | REQ-5 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕| `RefundUnpaired` probe: recovery deletes unpaired reserves |
| `TornImpliesFrozen`, `FrozenStopsAppends` | REQ-5/9 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕| `AdoptTorn` probe: recovery continues on a torn ledger |

Invariant refinements made during checking (modeling defects, not design 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
defects — the design text governs): 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
- `TornImpliesFrozen` is `alive /\ torn => frozen`: the freeze is a 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  recovery-time decision, not a crash-time one; between crash and restart the 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  process is dead and issues no calls anyway 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- `FrozenStopsAppends` stops only new **spend** rows (reserve/dispatch) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  after `freezeSeq`; settle rows of already-reserved attempts remain 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  legitimate bookkeeping ("stop new decisions without deleting records") 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- Every ledger append (reserve, dispatch and settle rows alike) runs inside 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  the transaction lock, per the design's "reserve, settle and recovery all 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  run inside the same short transaction lock" — the model gates dispatch and 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  settle writes on a free lock exactly like reserves 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
| `AttemptsBound` | REQ-8 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| 429 → retry → re-reserve |
| `LockOwnerAlive` | REQ-6 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕| crash while holding the lock |
| `TypeOK` | — 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕| — |

Probes (expansion cases, expected counterexample — the fault switches make 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
the guarded path reachable, demonstrating the guard is load-bearing): 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
`strict-steal-lock` (mutual exclusion ignored → over-reserve), 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
`strict-adopt-torn` (torn ledger adopted → freeze violated), 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
`strict-refund-unpaired` (recovery refunds unpaired reserves → dispatched 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
attempt loses its reservation / dispatch loses its reserve row), 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
`strict-conflicting-settle` (double settlement → SettleAtMostOnce red) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.

## Bounds and assumptions

- Two concurrent requests (`p1`, `p2`), at most 4 decisionIds, at most 2 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L148-L161〕
  attempts per decision (`MAX_RETRIES=1`), fixed request shape (input 2 or 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
  none, output 1), `MAX_IN=6`, `MAX_OUT=4`, `MAX_ATTEMPTS=3` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.
- The HTTP layer is abstracted to four outcomes: valid usage (actual 2/1), 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  429, timeout, other HTTP error — the design's only billing-relevant 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  distinction. Answer-level malformedness is S1-01's concern and does not 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  change settlement (usage valid ⇒ actual even when the answer is 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  malformed) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- The lock wait/retry (100ms/20ms) and the 3000ms retry-wait budget are 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  timing concerns outside a safety model; they appear only as the budget 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  outcome on lock-file presence 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- fsync is modeled as atomic append: a torn line appears only through the 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  `Crash` action while a settle is being written 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- Liveness, `/cost` rendering, pricing, and the settings cascade are out of 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  scope 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
