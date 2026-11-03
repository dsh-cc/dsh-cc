# Implementation record: decision-runtime-quota

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02 "run formal-design over the SystemOne design docs"; full-program
scope confirmed via ask_user_question). Manual adoption snippet:
`<skill>/references/agents-snippet.md`. Formal review lanes are therefore
**not** dispatch-blocked by project rules; no formal review has been run yet.

## Final run

- runId: `20261103T020629Z-53a1d0be-b734-4395-94e4-1870d60a9264`
- inputDigest: see `evidence.json` of that run (design.md was edited before
  this final run; every earlier run below is superseded by it).
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 1,008,631 states generated, 453,664
  distinct, 0 left on queue; all 13 invariants hold.
- Probes (expansion, expected counterexample — each hits exactly its
  intended invariant, proving the guard it removes is load-bearing):
  - `strict-steal-lock` → `QuotaIn` violated (mutual exclusion removed ⇒
    interleaved check-then-append over-reserves).
  - `strict-adopt-torn` → `TornImpliesFrozen` violated (a torn ledger
    adopted by recovery keeps issuing decisions).
  - `strict-refund-unpaired` → `DispatchAfterReserve` violated (recovery
    deleting unpaired reserves breaks the dispatch→reserve pairing and
    would free quota a dispatched attempt still owes).
  - `strict-conflicting-settle` → `SettleAtMostOnce` violated (a second,
    different terminal settle double-charges the attempt).
- `check-evidence`: valid and fresh against the final run; aggregate
  `counterexample` is the expected legal form of a probe package.

## Run lineage

Earlier runs of this model (config-invalid parse fixes, then invariant
refinements) are superseded: the model went through (1) TLA+ syntax repairs
(square-bracket function definitions; record EXCEPT instead of an invented
merge operator; bracket closure after mechanical rewrites), (2) a
precedence defect where `x' = a \/ b` parsed as a disjunction — the
infamous pitfall; all disjunctive primes are now parenthesized, (3) two
modeling-defect counterexamples folded (see below). Same judging criteria
throughout: convention must verify, probes must hit their named invariant.

## Counterexample classification

All counterexamples during development were **modeling defects or
over-strong invariants, not design defects**:

1. `TornImpliesFrozen` (convention, first red): the design freezes the quota
   at *recovery time* when the ledger is read; torn-ness itself is a durable
   crash fact. Invariant refined to `alive /\ torn => frozen`.
2. `FrozenStopsAppends` (convention, second red): settle rows of
   already-reserved attempts are legitimate bookkeeping after a freeze;
   only new spend (reserve/dispatch rows) must stop. Refined accordingly.
3. Lock-gating hole (found via counterexample 2's trace): settle/dispatch
   appends were initially modeled outside the transaction lock, letting a
   freeze interleave with another request's check→append critical section.
   The design puts **all** ledger appends inside the lock; the model now
   gates every append action on a free lock.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md`
  §Execution state machine (steps 4-8), §Durable quota and concurrency,
  §Failure table. Property → design clause:
  - `QuotaIn/Out/Attempts` ← per-attempt reservation before dispatch, quota
    scope and limits table.
  - `DispatchAfterReserve`, ledger-write-failure path ← step 5.
  - `SettleAtMostOnce` ← idempotent settle, conflicting terminal freezes.
  - `UnsettledKeepsFull`, `NoFreeDispatched`, torn handling ← recovery rules
    (unpaired reserves keep their full amount; only durable not-dispatched
    refunds).
  - `NotDispNoDispatch` ← caller-abort refund window.
  - `AttemptsBound` ← 429-only retry with re-reserve.
  - `LockOwnerAlive` ← crashed lock file never auto-deleted.
- Action → planned code: `AddRow` ↔ `ledger.ts` append+fsync; `Acquire/
  CheckReserve/AppendReserve` ↔ `quota.ts` transaction; `SettleWrite/
  SettleFail` ↔ permit settle callbacks; `Crash/Recover` ↔ the three
  crash cut points named in the design's test matrix.

## Not verified (explicitly out of scope)

- Liveness (the model has no fairness; a permanently frozen quota is a
  legal terminal state by design).
- Lock wait/retry timing (100ms/20ms), the 3000ms retry-wait budget, and
  the run timeout — timing concerns.
- `/cost` rendering, pricing, dedup by eventId, settings cascade and
  trusted-source reading.
- The attemptObserver before/after cut points and S1-01 answer-level
  validation (only the billing-relevant outcome distinction is modeled).
- The Lean face of FD-L2 (reserve = settled + in-flight conservation as a
  theorem over the accounting arithmetic) is a separate model, not built
  here.

## Findings for the design (implementation-relevant, from the model work)

None that contradict the design. One emphasis the model makes explicit for
implementers: the transaction lock must cover **every** ledger append
(reserve, dispatch and settle rows alike), and freeze must be computed
inside that lock — otherwise a settle-failure freeze can interleave with
another request's passed limit check (the model's counterexample 2 trace).
This is already implied by the design's single-transaction-lock wording;
the implementation tests should pin it.
