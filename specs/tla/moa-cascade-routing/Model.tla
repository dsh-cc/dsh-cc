--------------------------- MODULE Model ---------------------------
(***************************************************************************)
(* Bounded model of the dsh-cc moa cascade routing pipeline:              *)
(* arming truth table, per-turn classify + sticky tier overlay, turn-end  *)
(* acceptance judge, bounded escalation with floor bookkeeping, shadow    *)
(* vs ACT, subagent scope exclusion, and the pre-overlay arming observe. *)
(*                                                                         *)
(* Abstracted from packages/interaction/moa (arming.ts, router.ts,        *)
(* judge.ts, judge-route.ts, state.ts, runtime-state.ts). See            *)
(* code-anchors.md for verbatim source excerpts.                          *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS MaxEsc, ObserveOverlay, CrashResume, ShadowMode, Restorable

MaxTier == 3
NoTier == MaxTier + 1

VARIABLES state, tier, away, armed, feedbackDisarm,
          floorsDefined, floor, retries, logFloor,
          judgePending, judgeStale, judgeAcceptable,
          actedEver, lastClassifyArmed, retryTierMissing, lastServedTier

vars == <<state, tier, away, armed, feedbackDisarm,
          floorsDefined, floor, retries, logFloor,
          judgePending, judgeStale, judgeAcceptable,
          actedEver, lastClassifyArmed, retryTierMissing, lastServedTier>>

TypeOK ==
  /\ state \in {"captured", "serving", "answered", "escalated"}
  /\ tier \in 0..NoTier
  /\ away \in BOOLEAN
  /\ armed \in BOOLEAN
  /\ feedbackDisarm \in BOOLEAN
  /\ floorsDefined \in BOOLEAN
  /\ floor \in 0..MaxTier
  /\ retries \in 0..3
  /\ logFloor \in 0..MaxTier
  /\ judgePending \in BOOLEAN
  /\ judgeStale \in BOOLEAN
  /\ judgeAcceptable \in BOOLEAN
  /\ actedEver \in BOOLEAN
  /\ lastClassifyArmed \in BOOLEAN
  /\ retryTierMissing \in BOOLEAN
  /\ lastServedTier \in 0..NoTier

(* ----------------------------------------------------------------------- *)
(* Init: enabled at mount, validation ok, boot pair captured, no /model.  *)
(* ----------------------------------------------------------------------- *)

Init ==
  /\ state = "captured"
  /\ tier = NoTier
  /\ away = FALSE
  /\ armed = TRUE
  /\ feedbackDisarm = FALSE
  /\ floorsDefined = FALSE
  /\ floor = 0
  /\ retries = 0
  /\ logFloor = 0
  /\ judgePending = FALSE
  /\ judgeStale = FALSE
  /\ judgeAcceptable = TRUE
  /\ actedEver = FALSE
  /\ lastClassifyArmed = TRUE
  /\ retryTierMissing = FALSE
  /\ lastServedTier = NoTier

(* ----------------------------------------------------------------------- *)
(* A genuine user turn opens. A new origin seq gets a fresh, empty         *)
(* bookkeeping entry; a pending detached judge goes stale.                 *)
(* ----------------------------------------------------------------------- *)

UserTurn ==
  /\ state \in {"serving", "answered", "captured"}
  /\ state' = "captured"
  /\ tier' = NoTier
  /\ retries' = 0
  /\ floorsDefined' = FALSE
  /\ floor' = 0
  /\ judgeStale' = IF judgePending THEN TRUE ELSE judgeStale
  /\ judgePending' = judgePending
  /\ armed' = armed
  /\ logFloor' = logFloor
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* ----------------------------------------------------------------------- *)
(* Request-level arming observe.                                           *)
(* Convention: the observe reads the PRE-overlay selection (the frozen     *)
(* boot pair published by the sanitizer), so a steady overlay never        *)
(* disarms.                                                                *)
(* Strict probe (ObserveOverlay = TRUE): the observe reads the served      *)
(* (overlaid) pair of the previous turn and disarms moa through its own    *)
(* traffic - the self-feedback trap the pre-overlay observe prevents.     *)
(* ----------------------------------------------------------------------- *)

RequestObserve ==
  /\ state = "captured"
  /\ logFloor' = logFloor
  /\ IF ObserveOverlay /\ lastServedTier # NoTier /\ lastServedTier > 0 /\ armed
       THEN /\ armed' = FALSE
            /\ feedbackDisarm' = TRUE
       ELSE IF ~away
              THEN /\ armed' = TRUE
                   /\ feedbackDisarm' = feedbackDisarm
              ELSE /\ armed' = FALSE
                   /\ feedbackDisarm' = feedbackDisarm
  /\ tier' = tier
  /\ state' = state
  /\ away' = away
  /\ floorsDefined' = floorsDefined
  /\ floor' = floor
  /\ retries' = retries
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* ----------------------------------------------------------------------- *)
(* Classification (System One route decision) on the first request of a    *)
(* genuine user turn: nondeterministic tier over the four-rung ladder.    *)
(* Guard: armed (armed && validation.ok && main agent && boot pair).      *)
(* ----------------------------------------------------------------------- *)

Classify ==
  /\ state = "captured"
  /\ armed
  /\ ~away
  /\ \E t \in 0..MaxTier :
       /\ tier' = t
  /\ state' = "serving"
  /\ lastClassifyArmed' = TRUE
  /\ armed' = armed
  /\ logFloor' = logFloor
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ floorsDefined' = floorsDefined
  /\ floor' = floor
  /\ retries' = retries
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* Fail-open serving: unarmed / disabled / gate failure / subagent       *)
(* exclusion - the wire serves the live selection with no tier.           *)

FailOpenServe ==
  /\ state = "captured"
  /\ state' = "serving"
  /\ tier' = NoTier
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ armed' = armed
  /\ logFloor' = logFloor
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ floorsDefined' = floorsDefined
  /\ floor' = floor
  /\ retries' = retries
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* ----------------------------------------------------------------------- *)
(* /model away from the boot pair disarms immediately; switching back     *)
(* re-arms (arming.ts truth table).                                       *)
(* ----------------------------------------------------------------------- *)

ModelSwitchAway ==
  /\ away' = TRUE
  /\ logFloor' = logFloor
  /\ armed' = FALSE
  /\ feedbackDisarm' = feedbackDisarm
  /\ state' = state
  /\ tier' = tier
  /\ floorsDefined' = floorsDefined
  /\ floor' = floor
  /\ retries' = retries
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

ModelSwitchBack ==
  /\ away' = FALSE
  /\ logFloor' = logFloor
  /\ armed' = TRUE
  /\ feedbackDisarm' = feedbackDisarm
  /\ state' = state
  /\ tier' = tier
  /\ floorsDefined' = floorsDefined
  /\ floor' = floor
  /\ retries' = retries
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* ----------------------------------------------------------------------- *)
(* Turn end: a snapshot is captured synchronously, then the acceptance    *)
(* judge runs detached. The verdict value is nondeterministic.            *)
(* ----------------------------------------------------------------------- *)

TurnEnd ==
  /\ state = "serving"
  /\ state' = "answered"
  /\ lastServedTier' = tier
  /\ judgePending' = TRUE
  /\ judgeStale' = FALSE
  /\ \E acc \in BOOLEAN : judgeAcceptable' = acc
  /\ armed' = armed
  /\ logFloor' = logFloor
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ tier' = tier
  /\ floorsDefined' = floorsDefined
  /\ floor' = floor
  /\ retries' = retries
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing

(* ----------------------------------------------------------------------- *)
(* Judge verdict.                                                          *)
(*  - acceptable (or any judge failure) => accept, no action.             *)
(*  - unacceptable + shadow => log only, never act.                       *)
(*  - unacceptable + ACT + fresh (not stale) + budget left + a distinct   *)
(*    rung above => recordRetryUsed (floor := tier+1, retries++), then    *)
(*    dispatch the moa-escalation followup (release() precedes followup,  *)
(*    so the entry exists before the retry turn runs).                    *)
(* ----------------------------------------------------------------------- *)

JudgeVerdict ==
  /\ judgePending
  /\ judgePending' = FALSE
  /\ IF ~judgeAcceptable
       /\ ~ShadowMode
       /\ ~judgeStale
       /\ tier # NoTier
       /\ retries < MaxEsc
       /\ tier < MaxTier
       THEN /\ retries' = retries + 1
            /\ floorsDefined' = TRUE
            /\ floor' = tier + 1
            /\ actedEver' = TRUE
            /\ logFloor' = tier + 1
            /\ state' = "escalated"
       ELSE /\ retries' = retries
            /\ floorsDefined' = floorsDefined
            /\ floor' = floor
            /\ actedEver' = actedEver
            /\ logFloor' = logFloor
            /\ state' = "answered"
  /\ armed' = armed
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ tier' = tier
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* ----------------------------------------------------------------------- *)
(* The escalation followup becomes the next turn (an idle-wake retry).    *)
(* It is NEVER re-classified; it serves the recorded floor tier. If the   *)
(* in-memory bookkeeping was lost (crash/resume between the escalation    *)
(* dispatch and the retry turn), floorFor(originSeq) is undefined and      *)
(* tierForTurn fails open - the retry turn serves the live selection.      *)
(* ----------------------------------------------------------------------- *)

RetryTurn ==
  /\ state = "escalated"
  /\ state' = "serving"
  /\ IF floorsDefined
       THEN /\ tier' = floor
            /\ retryTierMissing' = retryTierMissing
       ELSE IF Restorable /\ logFloor > 0
            (* PR #301 (F-3): the typed moa-escalation followup is durable, so
               the floor is rebuilt from the log instead of failing open. *)
            THEN /\ tier' = logFloor
                 /\ retryTierMissing' = retryTierMissing
            ELSE /\ tier' = NoTier
                 /\ retryTierMissing' = TRUE
  /\ floorsDefined' = (floorsDefined \/ (Restorable /\ logFloor > 0))
  /\ floor' = IF floorsDefined THEN floor ELSE logFloor
  /\ armed' = armed
  /\ logFloor' = logFloor
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ retries' = retries
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ lastServedTier' = lastServedTier

(* Strict probe only: the process crashes and resumes between the        *)
(* escalation dispatch and the retry turn; the in-memory escalation        *)
(* bookkeeping (EscalationBookkeeping map) is lost while the typed         *)
(* followup survives in the inbox.                                        *)

Crash ==
  /\ CrashResume
  /\ state = "escalated"
  /\ floorsDefined' = FALSE
  /\ floor' = 0
  /\ retries' = 0
  (* logFloor survives: the followup is durable in the session log. *)
  /\ state' = state
  /\ tier' = tier
  /\ armed' = armed
  /\ logFloor' = logFloor
  /\ away' = away
  /\ feedbackDisarm' = feedbackDisarm
  /\ judgePending' = judgePending
  /\ judgeStale' = judgeStale
  /\ judgeAcceptable' = judgeAcceptable
  /\ actedEver' = actedEver
  /\ lastClassifyArmed' = lastClassifyArmed
  /\ retryTierMissing' = retryTierMissing
  /\ lastServedTier' = lastServedTier

(* A subagent turn (same-numbered child turn, Task tool inside the root   *)
(* turn): structurally excluded from every shared-state writer - the      *)
(* action changes nothing.                                                 *)

SubagentStep == UNCHANGED vars

Idle == UNCHANGED vars

Next ==
  \/ UserTurn
  \/ RequestObserve
  \/ Classify
  \/ FailOpenServe
  \/ ModelSwitchAway
  \/ ModelSwitchBack
  \/ TurnEnd
  \/ JudgeVerdict
  \/ RetryTurn
  \/ Crash
  \/ SubagentStep
  \/ Idle

Spec == Init /\ [][Next]_vars

(* ----------------------------------------------------------------------- *)
(* Invariants                                                               *)
(* ----------------------------------------------------------------------- *)

(* S-1: escalation budget: at most MaxEsc retries per origin, hard       *)
(* ceiling 3.                                                              *)
EscalationBound == retries <= MaxEsc /\ MaxEsc <= 3

(* S-2: an escalation floor is always above the boot rung (tier 0) and    *)
(* every recorded floor comes with at least one executed retry.           *)
FloorAboveBoot == floorsDefined => floor >= 1 /\ retries >= 1

(* S-3: shadow mode never acts - no followup, no escalation, no retry     *)
(* turn, regardless of the verdict.                                        *)
ShadowInert == ShadowMode => ~actedEver /\ state # "escalated"

(* S-4: every classification happened while the machine was armed         *)
(* (unarmed / disabled / gate-failed turns fail open instead).            *)
ClassifyOnlyArmed == lastClassifyArmed

(* S-5: armed and away are complementary: an explicit /model away is the  *)
(* only disarm cause in this model, and returning to the boot pair        *)
(* re-arms. Under the pre-overlay observe a steady overlay never          *)
(* disarms.                                                                *)
ArmedNotAway == armed = ~away

(* S-6: every escalation retry turn serves a recorded floor tier (no      *)
(* floorless retry). Violated only by the crash-resume probe.            *)
NoFloorlessRetry == ~retryTierMissing

(* S-7: moa never disarms itself through its own overlay traffic          *)
(* (self-feedback stability).                                             *)
NoFeedbackDisarm == ~feedbackDisarm

=============================================================================
