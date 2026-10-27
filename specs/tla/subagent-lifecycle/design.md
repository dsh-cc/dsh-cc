# Design — subagent-lifecycle

Model id: `subagent-lifecycle` · Module: `Model.tla` · Created 2026-10-26 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L273〕,
worktree `tla-modeling`. Revised 2026-10-27 after PR #301 merged 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕: capacity
admission is one atomic step per parent (a shared FIFO lease taken AFTER the 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L80-L127〕
approval prompt, held across the creation/delivery call), so the model now
describes the merged code and `convention` verifies the cap.

## Scope and screening

First-use screening (this session): the project `AGENTS.md` in this worktree
is a 7-line self-forwarding stub; the effective three-seat review rules could
not be loaded. Screening is **unconfirmed/not adopted** — modeling,
`preflight`, `check` and `check-evidence` may proceed; formal review dispatch
is blocked until a rule source is adoptable.

FD triggers: **FD-T1** (parent and harness both mutate child activation
state), **FD-T2** (in-flight send_message racing a grace fire), **FD-T3**
(process-local monotone markers surviving drain boundaries), **FD-T4**
(capacity slots as a shared resource released by settle/release and acquired
by admission).

Mode: auto → decision: **enabled**. Re-screening after PR #301 (the
admission redesign): still **enabled** — the modeled behavior changed, so the
model, anchors and this document were revised and the checks re-run; the
prior run's evidence is superseded.

## What is modeled

Per-child state 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L9-L52〕:

- `status[c]`: `none → running → idle → ready → gone`, where `ready` means
  settled-with-registry-row (cold-resumable) and `gone` means evicted.
- `tier[c]`: foreground/background (grace-window tier + promotion re-tier).
- `epochOpen[c]`: the foreground collect epoch window (promotability).
- marker sets: `graceMember`, `gracePending`, `tombstoned`, `tombstoneEver`,
  `releasing`/`released`, `promoted`, `lateEpoch`.
- global `drained` (session-exit whole-forest teardown).
- constant `CapacityObservable`: whether the live registry is readable (the
  guard fails open when it is not).

Actions and their code correspondents:

| Model action | Code | Atomicity mechanism in the code |
|---|---|---|
| `SpawnAtomic` | `acquireLiveCapacity` + `startContinuable` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕 | the per-parent FIFO lease is held across the guard and the creation call; released when creation settled |
| `ContinueAdmit` | `tools/execute` dispatch admission 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕 | the lease is taken AFTER approval, the guard runs under it, and it is held until the delivery settles |
| `ContinueAdmit` (tombstone gate) | the pre-execute `[AUTO_RELEASED]` deny 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L160-L183〕 | a separate step from the dispatch admission (the accepted residual) |
| `EpochEnd` / `Settle` | `subagent/end`, harness drop → grace armed 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L184-L211〕 | synchronous set updates; fire re-checks liveness |
| `GraceFire` | `fireGraceWindow` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L184-L211〕 | timer callback; live child → skip + re-arm |
| `Release` / `LateClear` | `runRelease` mark-before-issue, refused clear 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L212-L245〕 | `markReleasing` before the drain issuance; `clearReleasing` refused while released |
| `Promote` | `registration.promote()` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L246-L264〕 | `if (settled \|\| promoted) return`, single-threaded |
| `SessionExit` | whole-forest drain 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L265-L273〕 | harness exit path |

## Requirements and properties

| Req ID | Business outcome | Property | TLA operator | Cases | Fault-or-race trace | Assumptions | Code symbol / atomicity | Regression scenario | Exclusion / justification 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L273〕 |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | A parent never exceeds MaxLive running continuable children — spawns and continuations both check under the same per-parent lease | CapOK | `CapOK` | convention (core); strict-cap-unobservable | two admissions interleaving; unreadable capacity | single-threaded loop; the guard counts only `running` rows 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L9-L52〕 | `acquireLiveCapacity` + `admitContinuation` under `acquireAdmission` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕 | `admission.spec.ts` (FIFO, abort races), `admission-mixed.spec.ts` (24 live + spawn + continuation) | unobservable capacity is a documented fail-open boundary (probe) |
| R-2 | A released child never regains a live activation | NoResurrect | `NoResurrect` | convention | release vs late admission | process-local monotone `released` set 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L212-L233〕 | monotone set + deny gate | `release-agent.spec.ts` repeat-release convergence | none |
| R-3 | Release markers stay consistent; a late handler cannot clobber a completed release | ReleasedDisjoint | `ReleasedDisjoint` | convention | timed-out release attempt's late handler | `clearReleasing` refused while released | set guards, single-threaded | `release-agent.spec.ts` late-continuation variants | still-resident is modeled as immediate eviction (A-2) |
| R-4 | Auto-release tombstones only touch children with no live activation | TombstoneNonLive | `TombstoneNonLive` | convention; strict-late-continue | grace fire vs continuation re-check | fire re-checks `running/idle` → skip + re-arm 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L184-L211〕 | timer callback re-check | `grace-window.spec.ts` "fire re-checks registry…" | none |
| R-5 | Grace timers exist only for registry members | GraceMemberOnly | `GraceMemberOnly` | convention | coordinator/ephemeral children excluded | membership gate 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L184-L211〕 | synchronous map | `grace-window.spec.ts` "a non-registry id never arms" | none |
| R-6 | No child runs an epoch after auto-release without a legitimate restart | NoLateEpoch | `NoLateEpoch` | convention (holds); strict-late-continue (violated by design) | grace fire landing between the tombstone gate and the dispatch admission | the two guards are separate steps 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L234-L245〕 | documented accepted residual | code comment only (A8) | accepted behavior, not a defect |
| R-7 | After session exit nothing is live or admissible | DrainedQuiescent | `DrainedQuiescent` | convention | drain vs late admission | process exit fires nothing 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L265-L273〕 | exit path | `tool.spec.ts` verbatim drain contract | cross-session cold-resume after drain unverified upstream |
| R-8 | Promotion re-tiers to background and a FINISHED collect cannot promote | PromotedIsBackground | `PromotedIsBackground` | convention | promote vs settle | `if (settled \|\| promoted) return` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L246-L264〕 | single-threaded guard | `tool.spec.ts` "promote-wins / settle-wins" | none |
| L-1 | A running child eventually settles | excluded | — | — | — | — | — | — | needs fairness plus a harness turn-loop model |

## Faults and races explicitly modeled

1. **Unobservable capacity** (strict-cap-unobservable): a missing
   `listChildren` seam, a throwing listing or an absent registry makes the
   guard admit — a safety valve must not wedge admissions on its own
   infrastructure. Expect a counterexample: the documented fail-open boundary,
   not a defect.
2. **Grace fire between the tombstone gate and the dispatch admission**
   (strict-late-continue): the `[AUTO_RELEASED]` deny runs in
   `tools/pre-execute` and the capacity admission in `tools/execute`, so a
   fire in between admits one extra epoch for an auto-released child. Expect a
   counterexample — the accepted residual recorded in the code
   〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L234-L245〕.

The two admission defects the earlier revisions recorded are CLOSED by PR 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L159〕
#301 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕: the spawn TOCTOU (F-1 — the lease serializes check + creation) and the
continuation capacity gap (F-2 — admission runs after approval under the same
lease). `convention` verifies `CapOK` for every interleaving in the bounds.

## Assumptions

- A-1: single Node process, single-threaded event loop; every synchronous
  block is atomic; interleaving happens only at awaits.
- A-2: cooperative release (still-resident while a cancel-resistant turn
  holds its slot) is modeled as immediate eviction.
- A-3: grace-window durations are abstracted; the fire is a nondeterministic
  action while armed.
- A-4: `childId`s are fresh UUIDs, so pin-store collisions and duplicate-id
  re-tiering are out of scope.
- A-5: the approval prompt is not modeled as a state; what matters is that it
  runs BEFORE the dispatch admission (`tools/execute`) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕, which the merge
  guarantees, and the model encodes it by making the capacity check and the
  restart one step.
- A-6: capacity observability is a free constant; the probe carries that
  boundary explicitly rather than assuming it away.

## Bounds

Children = {1,2,3}; MaxLive = 2; no time. The state space is the full product
of the per-child variables for 3 children — sufficient for every modeled race.

## Case plan

| Case | Coverage | Constants | Invariants | Expected |
|---|---|---|---|---|
| convention | core | MaxLive=2, SplitContinue=FALSE, CapacityObservable=TRUE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕 | all | verified |
| strict-cap-unobservable | expansion | CapacityObservable=FALSE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L9-L52〕 | TypeOK, CapOK | counterexample (documented fail-open boundary) |
| strict-late-continue | expansion | SplitContinue=TRUE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L160-L183〕 | TypeOK, NoLateEpoch, TombstoneNonLive | counterexample (accepted residual) |

## Screening / revision record

- 2026-10-26 initial 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L273〕: mode `auto`, decision `enabled` (FD-T1..T4); review
  rules not loadable — formal review dispatch blocked.
- 2026-10-26 revision 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L273〕: PR #299 merged (continuation capacity guard).
- 2026-10-27 revision 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L159〕: PR #301 merged (`72397120`) — capacity admission is a
  single atomic step per parent under one lease, taken after approval; the
  reservation/TTL machinery the review rounds discussed is NOT in the merged 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L80-L127〕
  design (the merge moved admission after the approval prompt instead), so
  the model dropped it. All three runner commands re-run; prior evidence
  superseded.
