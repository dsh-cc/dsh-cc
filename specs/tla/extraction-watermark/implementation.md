# Implementation record: extraction-watermark

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T023355Z-cd2a855c-7b5b-46c4-9794-763353706e9b`
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 2,112 states generated, 693 distinct,
  0 left on queue; all 6 invariants hold.
- Probes (expansion, expected counterexample; each hit the fault-witness
  invariant `NoFaults`, i.e. each guarded fault became reachable):
  - `strict-advance-on-start` — the watermark moving when the job starts
    rather than at `job.done=completed` (missed evidence, phantom coverage).
  - `strict-skip-no-reval` — a skip verdict committed without re-validating
    the evidence head.
  - `strict-cooldown-auto-retry` — a timer retrying the failed window
    without a later stop.
  - `strict-lease-double-owner` — dream taking the mutation lease while
    extraction holds it.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development failures were **modeling defects**, never design defects:

1. SANY rejected the file with a phantom `-.` operator error: the cause was
   UTF-8 em-dashes inside block comments — replace with ASCII `--`
   (new toolchain pitfall, recorded for future models).
2. `Max` is not a built-in TLA+ operator — a helper had to be defined.
3. The lease probes were initially vacuous twice over: (a) every
   lease-taking action required `phase # "extracting"`, which is exactly
   the state where the other owner holds the lease, so the double-owner
   fault was unreachable; (b) the same actions assigned `faults'` and also
   listed `faults` in UNCHANGED, a contradictory conjunction that disables
   the action entirely. Both fixed; the probe then hit on the first run.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md`
  — the coordinator section (phases, watermark commit "only completed sets
  `reviewedThrough=max(previous, capturedHead)`", cooldown "only triggered
  by a later stop; no automatic retry timer", drain) and the mutation-lease
  section (single owner per dir, dream's tryAcquire-before-disk-lock rule).
- Property → clause: `WmWithinCaptured`/`PendingNeverLost` ← the commit and
  drain rules; `NoLeaseAfterTerminal` ← finally-releases; `RunningSound` ←
  the jobDone lifecycle; `NoFaults` ← the four probe-guarded hazards.
- Action → planned code: `Stop`/`CooldownRetry` ↔ turn-stopping and the
  cooldown lift; `GateSkip`/`GateNeedLease` ↔ the decision gate and
  re-validation; `AcquireLease`/`DreamTakesLease`/`DreamReleases` ↔
  `mutation-lease.ts`; `JobCompleted`/`JobFailed`/`JobKilled` ↔
  `await job.done` handling in `extraction-coordinator.ts`; `Takeover` ↔
  the new-owner restart at watermark -1.

## Not verified (explicitly out of scope)

- Judgement quality: skip-probability thresholds, shadow-mode comparison
  records, and the "would the fork have been skipped" ledger.
- Window construction: reconstructability, maxStateBytes, the whole-session
  fallback prompt — only their effect on the watermark is modeled.
- The dream lock protocol beyond the local-lease layer (disk lock, rollback
  of the original disk lock, lastConsolidatedAt) — see
  specs/tla/background-task-lifecycle for the dream job semantics.
- Timing: failureCooldownMs durations, microtask drain latency; the model
  keeps only the ordering (cooldown lifts only on a stop).
- Liveness: a cooldown that no stop ever lifts is a legal terminal state.
