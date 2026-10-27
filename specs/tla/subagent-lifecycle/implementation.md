# Implementation record — subagent-lifecycle

Keyed to the final run of 2026-10-27 (post-#301 revision) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L273〕. Not part of inputDigest.

## Run lineage

- **Final run (merged #301 semantics: one atomic admission per parent, taken
  after approval):** runId
  `20261027T043651Z-1dc6b254-22ba-42d3-8980-b86f5e034292`, inputDigest
  `c35e35f4f85aaafb456301d7676243a96bf1fbfd1ec1196ac32d4f8bc4b7085b`.
  The model dropped the reservation/TTL machinery (it is not in the merged
  design) and grew `ContinueAdmit` as the dispatch-time admission.
- Superseded runs: `20261027T041506Z-29ae8019-…` (reservation-based revision),
  `20261026T132526Z-3761d98c-…` (post-#299), `20261026T070646Z-9165fd15-…`
  (pre-fix; its `convention` counterexample is the F-2 reproduction).
- runnerPackage: `@dsh-cc/plugin-dsh-cc-agents` 0.9.2, TLC 1.7.4, Java
  25.0.2, darwin
- check-evidence: `valid` / fresh / verification `counterexample` (aggregate —
  the two expansion probes are expected counterexamples)
  〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L273〕

## Case results (final run)

| Case | Status | Statistics (generated/distinct/queue) |
|---|---|---|
| convention | **verified** | 15128/2918/0 |
| strict-cap-unobservable | counterexample — CapOK | 41/24/17 |
| strict-late-continue | counterexample — NoLateEpoch | 281/134/91 |

## Finding dispositions

### F-1 (spawn admission TOCTOU) — CLOSED by PR #301

Merged: `acquireLiveCapacity` takes the per-parent FIFO lease and runs the
guard under it, holding the lease across `startContinuable` (`72397120`). The
model's `SpawnAtomic` is that one critical section; the old split-check probe
no longer models any code and was removed
〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕. Acceptance
mapping: model `SpawnAtomic` ↔ `acquireLiveCapacity` + the spawn lanes;
`admission.spec.ts` (FIFO, abort races) and `admission-mixed.spec.ts` (24 live
+ one spawn + one continuation ⇒ at most 25) are the code-side pins.

### F-2 (continuation capacity gap) — CLOSED by #299, re-homed by #301

#299 added the continuation pre-check; #301 moved continuation admission to
the dispatch seam (`tools/execute`), after the approval prompt and under the
same lease held until delivery settles
〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕. The model's
`ContinueAdmit` encodes check + restart as one step, which is what the lease
guarantees.

The review rounds' reservation/TTL/dispatch-recheck design was superseded by
this merge: the merged code has **no reservation and no TTL** (admission runs
after approval), so the model dropped `ReservationExpire` /
`ReservationRelease` and the `DispatchRecheck` probe. The review-round
regression shapes remain covered by `admission.spec.ts` in the merged tree.

### strict-cap-unobservable — documented fail-open boundary

Unreadable capacity (no `listChildren`, throwing listing, absent registry)
admits by design 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L9-L52〕.
The probe pins that boundary; `admission.spec.ts` "degrades open" is the
code-side pin.

### strict-late-continue — accepted residual

The `[AUTO_RELEASED]` tombstone deny runs in `tools/pre-execute` while capacity
admission runs in `tools/execute`; a grace fire landing between them admits one
extra epoch — the accepted residual recorded in the code
〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L234-L245〕.

## Unmodeled scope

- Cooperative release (still-resident while a cancel-resistant turn holds its
  slot) — modeled as immediate eviction.
- The approval prompt itself (only its position before dispatch admission
  matters) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕.
- Pin-store persistence, `serializePerKey` FIFO, cross-session cold-resume
  after drain (upstream gap)
  〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L265-L273〕.
- Ephemeral one-shot lane (TTL reaper), coordinator worker registry, one-shot
  ledger, suppress-settled notices.
- Grace-window durations — abstracted to a nondeterministic fire
  〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L184-L211〕.

## Suggested regression tests (repo changes, not made here)

1. In-flight send vs grace fire: gate pass → fire → dispatch admission — pins
   the accepted residual explicitly (today only a code comment).
2. Lease fairness under a long approval: two continuations queued at the cap
   must not starve spawns (the lease is taken after approval, so this should
   hold trivially; a test would pin the ordering).
