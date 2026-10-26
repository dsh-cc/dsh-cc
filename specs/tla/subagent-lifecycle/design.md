# Design — subagent-lifecycle

Model id: `subagent-lifecycle` · Module: `Model.tla` · Created 2026-10-26 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L298〕,
worktree `tla-modeling`. Revised 2026-10-26 after PR #299 (the F-2 fix) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L214-L232〕
merged: the continuation capacity guard is now part of the modeled
semantics.

## Scope and screening

First-use screening (this session): the project `AGENTS.md` in this worktree
is a 7-line self-forwarding stub; the effective three-seat review rules
could not be loaded from the working tree. Screening is therefore
**unconfirmed/not adopted** — modeling, `preflight`, `check` and
`check-evidence` may proceed, but formal review dispatch is blocked until a
rule source is adoptable.

FD triggers: **FD-T1** (parent and harness both mutate child activation
state), **FD-T2** (in-flight send_message racing a grace fire; late handlers
of timed-out release attempts), **FD-T3** (process-local monotone markers
surviving drain/restart boundaries), **FD-T4** (capacity slots as a shared
resource released by settle/release and acquired by admission).

Mode: auto → decision: **enabled**. Trigger IDs: FD-T1, FD-T2, FD-T3,
FD-T4. Re-screening after the PR #299 behavior change (continuation
admission now consumes a capacity slot): still **enabled** — the modeled
behavior changed, so the model and this document were revised and the checks
re-run; the prior run's evidence is superseded.

## What is modeled

Per-child state (five independent variable families, mirroring the code's
five families — the code has no single state enum
〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L86-L112〕):

- `status[c]`: `none → (pending) → running → idle → ready → gone`, where
  `pending` exists only in the strict admission probe, `ready` means
  settled-with-registry-row (cold-resumable), `gone` means evicted.
- `tier[c]`: foreground/background (grace-window tier + promotion re-tier).
- `epochOpen[c]`: the foreground collect epoch window (promotability).
- marker sets: `graceMember` (registry membership), `gracePending` (armed
  timer), `tombstoned` (auto-release marker), `tombstoneEver`,
  `releasing`/`released` (manual release markers), `promoted`, `lateEpoch`
  and `admitted` (probe bookkeeping).
- global `drained` (session-exit whole-forest teardown).
- constant `CapacityObservable`: whether the live registry is observable
  (the production guard fails open when it is not).

Actions and their code correspondents:

| Model action | Code | Atomicity mechanism in the code |
|---|---|---|
| `SpawnAtomic` / `SpawnCheck`+`SpawnStart` | `assertLiveCapacity` + `startContinuable` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕 | single-threaded event loop; guard and start are two awaits with no lock (the modeled TOCTOU) |
| `EpochEnd` | `subagent/end` while live → `idle`, grace armed 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L55-L85〕 | synchronous set updates |
| `Settle` | harness drops live activation → `ready`; grace armed | harness-owned; event-bus ordering |
| `GraceFire` | `fireGraceWindow` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L55-L85〕 | timer callback; re-checks liveness before tombstoning |
| `ContinueCheck`+`Restart` | send_message gate + the F-2 continuation capacity pre-check 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L233-L256〕 | capacity pre-check and pin admission share one synchronous pre-execute block; the tombstone read happens first |
| `Promote` | `registration.promote()` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L143-L167〕 | `if (settled \|\| promoted) return` single-threaded guard |
| `Release` | `runRelease` mark-before-issue 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L125-L142〕 | `markReleasing` after the last `throwIfAborted`, before drain issuance |
| `LateClear` | `clearReleasing` refused while released 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L86-L112〕 | set-membership guard |
| `SessionExit` | whole-forest drain 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L188-L197〕 | harness exit path |

## Requirements and properties

| Req ID | Business outcome | Property | TLA operator | Cases | Fault-or-race trace | Assumptions | Code symbol / atomicity | Regression scenario | Exclusion / justification 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L298〕 |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | A parent never exceeds MaxLive running continuable children — on the spawn lanes AND on continuation admission | CapOK | `CapOK` | convention (core); strict-cap-toctou; strict-cap-unobservable | two spawn admissions interleaving between guard and start; a continuation at the cap | single-threaded loop; the guard counts only `running` rows 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕 | `assertLiveCapacity` (spawn lanes) + `continuationCapacityRefusal` (send_message, PR #299) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L257-L298〕 | `tool.spec.ts` "refusal at 25 on both paths", "inactive rows not counted, admits at 24"; `live-capacity.spec.ts` (deny at cap / steer passes / fail-open); `continuation-capacity.spec.ts` (byte-identical copy) | the spawn-lane TOCTOU overshoot remains a documented defect (probe); unobservable capacity is a documented fail-open boundary (probe) |
| R-2 | A released child never regains a live activation (one-way eviction) | NoResurrect | `NoResurrect` | convention | release vs late restart | process-local monotone `released` set 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L86-L112〕 | monotone set + deny gate before pin admission | `release-agent.spec.ts` T3b repeat-release convergence | none |
| R-3 | Release markers stay consistent; a stale late handler cannot clobber a completed release | ReleasedDisjoint | `ReleasedDisjoint` | convention | timed-out release attempt's late handler vs a second attempt | `clearReleasing` refused while released | set guards, single-threaded | `release-agent.spec.ts` late-continuation variants | still-resident (cancel-resistant turn) is modeled as immediate eviction — see A-2 |
| R-4 | Auto-release tombstones only touch children with no live activation | TombstoneNonLive | `TombstoneNonLive` | convention; strict-late-continue | grace fire vs continuation re-check | fire re-checks `running/idle` → skip + re-arm 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L55-L85〕 | timer callback re-check | `grace-window.spec.ts` "fire re-checks registry, live-again child skips tombstone and re-arms" | none |
| R-5 | Grace timers exist only for registry members | GraceMemberOnly | `GraceMemberOnly` | convention | coordinator/ephemeral children excluded | membership gate `registry.get(childId) === undefined → never arms` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L55-L85〕 | synchronous map | `grace-window.spec.ts` "a non-registry id never arms" | none |
| R-6 | No child runs an epoch after auto-release without a legitimate restart | NoLateEpoch | `NoLateEpoch` | convention (holds); strict-late-continue (violated by design) | in-flight send_message gate check vs grace fire | the deny gate reads the marker before pin admission 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L168-L187〕 | gate-before-admission ordering | documented accepted residual 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L113-L124〕; no dedicated test pins the in-flight window | the residual is accepted behavior, not a defect (A-5) |
| R-7 | After session exit nothing is live or admissible | DrainedQuiescent | `DrainedQuiescent` | convention | drain vs late spawn/admission | process exit fires nothing; whole-forest teardown 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L188-L197〕 | exit path | `tool.spec.ts` verbatim drain contract | cross-session cold-resume after drain unverified upstream — unmodeled |
| R-8 | Promotion re-tiers to background and a FINISHED collect cannot promote | PromotedIsBackground (+ structural `epochOpen` guard) | `PromotedIsBackground` | convention | promote vs settle | `if (settled \|\| promoted) return` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L143-L167〕 | single-threaded guard; `settled` flips only after the pending start completes | `tool.spec.ts` "promote-wins / settle-wins"; `grace-window.spec.ts` "a FINISHED collect can no longer promote" | none |
| L-1 | A running child eventually settles | excluded | — | — | — | — | — | — | needs fairness plus a harness turn-loop model; no real-time bound exists in the code |

## Faults and races explicitly modeled

1. **Spawn-admission TOCTOU** (strict-cap-toctou) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕: the guard and
   `startContinuable` are separate awaits; interleaved admissions overshoot.
   Expect a counterexample — documented defect F-1, still open.
2. **Unobservable capacity** (strict-cap-unobservable): the production guard
   fails open when the live registry cannot be read (missing `listChildren`,
   listing error, absent registry), so the cap is not enforced there. Expect
   a counterexample — the documented fail-open boundary, not a defect.
3. **In-flight send vs grace fire** (strict-late-continue): the gate check and
   the restart are separate steps; a fire in between admits one extra epoch
   for an auto-released child — the accepted residual (A-5).

The pre-#299 gap — a continuation at the cap admitting a 26th activation —
is now modeled by the capacity guard inside `Restart`; the convention case
verifies `CapOK`.

## Assumptions

- A-1: single Node process, single-threaded event loop; every synchronous
  block is atomic; interleaving happens only at awaits.
- A-2: cooperative release (still-resident while a cancel-resistant turn
  holds its slot) is modeled as immediate eviction; the bounded-wait outcome
  does not affect the marker algebra being checked.
- A-3: grace-window durations are abstracted away; the timer fire is a
  nondeterministic action while armed. The 30 min / 2 h / override-0 values 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L55-L85〕
  affect *when* the fire happens, not the marker algebra.
- A-4: one spawn lane per child id; `childId`s are fresh UUIDs in reality, so
  pin-store collisions and duplicate-id re-tiering are out of scope.
- A-5: `Restart` encodes the send_message deny gate (`[AUTO_RELEASED]`) plus
  the capacity pre-check in one step; the pin-admission serialization
  (`serializePerKey`) is assumed.
- A-6: capacity observability is a free constant (the production guard fails
  open on unreadable infrastructure); the strict-cap-unobservable probe
  carries that boundary explicitly instead of assuming it away.

## Bounds

Children = {1,2,3}; MaxLive = 2; no time. The state space is the full
product of the per-child variables for 3 children — sufficient for every
modeled race (each involves at most 2 children plus one already-running
child for the cap probes).

## Case plan

| Case | Coverage | Constants | Invariants | Expected |
|---|---|---|---|---|
| convention | core | MaxLive=2, SplitAdmission=FALSE, SplitContinue=FALSE, CapacityObservable=TRUE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕 | all | verified |
| strict-cap-toctou | expansion | SplitAdmission=TRUE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L23-L54〕 | TypeOK, CapOK | counterexample (documented defect F-1) |
| strict-cap-unobservable | expansion | CapacityObservable=FALSE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L257-L298〕 | TypeOK, CapOK | counterexample (documented fail-open boundary) |
| strict-late-continue | expansion | SplitContinue=TRUE 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L168-L187〕 | TypeOK, NoLateEpoch, TombstoneNonLive | counterexample (accepted residual) |

## Screening / revision record

- 2026-10-26 initial 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L298〕: mode `auto`, decision `enabled` (FD-T1..T4); review
  rules not loadable (AGENTS.md stub) — formal review dispatch blocked 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L1-L298〕.
- 2026-10-26 revision 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L214-L232〕: PR #299 (the F-2 fix) merged into main
  (`1c89f1e3`); the model gained the continuation capacity guard and the
  fail-open probe; all three runner commands were re-run and the prior
  evidence superseded.
