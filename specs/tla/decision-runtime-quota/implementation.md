# Implementation record: decision-runtime-quota

Effective project rules at modeling time: the root AGENTS.md carries **no** 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
formal-design screening clause — screening is session-adopted (user request 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L29-L94〕
2026-11-02 "run formal-design over the SystemOne design docs"; full-program 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
scope confirmed via ask_user_question). Manual adoption snippet: 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
`<skill>/references/agents-snippet.md`. Formal review lanes are therefore 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
**not** dispatch-blocked by project rules; no formal review has been run yet 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.

## Final run

- runId: `20261103T064405Z-edee9f4e-eba2-47fd-8e32-cbc4df4ef235` (r4 fold rerun) (r3 fold rerun) (review-fold rerun; the lock/freeze remodel raised the state count) (marker-only
  backfill of 〔src:ws:〕 evidence annotations in design.md; identical model
  bytes, identical case statistics per case — superseded run
  `20261103T020629Z-53a1d0be-b734-4395-94e4-1870d60a9264` had the same
  judging outcome). 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
- inputDigest: see `evidence.json` of that run (design.md was edited before 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  this final run; every earlier run below is superseded by it) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- convention (core): **verified** — 1,008,631 states generated, 453,664 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  distinct, 0 left on queue; all 13 invariants hold 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.
- Probes (expansion, expected counterexample — each hits exactly its 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
  intended invariant, proving the guard it removes is load-bearing): 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
  - `strict-steal-lock` → `QuotaIn` violated (mutual exclusion removed ⇒ 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
    interleaved check-then-append over-reserves) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `strict-adopt-torn` → `TornImpliesFrozen` violated (a torn ledger 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
    adopted by recovery keeps issuing decisions) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `strict-refund-unpaired` → `DispatchAfterReserve` violated (recovery 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
    deleting unpaired reserves breaks the dispatch→reserve pairing and 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
    would free quota a dispatched attempt still owes) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `strict-conflicting-settle` → `SettleAtMostOnce` violated (a second, 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
    different terminal settle double-charges the attempt) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- `check-evidence`: valid and fresh against the final run; aggregate 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  `counterexample` is the expected legal form of a probe package 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.

## Run lineage

Earlier runs of this model (config-invalid parse fixes, then invariant 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕
refinements) are superseded: the model went through (1) TLA+ syntax repairs 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
(square-bracket function definitions; record EXCEPT instead of an invented 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
merge operator; bracket closure after mechanical rewrites), (2) a 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
precedence defect where `x' = a \/ b` parsed as a disjunction — the 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
infamous pitfall; all disjunctive primes are now parenthesized, (3) two 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
modeling-defect counterexamples folded (see below). Same judging criteria 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L148-L161〕
throughout: convention must verify, probes must hit their named invariant 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.

## Counterexample classification

All counterexamples during development were **modeling defects or 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L148-L161〕
over-strong invariants, not design defects**: 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕

1. `TornImpliesFrozen` (convention, first red): the design freezes the quota 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
   at *recovery time* when the ledger is read; torn-ness itself is a durable 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
   crash fact. Invariant refined to `alive /\ torn => frozen` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L113-L128〕.
2. `FrozenStopsAppends` (convention, second red): settle rows of 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
   already-reserved attempts are legitimate bookkeeping after a freeze; 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
   only new spend (reserve/dispatch rows) must stop. Refined accordingly 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
3. Lock-gating hole (found via counterexample 2's trace): settle/dispatch 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
   appends were initially modeled outside the transaction lock, letting a 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
   freeze interleave with another request's check→append critical section 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
   After the review fold, every append action (dispatch, settle, settle-fail,
   abort) is remodeled as an acquire-append-release transaction that holds
   the lock while it writes — the same discipline the design prescribes for
   reserve rows — and the freeze is computed with the lock held.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md` 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  §Execution state machine (steps 4-8), §Durable quota and concurrency, 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  §Failure table. Property → design clause: 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L148-L161〕
  - `QuotaIn/Out/Attempts` ← per-attempt reservation before dispatch, quota 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
    scope and limits table 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L148-L161〕.
  - `DispatchAfterReserve`, ledger-write-failure path ← step 5 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `SettleAtMostOnce` ← idempotent settle, conflicting terminal freezes 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `UnsettledKeepsFull`, `NoFreeDispatched`, torn handling ← recovery rules 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
    (unpaired reserves keep their full amount; only durable not-dispatched 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
    refunds) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
  - `NotDispNoDispatch` ← caller-abort refund window 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `AttemptsBound` ← 429-only retry with re-reserve 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
  - `LockOwnerAlive` ← crashed lock file never auto-deleted 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.
- Action → planned code: `AddRow` ↔ `ledger.ts` append+fsync; `Acquire/ 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  CheckReserve/AppendReserve` ↔ `quota.ts` transaction; `SettleWrite/ 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  SettleFail` ↔ permit settle callbacks; `Crash/Recover` ↔ the three 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  crash cut points named in the design's test matrix 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕.

## Not verified (explicitly out of scope)

- Liveness (the model has no fairness; a permanently frozen quota is a 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  legal terminal state by design) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- Lock wait/retry timing (100ms/20ms), the 3000ms retry-wait budget, and 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  the run timeout — timing concerns 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- `/cost` rendering, pricing, dedup by eventId, settings cascade and 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  trusted-source reading 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- The attemptObserver before/after cut points and S1-01 answer-level 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  validation (only the billing-relevant outcome distinction is modeled) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.
- The Lean face of FD-L2 (reserve = settled + in-flight conservation as a 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
  theorem over the accounting arithmetic) is a separate model, not built 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
  here 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.

## Findings for the design (implementation-relevant, from the model work)

None that contradict the design. One emphasis the model makes explicit for 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕
implementers: the transaction lock must cover **every** ledger append 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
(reserve, dispatch and settle rows alike), and freeze must be computed 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
inside that lock — otherwise a settle-failure freeze can interleave with 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
another request's passed limit check (the model's counterexample 2 trace) 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L148-L161〕.
The design now states this normatively in its durable-quota section; 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L130-L138〕
the implementation tests should pin it 〔src:ws:docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md#L100-L111〕.

## r3 fold (r2 delta review)

- `settleFailed` ghost + `FreezeSurvivesSettleFailure`: a settle failure
  always leaves a durable blocking mechanism (the persisted freeze row or
  the kept lock file); the `strict-freeze-row-lost` probe drops both and
  hits it.
- `attempt-ceiling-binds` core case: with `MAX_IN=8` the attempt ceiling
  (`QuotaAttempts`) binds before the input-token ceiling, verified
  9,810,866 states.
- `Recover`'s torn-freeze boundary now matches `SettleFail`'s
  (`freezeSeq = seqN - 1`).

## r4 fold (r3 delta review)

- `StopArriveCompleted`'s twin fixed in moa-acceptance-judge (see there);
  quota-side: `Recover`'s torn-freeze boundary aligned to `seqN - 1`
  (the record previously claimed this; the operator now matches).
- `HumanClearLock` durably establishes the freeze before unlocking
  (`frozen' = frozen ∨ settleFailed` unless the `ClearWithoutFreeze`
  probe skips it); the `strict-freeze-row-lost` case now also exercises
  the clear-without-freeze hazard.
- `attempt-ceiling-binds` raises `MAX_OUT` to 4 so four charged attempts
  fit both token ceilings and only the attempt guard blocks the fourth.

