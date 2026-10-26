# Design — subagent-lifecycle

Model id: `subagent-lifecycle` · Module: `Model.tla` · Created 2026-10-26,
worktree `tla-modeling` (head d5f7e385).

## Scope and screening

First-use screening (this session): the project `AGENTS.md` in this worktree
is a 7-line self-forwarding stub; the effective three-seat review rules
could not be loaded from the working tree. Screening is therefore
**unconfirmed/not adopted** — modeling, `preflight`, `check` and
`check-evidence` may proceed, but formal review dispatch is blocked until a
rule source is adoptable. This document records that state per the skill's
first-use contract.

FD triggers: **FD-T1** (parent and harness both mutate child activation
state), **FD-T2** (in-flight send_message racing a grace fire; late handlers
of timed-out release attempts), **FD-T3** (process-local monotone markers
surviving drain/restart boundaries), **FD-T4** (capacity slots as a shared
resource released by settle/release and acquired by admission).

Mode: auto → decision: **enabled**. Trigger IDs: FD-T1, FD-T2, FD-T3,
FD-T4. Rationale: the subagent lifecycle is the repo's largest
ordering-sensitive shared-state machine (admission cap, grace-window
auto-release, one-way eviction, promotion vs settle race).

## What is modeled

Per-child state (5 variables per child, mirroring the code's five independent
families — the code has no single state enum 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L75-L103〕):

- `status[c]`: `none → (pending) → running → idle → ready → gone`, where
  `pending` exists only in the strict admission probe, and `ready` means
  settled-with-registry-row (cold-resumable), `gone` means evicted.
- `tier[c]`: foreground/background (grace-window tier + promotion re-tier).
- `epochOpen[c]`: the foreground collect epoch window (promotability).
- marker sets: `graceMember` (registry membership), `gracePending` (armed
  timer), `tombstoned` (auto-release marker), `tombstoneEver`,
  `releasing`/`released` (manual release markers), `promoted`, `lateEpoch`
  (probe bookkeeping), `admitted` (split-gate probe bookkeeping).
- global `drained` (session-exit whole-forest teardown).

Actions and their code correspondents:

| Model action | Code | Atomicity mechanism in the code |
|---|---|---|
| `SpawnAtomic` / `SpawnCheck`+`SpawnStart` | `assertLiveCapacity` + `startContinuable` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L33-L61〕 | single-threaded event loop; guard and start are two awaits with no lock (the modeled TOCTOU) |
| `EpochEnd` | `subagent/end` while live → `idle`, grace armed 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L84-L121〕 | synchronous set updates |
| `Settle` | harness drops live activation → `ready`; grace armed | harness-owned; event-bus ordering |
| `GraceFire` | `fireGraceWindow` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L95-L121〕 | timer callback; re-checks liveness before tombstoning |
| `ContinueCheck`+`Restart` | send_message gate `plugin.ts:303-320` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L156-L175〕 + `subagent/start` `clearTombstone` | gate reads marker before pin admission (serializePerKey per child) |
| `Promote` | `registration.promote()` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L127-L144〕 | `if (settled \|\| promoted) return` single-threaded guard |
| `Release` | `runRelease` mark-before-issue 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L137-L160〕 | `markReleasing` after last `throwIfAborted`, before drain issuance |
| `LateClear` | `clearReleasing` refused while released 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L97-L103〕 | set-membership guard |
| `SessionExit` | whole-forest drain 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L178-L184〕 | harness exit path |

## Requirements and properties

| Req ID | Business outcome | Property | TLA operator | Cases | Fault-or-race trace | Assumptions | Code symbol / atomicity | Regression scenario | Exclusion / justification |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | A parent never exceeds MaxLive running continuable children | CapOK | `CapOK` | convention (core); strict-cap-toctou | two admissions interleaving between guard and start | single-threaded loop; guard counts only `running` rows 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L44-L49〕 | `assertLiveCapacity` check-then-act across two awaits | `tool.spec.ts` "refusal at 25 on both paths", "inactive rows not counted, admits at 24" | TOCTOU overshoot is expected in the strict case (documented defect) |
| R-2 | A released child never regains a live activation (one-way eviction) | NoResurrect | `NoResurrect` | convention | release vs late restart | process-local monotone `released` set 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L75-L103〕 | monotone set + deny gate before pin admission | `release-agent.spec.ts` T3b repeat-release convergence | none |
| R-3 | Release markers are consistent; a stale late handler cannot clobber a completed release | ReleasedDisjoint | `ReleasedDisjoint` | convention | timed-out release attempt's late handler vs second attempt | `clearReleasing` refused while released | set guards, single-threaded | `release-agent.spec.ts` late-continuation variants (i)-(vi) | still-resident (cancel-resistant turn) is unmodeled: modeled as immediate eviction, see Assumptions |
| R-4 | Auto-release tombstones only touch children with no live activation | TombstoneNonLive | `TombstoneNonLive` | convention; strict-late-continue | grace fire vs continuation re-check | fire re-checks `running/idle` → skip + re-arm 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L106-L112〕 | timer callback re-check | `grace-window.spec.ts` "fire re-checks registry, live-again child skips tombstone and re-arms" | none |
| R-5 | Grace timers exist only for registry members | GraceMemberOnly | `GraceMemberOnly` | convention | coordinator/ephemeral children excluded | membership gate `registry.get(childId) === undefined → never arms` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L84-L89〕 | synchronous map | `grace-window.spec.ts` "a non-registry id never arms" | none |
| R-6 | No child runs an epoch after auto-release without a legitimate restart | NoLateEpoch | `NoLateEpoch` | convention (holds); strict-late-continue (violated by design) | in-flight send_message gate check vs grace fire | the deny gate reads the marker before pin admission 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L156-L175〕 | gate-before-admission ordering | documented accepted residual 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L105-L113〕; no dedicated test pins the in-flight window | the residual is accepted behavior (A5), not a defect to fix |
| R-7 | After session exit nothing is live or admissible | DrainedQuiescent | `DrainedQuiescent` | convention | drain vs late spawn/admission | process exit fires nothing; whole-forest teardown 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L178-L184〕 | exit path | `tool.spec.ts:1448-1455` verbatim drain contract | cross-session cold-resume after drain unverified upstream (known gap, `it.skip` integration.spec.ts:405) — unmodeled |
| R-8 | Promotion re-tiers to background and a FINISHED collect cannot promote | PromotedIsBackground (+ structural guard `epochOpen`) | `PromotedIsBackground` | convention | promote vs settle | `if (settled \|\| promoted) return` 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L127-L131〕 | single-threaded guard; `settled` flips only after pending start completes | `tool.spec.ts` "promote-wins / settle-wins", `grace-window.spec.ts` "a FINISHED collect can no longer promote" | none |
| L-1 | A running child eventually settles | excluded | — | — | — | — | — | — | needs fairness + a harness turn-loop model; no real-time bound exists in the code; excluded |

## Faults and races explicitly modeled

1. **Admission TOCTOU** (strict-cap-toctou): guard and start are separate
   awaits; two interleaved admissions overshoot the cap. Expect a
   counterexample — documented defect (finding F-1 in implementation.md).
2. **In-flight send vs grace fire** (strict-late-continue): the gate check
   and the restart are separate steps; a fire in between admits one extra
   epoch for an auto-released child. Expect a counterexample — the
   documented accepted residual (A5).

## Assumptions

- A-1: single Node process, single-threaded event loop; every synchronous
  block is atomic; interleaving happens only at awaits. (Real guarantee:
  the code is plain in-process JS with no workers on these paths.)
- A-2: `release`'s cooperative eviction (still-resident when a
  cancel-resistant turn keeps its slot) is modeled as immediate eviction.
  The bounded-wait outcome (10 s observe timeout, `DRAIN_OBSERVE_TIMEOUT_MS`)
  has no effect on the marker algebra being checked. Unmodeled residual:
  slot-holding during still-resident.
- A-3: grace-window durations are abstracted away; the timer firing is a
  nondeterministic action enabled whenever the timer is armed. Foreground
  30 min / background 2 h / override 0 (disable) affect only *when* the
  fire happens, not the marker algebra.
- A-4: one spawn lane per child id; `childId`s are fresh UUIDs in reality,
  so pin-store collisions and duplicate-id re-tiering are out of scope.
- A-5: `Restart` encodes the send_message deny gate (`[AUTO_RELEASED]`) as
  its `¬tombstoned ∧ ¬released` guard; the pin-admission serialization
  (`serializePerKey`) is assumed, making gate-read + restart one logical
  step in the convention case.

## Bounds

Children = {1,2,3}; MaxLive = 2; no time. State space is the full product
of the per-child variables for 3 children — sufficient for all modeled
races (each race involves at most 2 children plus one already-running child
for the cap probe).

## Case plan

| Case | Coverage | Constants | Invariants | Expected |
|---|---|---|---|---|
| convention | core | MaxLive=2, SplitAdmission=FALSE, SplitContinue=FALSE | all | verified |
| strict-cap-toctou | expansion | SplitAdmission=TRUE | TypeOK, CapOK | counterexample (documented defect) |
| strict-late-continue | expansion | SplitContinue=TRUE | TypeOK, NoLateEpoch, TombstoneNonLive | counterexample (accepted residual) |

## Screening section (current)

Formal design: mode `auto`, decision `enabled`, triggerIds FD-T1/T2/T3/T4,
modelDir `specs/tla/subagent-lifecycle`, review rules **not loadable**
(AGENTS.md stub) — formal review dispatch blocked; modeling and checks
proceed per first-use contract.
