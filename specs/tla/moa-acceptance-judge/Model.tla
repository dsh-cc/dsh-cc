---- MODULE Model ----
(***************************************************************************)
(* MOA acceptance-dimensions judge loop (S1-10): the inFlight placeholder  *)
(* token guard, the completed LRU, repeated stops, mode-switch cancellation *)
(* and the tool-turn observe-only rule.                                    *)
(* Behavioral source:                                                     *)
(* docs/plans/2026-11-02-systemone-10-moa-acceptance.md -- the lifecycle   *)
(* section (WeakMap<Agent,{token,key}>, completed LRU, the finally guard, *)
(* mode precedence) and the modes/failure table (a tool-using turn is      *)
(* observe-only in every mode).                                            *)
(*                                                                        *)
(* This is a new state machine layered on the escalation flow modeled by   *)
(* specs/tla/moa-cascade-routing (which keeps the ladder/escalation       *)
(* semantics); the S1-10 concern here is the placeholder guard itself.    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS WrongTokenFinally,  (* probe: an old finally deletes a newer     *)
          LegacyUnderShadow,  (* probe: the legacy judge dispatches while    *)
                             (* dimensions shadow is on                     *)
                                (* placeholder                              *)
          RedispatchCompleted, (* probe: a completed stop judged again     *)
          ModeSwitchRaces,    (* probe: a new placeholder starts before    *)
                                (* the cancelled old one settles           *)
          ToolTurnEscalates,  (* probe: a tool-using turn escalates        *)
          CancelResurrect    (* probe: a repeated stop clears the          *)
                             (* cancellation of the in-flight generation   *)

STOPS == 1..2
TOKENS == 1..2

VARIABLES stop, pTok, pStop, completed, reqCount, followCount, toolTurn,
          cancelled, resultOk, dimsShadow, legacyDispatched, actedThisTurn,
          faults

vars == <<stop, pTok, pStop, completed, reqCount, followCount, toolTurn,
          cancelled, resultOk, dimsShadow, legacyDispatched, actedThisTurn,
          faults>>

ZeroCount == [k \in STOPS |-> 0]

TypeOK ==
  /\ stop \in STOPS \union {0}
  /\ pTok \in TOKENS \union {0}
  /\ pStop \in STOPS \union {0}
  /\ completed \subseteq STOPS
  /\ resultOk \subseteq STOPS
  /\ \A k \in STOPS : reqCount[k] \in Nat /\ followCount[k] \in Nat
  /\ toolTurn \in BOOLEAN
  /\ cancelled \in BOOLEAN
  /\ dimsShadow \in BOOLEAN
  /\ legacyDispatched \in BOOLEAN
  /\ actedThisTurn \in BOOLEAN
  /\ faults \subseteq {"stale-finally", "late-request", "raced-placeholder",
                       "tool-turn-acted", "legacy-under-shadow", "cancel-resurrect"}

Init ==
  /\ stop = 0
  /\ pTok = 0
  /\ pStop = 0
  /\ completed = {}
  /\ resultOk = {}
  /\ reqCount = ZeroCount
  /\ followCount = ZeroCount
  /\ toolTurn = FALSE
  /\ cancelled = FALSE
  /\ dimsShadow = FALSE
  /\ legacyDispatched = FALSE
  /\ actedThisTurn = FALSE
  /\ faults = {}

(************************************** stops ******************************)

(* A stop arrives for a (possibly new) answer. A repeated stop hitting an *)
(* in-flight placeholder or a completed entry issues zero requests.       *)
StopArrive(k, tool) ==
  /\ k \notin completed
  /\ (k # stop \/ tool = toolTurn)
  /\ stop' = k
  /\ toolTurn' = tool
  /\ IF CancelResurrect
       THEN /\ cancelled' = FALSE
            /\ faults' = faults \cup {"cancel-resurrect"}
       ELSE /\ cancelled' = IF pTok # 0 THEN cancelled ELSE FALSE
            /\ faults' = faults
  /\ legacyDispatched' = FALSE
  /\ actedThisTurn' = FALSE
  /\ IF pStop = k \/ k \in completed
       THEN /\ pTok' = pTok
            /\ pStop' = pStop
            /\ UNCHANGED <<completed, reqCount, followCount, resultOk,
                            dimsShadow>>
       ELSE /\ pTok' = pTok
            /\ pStop' = pStop
            /\ UNCHANGED <<completed, reqCount, followCount, resultOk,
                            dimsShadow>>

(* The repeated-stop case for an already completed key: recorded, no     *)
(* request, no self-retry.                                                *)
StopArriveCompleted(k, tool) ==
  /\ k \in completed
  /\ (k # stop \/ tool = toolTurn)
  /\ (RedispatchCompleted => completed' = completed)
  /\ stop' = k
  /\ toolTurn' = tool
  /\ cancelled' = FALSE
  /\ legacyDispatched' = FALSE
  /\ actedThisTurn' = FALSE
  /\ IF RedispatchCompleted
       THEN /\ pTok' = 0
            /\ pStop' = k
            /\ faults' = faults \cup {"late-request"}
            /\ reqCount' = [reqCount EXCEPT ![k] = reqCount[k] + 1]
            /\ UNCHANGED <<followCount, resultOk, dimsShadow>>
       ELSE /\ pTok' = pTok
            /\ pStop' = pStop
            /\ UNCHANGED <<completed, reqCount, followCount, resultOk, dimsShadow,
                            faults>>

(************************************** dispatch ***************************)

(* No placeholder in flight for this key and the key is not completed:    *)
(* dispatch the judgement with a fresh unique token.                      *)
JudgeDispatch(t) ==
  /\ stop # 0
  /\ stop \notin completed
  /\ pTok = 0
  /\ ~cancelled
  /\ pTok' = t
  /\ pStop' = stop
  /\ reqCount' = [reqCount EXCEPT ![stop] = reqCount[stop] + 1]
  /\   /\   /\ UNCHANGED <<stop,completed,followCount,toolTurn,cancelled,resultOk,
                  dimsShadow,legacyDispatched,actedThisTurn,faults>>

(* The mode-switch race: a new placeholder starts before the cancelled    *)
(* old one settles (forbidden by the design).                             *)
(* Probe: a new placeholder starts while the cancelled old one is still *)
(* in flight (the design forbids this: a new generation waits for the     *)
(* old placeholder to settle).                                           *)
RacedDispatch(t) ==
  /\ ModeSwitchRaces
  /\ cancelled
  /\ pTok # 0
  /\ stop # 0
  /\ stop \notin completed
  /\ pTok' = t
  /\ pStop' = stop
  /\ reqCount' = [reqCount EXCEPT ![stop] = reqCount[stop] + 1]
  /\ faults' = faults \cup {"raced-placeholder"}
  /\   /\   /\ UNCHANGED <<stop,completed,followCount,toolTurn,cancelled,resultOk,
                  dimsShadow,legacyDispatched,actedThisTurn>>

(************************************** settlement *************************)

(* The judgement settles (answered or unavailable): the placeholder is   *)
(* deleted only when the settling token is its own; the key is marked    *)
(* completed either way, so the same stop never self-retries.              *)
(* The settlement may also arrive late, after a mode-switch cancel.    *)
(* ok = the judgement answered (a genuine verdict). An unavailable or   *)
(* cancelled settlement still completes the key (no self-retry) but is   *)
(* never actionable.                                                      *)
JudgeSettle(t, ok) ==
  /\ pTok = t
  /\ completed' = completed \union {pStop}
  /\ resultOk' = IF ok /\ ~cancelled
                    THEN resultOk \union {pStop}
                    ELSE resultOk
  /\ pTok' = 0
  /\ pStop' = 0
  /\   /\   /\ UNCHANGED <<stop,reqCount,followCount,toolTurn,cancelled,dimsShadow,
                  legacyDispatched,actedThisTurn,faults>>

(* The old task's finally runs with a mismatched token: it must not      *)
(* delete the newer placeholder.                                         *)
StaleFinally ==
  /\ pTok # 0
  /\ WrongTokenFinally
  /\ pTok' = 0
  /\ pStop' = 0
  /\ faults' = faults \cup {"stale-finally"}
  /\   /\   /\ UNCHANGED <<stop,completed,reqCount,followCount,toolTurn,cancelled,
                  resultOk,dimsShadow,legacyDispatched,actedThisTurn>>

(* A mode switch (or dispose) cancels the old request; the old finally    *)
(* must not clear a later placeholder (that path is StaleFinally).        *)
(* The mode switch cancels the request; the old placeholder stays in   *)
(* flight until its own (late) settlement.                                *)
ModeSwitchCancel ==
  /\ pTok # 0
  /\ ~cancelled
  /\ cancelled' = TRUE
  /\   /\   /\ UNCHANGED <<stop,pTok,pStop,completed,reqCount,followCount,toolTurn,
                  resultOk,dimsShadow,legacyDispatched,actedThisTurn,
                  faults>>

(* dimensions shadow disables the same round's legacy judge: while it is  *)
(* on, the legacy judge must never dispatch (at most one judge per stop). *)
DimsShadowOn ==
  /\ ~dimsShadow
  /\ ~legacyDispatched
  /\ dimsShadow' = TRUE
  /\   /\   /\ UNCHANGED <<stop,pTok,pStop,completed,reqCount,followCount,toolTurn,
                  cancelled,resultOk,legacyDispatched,actedThisTurn,
                  faults>>

LegacyJudgeDispatch ==
  /\ ~dimsShadow
  /\ ~legacyDispatched
  /\ legacyDispatched' = TRUE
  /\   /\   /\ UNCHANGED <<stop,pTok,pStop,completed,reqCount,followCount,toolTurn,
                  cancelled,resultOk,dimsShadow,actedThisTurn,faults>>

(* Probe: the legacy judge dispatches while dimensions shadow is on.      *)
LegacyUnderShadowProbe ==
  /\ LegacyUnderShadow
  /\ dimsShadow
  /\ legacyDispatched' = TRUE
  /\ faults' = faults \union {"legacy-under-shadow"}
  /\   /\   /\ UNCHANGED <<stop,pTok,pStop,completed,reqCount,followCount,toolTurn,
                  cancelled,resultOk,dimsShadow,actedThisTurn>>

(************************************** acting *****************************)

(* Only active + ACT permitted + reject escalates, and only for an       *)
(* effect-free, tool-free turn; a tool-using turn is observe-only in      *)
(* every mode. The dimensions-shadow precedence is pinned below by      *)
(* ShadowSuppressesLegacy.                                                *)
Escalate ==
  /\ ~cancelled
  /\ stop # 0
  /\ stop \in completed
  /\ stop \in resultOk
  /\ followCount[stop] = 0
  /\ IF toolTurn
       THEN /\ followCount' = followCount
            /\ actedThisTurn' = actedThisTurn
            /\ UNCHANGED <<stop, pTok, pStop, completed, reqCount, toolTurn,
                            cancelled, resultOk, dimsShadow, legacyDispatched,
                            faults>>
       ELSE /\ followCount' = [followCount EXCEPT ![stop] =
                                 followCount[stop] + 1]
            /\ actedThisTurn' = TRUE
            /\ UNCHANGED <<stop, pTok, pStop, completed, reqCount, toolTurn,
                            cancelled, resultOk, dimsShadow, legacyDispatched,
                            faults>>

(* Probe: a tool-using turn escalates (the observe-only rule violated).   *)
EscalateToolTurn ==
  /\ ToolTurnEscalates
  /\ ~cancelled
  /\ stop # 0
  /\ stop \in completed
  /\ toolTurn
  /\ followCount[stop] = 0
  /\ followCount' = [followCount EXCEPT ![stop] = followCount[stop] + 1]
  /\ faults' = faults \cup {"tool-turn-acted"}
  /\   /\   /\ UNCHANGED <<stop,pTok,pStop,completed,reqCount,toolTurn,cancelled,
                  resultOk,dimsShadow,legacyDispatched,actedThisTurn>>

Idle == UNCHANGED vars

Next == \/ \E k \in STOPS : StopArrive(k, FALSE) \/
                             StopArrive(k, TRUE) \/
                             StopArriveCompleted(k, FALSE) \/
                             StopArriveCompleted(k, TRUE)
        \/ \E t \in TOKENS : JudgeDispatch(t) \/ RacedDispatch(t)
        \/ \E t \in TOKENS : JudgeSettle(t, TRUE) \/ JudgeSettle(t, FALSE)
        \/ StaleFinally \/ ModeSwitchCancel \/ DimsShadowOn \/
           LegacyJudgeDispatch \/ LegacyUnderShadowProbe \/
           Escalate \/ EscalateToolTurn \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

(* Every guard the design demands; each probe injects one fault into the *)
(* fault set, so an empty fault set means all guards hold.               *)
NoFaults == faults = {}

(* A stop is judged at most once: one network request per stop.           *)
OneRequestPerStop == \A k \in STOPS : reqCount[k] <= 1

(* A completed stop is never re-judged.                                   *)
CompletedStaysSettled == \A k \in STOPS :
  k \in completed => pStop # k

(* A tool-using turn never escalates: observe-only in every mode,        *)
(* enforced structurally (the probe additionally injects the fault).      *)
ToolTurnNeverActed ==
  (toolTurn => ~actedThisTurn) /\
  (~"tool-turn-acted" \in faults)

(* A cancelled request's placeholder is gone before a new one starts.    *)
NoRacedPlaceholder ==
  ~"raced-placeholder" \in faults

(* While dimensions shadow is on, the legacy judge never dispatches       *)
(* (at most one judge per stop; the precedence rule).                     *)
ShadowSuppressesLegacy == dimsShadow => ~legacyDispatched

(* A repeated stop never resurrects a cancelled generation's result.       *)
NoCancelResurrect == ~"cancel-resurrect" \in faults

(* The finally guard: a placeholder is deleted only by its own token.    *)
NoStaleFinallyDelete ==
  ~"stale-finally" \in faults

=============================================================================
