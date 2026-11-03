# Design: subagent-lifecycle v2 (resident-activation pool, after the rc.5 capacity move)

Model directory: `specs/tla/subagent-lifecycle`. Module `Model`, spec `Spec`,
safety-only. This is the v2 revision: the harness 0.2.1-rc.5 migration deleted
the dsh-cc running-count guard, so the v1 capacity property (`CapOK` over
running children with an "unobservable capacity" degradation) proved a property
of code that no longer exists. Everything else in v1 — the admission lease, the
grace-window tombstones, release markers, promotion, drain — still matches and
is carried over.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — session request "repair the subagent
  lifecycle model against rc.5" 2026-11-03, manual adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the admission lease, the pool and the release paths act on
  one child record), FD-T4 (a slot is a lease on a resource whose ownership
  moves asynchronously between admission, settle, release and drain).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/subagent-lifecycle"}`.
- behavioural source: current code at the rc.5 line —
  `packages/subagent/task/src/live-capacity.ts:1-16,27-68`,
  `packages/subagent/resume-pins/src/live-capacity.ts:1-16,45-64`,
  `packages/subagent/resume-pins/src/admission.ts:1-55`,
  `packages/subagent/resume-pins/src/dispatch-admission.ts:1-26`,
  `packages/subagent/task/src/index.ts:184-185`,
  `packages/subagent/task/src/grace-window.ts:150-192`,
  `packages/interaction/command-agents/src/release.ts:78-100,110-117`.

## Requirements

- **REQ-1 (resident cap)** The number of resident activations in one activation
  tree never exceeds `MaxLive` (25 in production). A slot is taken at
  materialization and returned only at disposal; resident means a running child,
  an idle parent waiting on child settlement, or a cold-resumed child.
- **REQ-2 (slot discipline)** A slot is held exactly by a resident activation: a
  settled child holds none, and a drained forest holds none. A slot leak would
  permanently shrink the pool.
- **REQ-3 (follow-up exemption)** A `send_message` to an already-resident child
  takes no new slot (`index.ts:185`); only a cold resume of a settled child
  does, and it is refused at the cap.
- **REQ-4 (no resurrection)** A released child never regains a live activation.
- **REQ-5 (tombstone soundness)** An auto-release tombstone is only set on a
  child with no live activation, and grace timers only exist for registry
  members.
- **REQ-6 (no late epoch)** No child runs an epoch after auto-release without a
  restart — the documented accepted residual (`release.ts:110-117`) is the one
  interleaving that can violate it, and it is the `SplitContinue` probe.
- **REQ-7 (drain)** After session exit every child is drained and no slot
  survives.
- **REQ-8 (promotion)** A promoted child is re-tiered to background exactly once.

## State variables

| Variable | Meaning |
|---|---|
| `status` | per child: none / running / idle / ready / gone |
| `slotHolder` | children currently holding a pool slot (the resident set) |
| `tier`, `epochOpen` | foreground/background tier and whether an epoch is in flight |
| `graceMember`, `gracePending` | registry membership and armed grace timers |
| `tombstoned`, `tombstoneEver` | the auto-release marker and its history |
| `releasing`, `released` | the release marker before and after the eviction |
| `promoted`, `lateEpoch` | promotion history and the late-continuation counter |
| `drained` | the session-exit terminal |

Atomicity mapping: `SpawnAtomic` is one step because the harness reserves the
slot inside `startActivation` and the dsh-cc lane holds the admission lease
across the creation call (`admission.ts:19-55`); `ContinueAdmit` acquires its
slot inside that call too, so the refusal at the cap now happens after the lease
is taken, not at a dsh-cc-side count. `Settle`, `ReleaseFinish` and
`SessionExit` are the three disposal points that return a slot.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | never more resident activations than the pool allows | S-1 `CapOK` | `CapOK` | convention; strict-cap-overshoot (expected red) | `SpawnAtomic` past the cap under `CapIgnored` | A-1, A-2 | `startActivation` reserving a slot and throwing `ACTIVATION_LIMIT_REACHED`; `PoolHasRoom` | three concurrent spawns at `MaxLive = 2` | the pool's own atomicity is upstream (A-1) |
| REQ-2 | a slot exists exactly while a resident activation exists | S-2 `SlotIsActivation`, S-3 `DrainedNoSlot` | same | convention; strict-slot-leak (expected red) | `ReleaseFinish` / `SessionExit` keeping the slot under `SkipSlotRelease` | A-3 | `Settle` disposes, `ReleaseFinish` and `SessionExit` return slots | release a child and check the pool count | — |
| REQ-3 | a follow-up to a resident child takes no slot | structural (`FollowUp` assigns no slot) | `FollowUp` | convention | a follow-up admitted at the cap | A-1 | `admitContinuation` short-circuits for a resident target | `send_message` at the cap | the exemption is stated in the contract copy, pinned as A5 |
| REQ-4 | a released child stays gone | S-4 `NoResurrect` | `NoResurrect` | convention | release then a continuation attempt | A-4 | the tombstone gate at `tools/pre-execute` | release then `send_message` | — |
| REQ-5 | tombstones and grace timers stay sound | S-5 `TombstoneNonLive`, S-6 `GraceMemberOnly` | same | convention | grace fire on a stale timer | A-5 | `fireGraceWindow` re-checks liveness (`grace-window.ts:172-192`) | arm, then settle, then fire | — |
| REQ-6 | no epoch after auto-release without a restart | S-7 `NoLateEpoch` | `NoLateEpoch` | convention; strict-late-continue (expected red) | a grace fire lands between the gate and the delivery | A-6 | pre-execute gate before the dispatch admission | the accepted residual | the residual is accepted by design (`release.ts:110-117`) |
| REQ-7 | the forest is drained at exit | S-8 `DrainedQuiescent`, S-3 | same | convention | exit with live children | A-7 | whole-forest teardown at session exit | exit with running and idle children | cooperative eviction may keep a slot until the turn settles (A-7) |
| REQ-8 | promotion re-tiers once | S-9 `PromotedIsBackground` | same | convention | promote, then promote again | A-8 | `epoch-collector.ts:285-299` guard | Ctrl+B on a running child | — |

## Assumptions

- **A-1** The harness pool's slot reservation and `ACTIVATION_LIMIT_REACHED`
  refusal are atomic with materialization; the dsh-cc side only serializes the
  call. The pool implementation is upstream and outside this repository.
- **A-2** A slot is counted per root activation tree and shared by local and
  external descendants (`live-capacity.ts:20-27`).
- **A-3** Disposal is the only slot release; a settle disposes the activation.
- **A-4** The release marker is set before the drain and survives it
  (`release.ts:78-100`).
- **A-5** The grace fire re-checks registry membership and liveness before
  tombstoning (`grace-window.ts:150-192`).
- **A-6** The tombstone gate runs at `tools/pre-execute`, before the dispatch
  admission at `tools/execute`.
- **A-7** Session exit drains the whole forest; eviction is cooperative, so a
  cancel-resistant turn keeps its slot until it settles.
- **A-8** Promotion's `settled || promoted` guard is the single entry.

## Faults modeled (one switch per probe)

| Switch | Models | Probe |
|---|---|---|
| `CapIgnored` | the pool admitting past the cap | strict-cap-overshoot |
| `SkipSlotRelease` | a disposal path that does not return its slot | strict-slot-leak |
| `SplitContinue` | the accepted late-continuation residual (gate and delivery ordered apart) | strict-late-continue |

## Bounds

Three children, `MaxLive = 2`. Two is the minimum that exposes an overshoot, and
three children let a settled child be cold-resumed while two residents hold the
cap.

## Exclusions

- **E-1** the harness pool's internal reservation atomicity: upstream, read
  only, and A-1 records the obligation.
- **E-2** the one-shot ledger, the ephemeral reaper TTL controller and the
  grace-settled notice (`one-shot-ledger.ts`, `ephemeral-reaper.ts`): a separate
  lane that would need its own model; the shared lease and the slot discipline
  are covered here.
- **E-3** the release outcome matrix (`release.ts:210-415`: observe timeouts,
  `ACTIVATION_TEARDOWN_FAILED` degraded success, the bounded poll): the model
  abstracts eviction to one step, which is the property-relevant part.
- **E-4** `autoReleaseMs = 0` (never armed) and `armGraceFromPin`: time
  abstractions that change no property here.
- **E-5** the admission queue's ordering beyond the per-parent FIFO.
- **L-1** liveness (every resident child eventually settles or is released) is
  excluded: it needs fairness and a turn-loop model.

## Code and test mapping

| Property | Code mechanism | Test pinning it |
|---|---|---|
| S-1 | `startActivation` slot reservation + refusal mapping | `continuation-capacity.spec.ts`, `admission-atomic.spec.ts` |
| S-2, S-3 | disposal returns the slot | `release-agent.spec.ts`, `grace-window.spec.ts` |
| REQ-3 | resident follow-up takes no slot | `dispatch-admission.spec.ts` |
| S-4 | tombstone gate at pre-execute | `plugin.spec.ts` (tombstone deny) |
| S-5, S-6 | grace fire re-checks liveness | `grace-window.spec.ts` |
| S-7 | accepted residual | `release-agent.spec.ts` |
| S-8 | whole-forest drain | `tool.spec.ts` drain assertions |
| S-9 | promotion guard | `epoch-collector.spec.ts` |

## Open questions (not decided by this model)

1. Should a cooperative eviction that outlives its timeout keep the slot (as the
   refusal copy says) or release it optimistically?
2. Should the ephemeral one-shot lane get its own model (E-2)?

Counterexample dispositions and the v1→v2 drift account are in
`implementation.md`.
