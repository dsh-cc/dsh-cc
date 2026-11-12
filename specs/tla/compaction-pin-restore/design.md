# Design: compaction-pin-restore (input-governance doc 2 pinning lifecycle)

- Program: context-engineering input governance (docs/plans/2026-11-12-compaction-governed-pinning.md)
- Model: `specs/tla/compaction-pin-restore`
- Status: modeling in progress

## Formal design screening

Session-adopted (no formal-design screening clause in the project rules at this
revision; adoption snippet at `<skill>/references/agents-snippet.md`).
Enabled: FD-T1 (engine and pinning plugin are independent actors co-writing the
session surface), FD-T2 (late/duplicate shadow and restore events), FD-T3 (the
summary-before-commit failure window decides phantom vs lost restores).
Backends: `tla` only.

## Requirements

R1 (capture): every `user/message` event with a pinned source kind enters a
bounded ring (capacity `MaxPinned`, arbitrary-eviction abstraction of FIFO).

R2 (detect): a `compaction/summary` carrying `shadowedSeqs` schedules restores
keyed by `compactionId` (restorable = shadowed pins ∩ ring at summary time).
The summary is **provisional**: it is appended before the checkpoint commit,
so a logged summary does not imply an actual shadowing.

R3 (belt): a `compaction/end` carrying `error` cancels the pending schedule.

R4 (restore eligibility): rule (a) — a successful end makes the schedule
restorable in the same drain; rule (b) — a schedule with no end of any kind
becomes restorable after one turn, **gated on the compaction actually having
committed a checkpoint** (the fixed design; `RequireCheckpoint=FALSE` is the
original-draft probe).

R5 (drain): restores append verbatim pinned messages, ascending original seq,
one append each; restored messages re-enter the capture ring; the drain runs
at the end of every pre-step tick.

R6 (no-loss): a pin shadowed by a committed compaction while captured
(`promised`) is restored by the next drain, or the one after when only
rule (b) can apply (F2 window).

## State variables

| variable | meaning |
|---|---|
| `surface` | sequence of nodes `[k, p, c]` — pin/noise/checkpoint/restore; positions are surface seqs |
| `ring` | captured pin ids (≤ MaxPinned) |
| `cPhase` | engine transaction: idle → logged → committed/failed → idle |
| `curCid/nextCid/cStart/cEnd/cShadow` | in-flight compaction identity, span, shadowed pins |
| `schedules` | pending restores `[cid, rs, at]` |
| `endOk/endErr` | cids with successful / error ends |
| `committed` | cids that actually appended a checkpoint |
| `shadowedLog` | per-cid pins actually shadowed at commit |
| `promised` / `lastShadow` | no-loss accounting (pins owed a restore; shadowing tick) |
| `tickCount` | drain clock |
| `faults` | bookkeeping of fired failure arms |

## Coverage matrix (actions × cases)

| action | convention | blind-rule-b | no-restore | belt-off-blind | belt-off-fixed | ring-eviction |
|---|---|---|---|---|---|---|
| ArrivePin / ArriveNoise | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (eviction) |
| StartCompaction (span nondeterminism) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CommitCheckpoint (F2/F3 arm) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| FailBeforeCommit (F1/F3 arm) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| AppendEndOk / AppendEndError / AppendEndFails | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tick (drain + GC) | ✓ | ✓ | disabled | ✓ | ✓ | ✓ |

Fault switches: `RequireCheckpoint` (rule-b checkpoint gate), `RestoreEnabled`
(drain effect), `BeltEnabled` (end-error cancellation + endErr exclusion),
`MaxPinned` (ring capacity).

## Invariants

- `NoPhantom`: every restore node corresponds to a pin actually shadowed by a
  checkpoint that really committed (`cid ∈ committed ∧ p ∈ shadowedLog[cid]`).
  Business property: the plugin never injects governance content that the
  engine never shadowed; violation duplicates live governance messages.
- `AtMostOneLivePerPin`: at most one live node per pin id. Violation = a
  phantom restore stacking on a live original.
- `NoStalePromise`: every promised pin is restored within one drain after the
  shadowing tick (the rule-(b) window consumes exactly that budget).
  Violation = governance constraints silently lost to compaction.
- `ScheduleAccounting`: a non-eligible schedule never survives past the
  rule-(b) window + GC budget.

## Bounds and assumptions

- A1 (synchronous transaction): the engine's summary→checkpoint→end appends
  run inside one synchronous call; other actions are blocked while
  `cPhase ≠ idle`. Faithful to `commitCompactionBody` (no yields).
- A2 (span abstraction): a compaction selects any contiguous surface span —
  the real engine's pressure-based selection is subsumed by nondeterminism.
- A3 (excluded: crash-resume): process death between summary and commit
  leaves a dead in-memory schedule; on resume the plugin's ring is empty
  (documented accepted limitation of the design; producer re-fire is the
  recovery). Not modeled.
- A4 (excluded: in-request compaction): overflow/model-switch compactions
  run inside `buildRequest`; the accepted one-request pin gap is documented
  in the design doc. Not modeled.
- A5 (arrival dedup): `ArrivePin` is blocked while the pin is live or
  promised — producer-side latches and the doc-7 dedupe cover re-arrival;
  modeled as a guard.
- A6 (eviction abstraction): over-capacity ring admission evicts all other
  captured pins (FIFO order is not modeled; the promise accounting is
  unaffected because eviction is decided at arrival, before any shadowing).
- Bounds: 2 pins, ≤2 noise nodes, surface ≤6, 3 compaction ids, 6 ticks.

## Adverse traces the model must produce (probes)

- **P1 blind-rule-b** (`RequireCheckpoint=FALSE`): F3 (checkpoint append
  fails AND the error-end append fails) leaves a summary with no commit; the
  drafted rule (b) restores after one turn → phantom restore of never-shadowed
  pins → `NoPhantom` violated. Expected counterexample.
- **P2 no-restore** (`RestoreEnabled=FALSE`): committed shadowing with the
  drain disabled → `NoStalePromise` violated. Expected counterexample.
- **P3 belt-off-blind** (`BeltEnabled=FALSE ∧ RequireCheckpoint=FALSE`): the
  F1 single failure (checkpoint fails, error-end is appended) already yields
  a phantom — the belt was the only guard in the drafted design. Expected
  counterexample.
- **X1 belt-off-fixed** (green by design): with the checkpoint gate in
  place, disabling the belt alone is safe — the gate subsumes the belt
  (defense-in-depth finding recorded for the implementation: keep both).
- **X2 ring-eviction** (green by design): with `MaxPinned=1`, the evicted
  pin is never promised → no-loss is vacuous for it (documented semantics:
  producer re-fire is the recovery).
