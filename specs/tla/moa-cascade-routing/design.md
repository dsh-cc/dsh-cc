# Design — moa-cascade-routing

Model id: `moa-cascade-routing` · Module: `Model.tla` · Created 2026-10-26,
worktree `tla-modeling` (head d5f7e385).

## Scope and screening

First-use screening (this session): `AGENTS.md` in this worktree is a
self-forwarding stub; effective three-seat review rules not loadable.
Screening **unconfirmed/not adopted** — modeling and checks proceed, formal
review dispatch blocked (recorded per first-use contract).

FD triggers: **FD-T1** (main agent, System One classifier, judge and
followup all mutate shared routing state), **FD-T2** (detached judge racing
new user messages — stale guard), **FD-T3** (in-memory escalation
bookkeeping lost across crash/resume while the typed followup survives),
**FD-T4** (escalation budget/floor ownership per origin seq).

Mode: auto → decision: **enabled**. TriggerIds: FD-T1/T2/T3/T4.

## What is modeled

A single-origin conversation under moa, on a fixed non-degenerate four-rung
ladder (tiers 0..3, all distinct — the armed case). Modeled state:
arming machine (`armed`, `away`, `feedbackDisarm`), per-turn pipeline
(`state ∈ captured/serving/answered/escalated`, `tier`, `lastServedTier`),
escalation bookkeeping (`floorsDefined`, `floor`, `retries`), detached
judge (`judgePending`, `judgeStale`, `judgeAcceptable`), ACT bookkeeping
(`actedCount`), and two probe flags (`lastClassifyArmed`,
`retryTierMissing`).

Not modeled (deterministic computation, no ordering sensitivity): the
argmax/label collapse itself, token cropping, sidecar ledger row bytes,
status-row splice mechanics, sanitize/drop of harness model-selection rows.

| Model action | Code | Atomicity mechanism |
|---|---|---|
| `UserTurn` | claimed-batch capture, fresh origin entry (`runtime-state.ts:44-52`) | synchronous FIFO insert |
| `RequestObserve` | pre-overlay observe 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L19-L31〕 | single synchronous call before `withTier` |
| `Classify` | `classifyOnce` gate 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L45-L53〕 | sticky-slot synchronous write after the classify resolves |
| `FailOpenServe` | gate failure / unarmed serve (`router.ts:386`) | fail-open passthrough |
| `ModelSwitchAway/Back` | arming truth table 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L1-L27〕 | synchronous `armed`/`reason` write |
| `TurnEnd` | turn-stopping snapshot + detached judge (`judge.ts:367-390`) | **synchronous** `capture()` before dispatch |
| `JudgeVerdict` | accept/escalate decision 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L60-L76〕 | `recordRetryUsed` → `release()` → `followup` sequence |
| `RetryTurn` | moa-escalation opening: never re-classified, serves floor (`router.ts:327-340`) | sticky `{tier: floor, suppressRow: true}` |
| `Crash` (probe only) | in-memory bookkeeping loss 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L86-L91〕 | none — this is the gap |
| `SubagentStep` | scope exclusion 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L106-L115〕 | 9 writer guards; structurally a no-op |

## Requirements and properties

| Req ID | Business outcome | Property | TLA operator | Cases | Fault-or-race trace | Assumptions | Code symbol / atomicity | Regression scenario | Exclusion / justification |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | Escalations are bounded per origin | EscalationBound | `EscalationBound` | convention, shadow-mode | judge loop vs budget | `MAX_ESCALATIONS_CEILING=3`, default 1 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L44-L59〕 | `recordRetryUsed` validates then mutates; invariant violation throws fail-safe | `judge-loop.spec.ts` "ceiling: after one executed escalation the judge is not called again for that origin" | none |
| R-2 | Escalation floors are above the boot rung and come with a used retry | FloorAboveBoot | `FloorAboveBoot` | convention | — | `recordRetryUsed` invariants: `toTier > floor`, both in range | throw-on-violation guard | `state.spec.ts` "recordRetryUsed advances floor ... refuses backward transitions" | multi-rung jump chain tested at MaxEsc=2 in `judge-loop.spec.ts`; modeled at MaxEsc=1 |
| R-3 | Shadow mode never acts | ShadowInert | `ShadowInert` | shadow-mode | verdict escalate in shadow | shadow rows log `acted:false` | dispatch gate `act = acceptance.enabled === true` | `judge-loop.spec.ts` "shadow: judge called on tool turns too, verdict logged eligible:false, no followup" | none |
| R-4 | Classification only while armed | ClassifyOnlyArmed | `ClassifyOnlyArmed` | convention | /model switch racing classify | gate conjuncts include armed 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L45-L53〕 | synchronous gate read | `router-mechanism.spec.ts` "R6: explicit /model → zero override AND zero classify" | none |
| R-5 | Arming state matches the /model selection; steady overlay never disarms | ArmedNotAway, NoFeedbackDisarm | `ArmedNotAway`, `NoFeedbackDisarm` | convention; strict-self-feedback probe | overlay traffic vs observe | pre-overlay observe + frozen sanitizer publish 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L19-L38〕 | observe-before-overlay ordering | `arming.spec.ts` "steady overlay never disarms", `sanitizer-order.spec.ts` spy order | none |
| R-6 | Every escalation retry turn serves a recorded floor | NoFloorlessRetry | `NoFloorlessRetry` | convention; strict-crash-resume probe | crash between escalation dispatch and retry turn | `recordRetryUsed` precedes `followup` 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L60-L76〕 | synchronous bookkeeping write before followup | no test pins the crash window (gap) | floorless fail-open is the code's documented behavior 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L86-L91〕; the counterexample classifies it as a crash-recovery gap |
| R-7 | Subagent turns never touch shared routing state | structural (SubagentStep is UNCHANGED) | — | convention | same-numbered child turn vs root capture slot | `isSubagentAgent` at 9 writer sites 〔src:ws:specs/tla/moa-cascade-routing/code-anchors.md#L106-L115〕 | synchronous guards | `subagent-scope.spec.ts` full file | structural encoding; not a TLC state predicate |
| L-1 | A judged turn eventually produces its retry turn | excluded | — | — | — | — | — | — | needs harness turn-loop fairness; excluded |

## Faults and races explicitly modeled

1. **Self-feedback** (strict-self-feedback): if the arming observe read the
   served (overlaid) pair instead of the frozen pre-overlay pair, moa would
   disarm itself after the first overlaid turn. Expect a counterexample —
   demonstrates the necessity of the pre-overlay-observe design.
2. **Crash/resume floor loss** (strict-crash-resume): in-memory escalation
   bookkeeping lost while the typed `moa-escalation` followup survives in
   the inbox → the retry turn fails open and serves the boot selection
   instead of the escalation floor. Expect a counterexample — documented
   production seam (B6), no test pins it.

## Assumptions

- A-1: single main agent per process (agent-scope contract); ladder is
  non-degenerate and all-distinct so `nextDistinctTier(t) = t+1`.
- A-2: judge latency and the System One call are abstracted as one
  nondeterministic verdict step; the stale guard is modeled exactly
  (any genuine user turn between TurnEnd and JudgeVerdict marks stale and
  blocks action).
- A-3: judge failures (route missing, timeout, malformed probability) are
  folded into `judgeAcceptable = TRUE` (accept, no action — the fail-open
  contract `judge.ts:258-262`).
- A-4: `recordFloor` is test-only in production; the model's convention
  path creates the entry at `recordRetryUsed` time, matching production
  (B6).
- A-5: user turns cannot arrive while an escalation followup is queued but
  un-run (single-flight turn loop); relaxing this needs the full harness
  inbox model — the stale-guard race is separately modeled at the judge
  stage.

## Bounds

One origin chain; MaxEsc = 1 (chain-2 tested in the repo's own suite);
tiers 0..3; no time.

## Case plan

| Case | Coverage | Constants | Invariants | Expected |
|---|---|---|---|---|
| convention | core | MaxEsc=1, ObserveOverlay=FALSE, CrashResume=FALSE, ShadowMode=FALSE | all | verified |
| strict-self-feedback | expansion | ObserveOverlay=TRUE | TypeOK, ArmedNotAway, NoFeedbackDisarm | counterexample (design-defense necessity) |
| strict-crash-resume | expansion | CrashResume=TRUE | TypeOK, NoFloorlessRetry | counterexample (documented seam) |
| shadow-mode | expansion | ShadowMode=TRUE | TypeOK, ShadowInert, EscalationBound | verified |

## Screening section (current)

Formal design: mode `auto`, decision `enabled`, triggerIds FD-T1/T2/T3/T4,
modelDir `specs/tla/moa-cascade-routing`, review rules **not loadable**
(AGENTS.md stub) — formal review dispatch blocked.
