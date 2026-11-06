# Implementation record — subagent-lifecycle v2

Keyed to the final run below. Not part of `inputDigest`.

## Runner and toolchain

- runner `@dsh-cc/plugin-dsh-cc-agents@0.9.3-rc.4`, TLC 1.7.4 (bundled JAR),
  Java 25 on darwin, fixed runner flags per case.

## Final run

- runId `20261103T054033Z-78489973-ac95-4adf-8aa8-93d90c9778b5`
- inputDigest `5eb434ffd9a77bc9…`
- `convention` **verified**: 8,580,952 states generated, 703,026 distinct,
  0 left on queue.
- three expansion probes each produced their expected counterexample.

## Why v2 (the drift account)

The v1 model was last revised for PR #301. The harness 0.2.1-rc.5 migration
(PR #317) then deleted the dsh-cc running-count guard entirely, so v1's R-1 was
proving a property of code that no longer exists:

- `assertLiveCapacity` is gone; `acquireLiveCapacity`
  (`task/src/live-capacity.ts:64-68`) only takes the admission lease and performs
  no capacity check.
- `admitContinuation` (`resume-pins/src/live-capacity.ts:45-64`) always returns
  `admitted: true`, so the continuation-side refusal branch in
  `dispatch-admission.ts:19` is dead code.
- the `CapacityObservable` seam read and the `strict-cap-unobservable` probe
  modeled a code path with no call site.

What v1 got right and is carried over: the per-parent FIFO admission lease, the
dispatch admission at `tools/execute`, the tombstone gate, the grace arm/fire
semantics, the release marker algebra, the promotion guard, the session-exit
drain, and the `SplitContinue` residual.

## What changed

- the capacity resource is now the harness pool's **resident activations**
  (`slotHolder`, one slot per resident activation, returned at disposal), not a
  running-child count;
- `SpawnAtomic` and `ContinueAdmit` take a slot; `Settle`, `ReleaseFinish` and
  `SessionExit` return it; `FollowUp` takes none (the follow-up exemption);
- `CapacityObservable` and the `strict-cap-unobservable` case are deleted;
- two probes are new: `strict-cap-overshoot` (the pool ignoring its own cap) and
  `strict-slot-leak` (a disposal that does not return the slot).

## Counterexample dispositions

| Case | Invariant | Firing step | Disposition |
|---|---|---|---|
| strict-cap-overshoot | `CapOK` | `SpawnAtomic` past the cap under `CapIgnored` | pins that the pool's refusal is the load-bearing guard |
| strict-slot-leak | `SlotIsActivation` | `ReleaseFinish` keeps the slot under `SkipSlotRelease` | pins that disposal is the only correct slot release |
| strict-late-continue | `NoLateEpoch` | a grace fire between the pre-execute gate and the delivery | the documented accepted residual (`release.ts:110-117`) |

## Review folds (cold review r1, GO-WITH-CHANGES)

1. **P1 — the follow-up exemption was atomic, so it could not fail.** The code
   holds the admission lease through message acceptance, not the child's epoch,
   and a running target may settle while the delivery waits
   (`resume-pins/src/live-capacity.ts:44-47`). `FollowUp` is now three actions:
   `FollowUpStart`, `FollowUpDeliver` (no slot if the target is still idle, a
   pool slot and a cold resume if it settled) and `FollowUpRefused` (released,
   no slot, no registry row or the tombstone gate). REQ-3 is restated to match.
   A cold resume without its slot would now break `SlotIsActivation`.
2. **P2 — `Promote` accepted a settled child**, which `epoch-collector.ts:288`
   refuses (`settled || promoted`); the guard now admits only a live
   activation.
3. **P2 — the coverage language overstated the probes**: `strict-cap-overshoot`
   shows the invariant breaks if the pool ignored its cap; it is arithmetic
   over the model, not evidence about the harness. Both the matrix row and the
   disposition table now say so.
4. **P2 — the cooperative eviction window** on the `release_agent` path is now
   a declared exclusion (E-3) rather than only excused for the drain.

## Review folds (cold review r2 delta, GO-WITH-CHANGES)

1. **P1 — `FollowUpDeliver`'s settled branch did not mirror `ContinueAdmit`'s
   bookkeeping**: a tombstoned ready child admitted via the follow-up lane kept
   its tombstone and never recorded a late epoch, so `TombstoneNonLive` was
   violable under `SplitContinue` through a class absent from the disposition
   table, and `NoLateEpoch` understated the residual it exists to measure. The
   ready branch now clears `tombstoned`, drops `gracePending` and records
   `lateEpoch` exactly as `ContinueAdmit` does.
2. **P2 — `FollowUpStart` accepted only an idle target**, while the code's
   named window is a running target settling mid-delivery
   (`resume-pins/src/live-capacity.ts:44-47`); it now accepts running or idle.

## Review folds (external three-seat r1, 2026-11-03: critic GWC / grok GWC /
codex GWC)

1. **P1 (both seats) — `SessionExit` assigned `followPending' = {}` while also
   listing it in `UNCHANGED`**, a contradictory conjunction (TLC 2143 warning);
   mathematically the exit was disabled whenever a delivery was pending. The
   assignment is now the only one.
2. **P1 (both seats) — `FollowUpDeliver` re-checked the tombstone at
   delivery**, a second gate production does not perform
   (`dispatch-admission.ts:18-23` goes straight to delivery after admission).
   The gate moved to `FollowUpStart` (where production checks it once,
   `plugin.ts:311`), and the fresh-admission lane `ContinueAdmit` was split
   the same way (`ContinueStart` / `ContinueDeliver` / `ContinueRefused`), so
   the grace-fire race between the gate and the delivery is now the modeled
   behaviour on BOTH lanes. A late epoch on these lanes is accepted
   production behaviour and is recorded only under the `SplitContinue` probe,
   whose witness is now exactly the documented race
   (`FollowUpStart → Settle → GraceFire → ContinueDeliver`).
3. **P2 — the previously claimed `FollowUpStart` running-target fix had never
   landed** (the editing script failed before writing and the claim was not
   grep-verified before committing). It is now actually applied
   (`status[c] \in {"running", "idle"}`).
4. **P2 — `NoResurrect`'s protection is misattributed** in the matrix: the
   pre-execute gate checks `isTombstoned` only; the release markers are
   enforced by the registry-row deletion plus the model's admission guards.
   The matrix now says so.
5. **P2 — promotion eligibility** uses live status where production uses the
   collector-local `settled || promoted`; recorded as a stated limitation
   (`PromotedIsBackground` establishes tier preservation, not eligibility).
6. **P2 — a product inconsistency was found**: `release.ts:447` says idle
   residents hold no slot and only running children count, contradicting the
   resident-slot contract (`live-capacity.ts:21-25`). Tracked as an issue. Resolved by the issue #337 fix (copy now states the slot is freed).

## Modeling defects found while drafting (fixed)

1. the model deadlocked at the drained terminal because there was no explicit
   self-loop (the runner forbids disabling deadlock checking). Added `Idle`,
   enabled only when `drained`.

## Run lineage

| runId | Outcome | Note |
|---|---|---|
| `20261103T025906Z-537ab7d9` | counterexample (deadlock) | missing terminal self-loop (defect 1) |
| `20261103T025933Z-3327ea2d` | verified (convention), three probes red | before the design.md rewrite |
| `20261103T030114Z-40009781` | verified (convention), three probes red | reviewed; the folds below followed |
| `20261103T030853Z-139c1847` | error | `followPending` unassigned in `SpawnAtomic` |
| `20261103T031058Z-71dc9ce0` | error | same, after the two-phase edit |
| `20261103T031114Z` | — | intermediate runs while the follow-up actions were stabilised |
| `20261103T031134Z-012b46eb` | counterexample (convention) | `TombstoneNonLive` — a delivery revived a tombstoned child |
| `20261103T031154Z-780237dc` | counterexample (deadlock) | a pending delivery could not be refused |
| `20261103T031218Z-858e2975` | counterexample (deadlock) | same, for a released child |
| `20261103T031250Z-5e8e6a55` | verified (convention), three probes red | after the release gate |
| `20261103T031325Z-c633df20` | verified (convention), three probes red | after tightening `Promote` |
| `20261103T031349Z-ef27d072` | verified (convention), three probes red | design.md text changed |
| `20261103T041911Z-f1cdbf8c` | verified (convention), three probes red | after the FollowUpStart fix only |
| `20261103T041944Z-a4cbbf1b` | verified (convention), three probes red | reviewed; the r2-delta folds followed |
| `20261103T053029Z-9ab6a4bf` | counterexample (convention) | the moved gate made the follow-up residual a convention violation |
| `20261103T053136Z-a6335d8c` | verified (convention) | before the fresh-admission split |
| `20261103T053714Z-1dcff645` | counterexample (convention) | a botched refusal guard mutated `released` |
| `20261103T053815Z-5e964a8e` | error | `released` unassigned in `ContinueRefused` |
| `20261103T053842Z-4e209c50` | verified (convention), three probes red | after the model folds |
| `20261103T053929Z-7863cc99` | verified (convention), three probes red | after the implementation.md update |
| `20261103T054033Z-78489973` | verified (convention), three probes red | final: identical statistics, design.md wording only |

## Not verified

- liveness (L-1): every resident child eventually settling or being released.
- the harness pool's internal reservation atomicity (E-1), the ephemeral
  one-shot lane (E-2), the release outcome matrix (E-3), the `autoReleaseMs`
  variants (E-4) and the admission queue ordering beyond the per-parent FIFO
  (E-5).
- implementation conformance: the model does not prove the TypeScript matches.

## Review state

Not yet dispatched to a formal review lane. The v1 model had been reviewed; this
revision changed the capacity abstraction and two probe cases, so a fresh review
is warranted before merge.
