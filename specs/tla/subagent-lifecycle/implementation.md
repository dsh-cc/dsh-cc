# Implementation record — subagent-lifecycle v2

Keyed to the final run below. Not part of `inputDigest`.

## Runner and toolchain

- runner `@dsh-cc/plugin-dsh-cc-agents@0.9.3-rc.4`, TLC 1.7.4 (bundled JAR),
  Java 25 on darwin, fixed runner flags per case.

## Final run

- runId `20261103T030114Z-40009781-6907-4515-929e-ae8f8cef697f`
- inputDigest `b93003a38edeb5f1…`
- `convention` **verified**: 196,903 states generated, 23,004 distinct, 0 left
  on queue.
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

## Modeling defects found while drafting (fixed)

1. the model deadlocked at the drained terminal because there was no explicit
   self-loop (the runner forbids disabling deadlock checking). Added `Idle`,
   enabled only when `drained`.

## Run lineage

| runId | Outcome | Note |
|---|---|---|
| `20261103T025906Z-537ab7d9` | counterexample (deadlock) | missing terminal self-loop (defect 1) |
| `20261103T025933Z-3327ea2d` | verified (convention), three probes red | before the design.md rewrite |
| `20261103T030114Z-40009781` | verified (convention), three probes red | final |

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
