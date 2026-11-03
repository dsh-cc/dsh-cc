# Implementation record: extraction-watermark

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T024610Z-60918a9a-4dbb-489a-b8ee-d21d66e724f4` (freshness re-run after the M3 revision commit; identical statistics per case — see Run lineage)
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 2,112 states generated, 693 distinct,
  0 left on queue; all 7 invariants hold. A dedicated reachability
  diagnostic confirms `phase = "extracting"` is reachable in the convention
  constants, so the job lifecycle is not vacuously verified.
- Probes (expansion, expected counterexample; each adds exactly its own
  fault witness to `faults`, breaking `NoFaults`):
  - `strict-advance-on-start` → the watermark moves when the job starts
    (violates the job.done completion boundary).
  - `strict-skip-no-reval` → a skip verdict commits after the evidence
    head moved past the captured window.
  - `strict-cooldown-auto-retry` → a phantom timer retries the same failed
    cooldown window with no new stop.
  - `strict-lease-double-owner` → a second owner takes the lease while
    extraction/dream still holds it.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development counterexamples and errors were **modeling defects**, never
design defects:

1. TLA+/Naturals has no unary minus: `-1` and `-1..3` lexed as a real
   literal `-1.`; the initial watermark sentinel became `WmInit == 0` with
   evidence heads renumbered from 1.
2. `Takeover` fired unboundedly from Init, exhausting the `gen` type bound;
   bounded at `gen < 3`.
3. `Dispose` originally kept `leaseOwner` and left `jobDone = "running"`
   — the design requires dispose to abort the job and release/cancel the
   lease (found via `NoLeaseAfterTerminal`).
4. Branch-local primed assignments (faults only assigned on one side of an
   IF) left successors incompletely specified; each action now assigns
   `faults'` unconditionally.
5. **Vacuous-verification trap (the important one)**: listing `faults` in
   both a primed assignment and UNCHANGED made the lease-acquisition
   actions self-contradictory; TLC silently disabled them and the first
   "verified" convention run never started extraction. The double-owner
   probe (which initially verified) exposed it. After the fix, the probe
   red at 38 states and the convention remains verified with an explicit
   extracting-reachability check.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md`
  — coordinator phases, "only completed sets
  reviewedThrough=Math.max(previous, capturedHead)", "failed enters
  cooldown … the cooldown is only triggered by a later stop; no automatic
  retry timer", "a new stop during gating or waiting-lease only overwrites
  pendingHead", skip re-validation ("recompute the current evidence head …
  require them to equal the captured ones"), lease section ("at most one
  owner per dir"), takeover ("create the new state at watermark -1").
- Action → planned code: `Stop`/`CooldownRetry` ↔ the turn-stopping
  listener; `GateSkip`/`GateNeedLease` ↔ `extraction-coordinator.ts`'s
  gate; `AcquireLease`/`DreamTakesLease`/`DreamReleases` ↔
  `mutation-lease.ts`; `JobCompleted`/`JobFailed`/`JobKilled` ↔ the
  `job.done` settlement; `Takeover` ↔ the per-key Agent rebinding;
  `Dispose` ↔ plugin/Agent disposal.

## Not verified (explicitly out of scope)

- Window reconstruction, maxStateBytes and the whole-session fallback
  prompt path (the design's "do not fake a complete window" branch is
  modeled only as GateNeedLease).
- The probability judgement (skip vs extract) is a nondeterministic
  choice; thresholds are out of scope.
- Shadow-vs-active mode differences and shadow's tightened concurrency
  timing.
- The sessionStateCap LRU eviction of idle states.
- The disk lock and `lastConsolidatedAt` interaction with dream; only the
  in-plugin mutation lease is modeled.
- Liveness (a permanently cooldown state is legal by design — only a
  later stop retries it).
- S1-02 metering.
