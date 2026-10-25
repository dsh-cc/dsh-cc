-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* ACP session prompt lifecycle: single in-flight admission slot,         *)
(* cancellation precedence, turn correlation and late turn/end             *)
(* isolation. Faithful abstraction of packages/acp/cc-acp/src/session.ts  *)
(* (prompt / cancelPrompt / settleAfterQuiescence / onSessionEvent /      *)
(* onInboxClaimed / onAgentError / close) and src/codec.ts                *)
(* (turnEndToStopReason). See design.md in this directory for the          *)
(* requirement/property mapping.                                          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT MaxTurns
ASSUME MaxTurns \in Nat \ {0}

(***************************************************************************)
(* phase: "free" (no inflight prompt), "admitting" (prompt() is running  *)
(*   admitAcpPrompt), "queued" (message handed to agent.followup, turn    *)
(*   not yet claimed), "running" (onInboxClaimed correlated a turn).      *)
(* msgQueued: inflight.messageQueued.                                     *)
(* turn: inflight.turn (0 = unassigned). nextTurn allocates turn ids for  *)
(*   both claimed prompts and autonomous/foreign turns.                   *)
(* startedTurns / endedTurns: turns whose start / end event committed.    *)
(* endReason / endTurn: inflight.endReason and the turn that wrote it.    *)
(* cancelReq: inflight.cancelRequested (set by session/cancel, a JSON-RPC *)
(*   request abort, or close()).                                          *)
(* cancelInAdmission: cancel was accepted while the prompt was still in   *)
(*   admission (before any message could be queued).                       *)
(* outputErr / agentErr: inflight.outputError / inflight.agentError.      *)
(* closing: close() was called once (memoized).                            *)
(* settled: the last settled prompt's client-visible outcome; snapshot    *)
(*   snap* variables record the decision inputs at settlement time.       *)
(* observe: the last client-visible request outcome marker.              *)
(***************************************************************************)
VARIABLES phase, msgQueued, turn, nextTurn, startedTurns, endedTurns,
          endReason, endTurn, cancelReq, cancelInAdmission, outputErr,
          agentErr, closing, settled, snapCancel, snapEndReason,
          snapOutputErr, snapAgentErr, snapAdmitFail, observe
vars == <<phase, msgQueued, turn, nextTurn, startedTurns, endedTurns,
          endReason, endTurn, cancelReq, cancelInAdmission, outputErr,
          agentErr, closing, settled, snapCancel, snapEndReason,
          snapOutputErr, snapAgentErr, snapAdmitFail, observe>>

Phases == {"free", "admitting", "queued", "running"}
EndReasons == {"none", "completed", "maxtokens", "hookabort", "interrupted", "error"}
StopReasons == {"end_turn", "max_tokens", "cancelled"}
Settleds == {"unsettled"} \cup StopReasons \cup {"rejected"}
Observations == {"none", "prompt-accepted", "busy", "closing", "admitted",
                 "admit-cancelled", "admit-failed", "settled",
                 "cancel-accepted", "closed", "autonomous-start"}

Init == /\ phase = "free"
        /\ msgQueued = FALSE
        /\ turn = 0
        /\ nextTurn = 1
        /\ startedTurns = {}
        /\ endedTurns = {}
        /\ endReason = "none"
        /\ endTurn = 0
        /\ cancelReq = FALSE
        /\ cancelInAdmission = FALSE
        /\ outputErr = FALSE
        /\ agentErr = FALSE
        /\ closing = FALSE
        /\ settled = "unsettled"
        /\ snapCancel = FALSE
        /\ snapEndReason = "none"
        /\ snapOutputErr = FALSE
        /\ snapAgentErr = FALSE
        /\ snapAdmitFail = FALSE
        /\ observe = "none"

(* codec.ts turnEndToStopReason: completed -> end_turn, max-tokens ->   *)
(* max_tokens, aborted -> end_turn ("cancelled" is reserved for explicit *)
(* client cancellation), interrupted -> cancelled.                        *)
MapStop(r) == CASE r = "completed" -> "end_turn"
                  [] r = "maxtokens" -> "max_tokens"
                  [] r = "hookabort" -> "end_turn"
                  [] r = "interrupted" -> "cancelled"

InflightReset == /\ msgQueued' = FALSE
                 /\ turn' = 0
                 /\ endReason' = "none"
                 /\ endTurn' = 0
                 /\ cancelReq' = FALSE
                 /\ cancelInAdmission' = FALSE
                 /\ outputErr' = FALSE
                 /\ agentErr' = FALSE

UnchangedTurns == UNCHANGED <<nextTurn, startedTurns, endedTurns>>
UnchangedSnaps == UNCHANGED <<snapCancel, snapEndReason, snapOutputErr,
                             snapAgentErr, snapAdmitFail>>

(***************************************************************************)
(* session.prompt head (session.ts:282-302): assertActive, single-slot    *)
(* guard ("a prompt is already in flight"), fresh InflightPrompt.        *)
(***************************************************************************)
PromptStart == /\ phase = "free"
               /\ ~closing
               /\ phase' = "admitting"
               /\ InflightReset
               /\ settled' = "unsettled"
               /\ snapCancel' = FALSE
               /\ snapEndReason' = "none"
               /\ snapOutputErr' = FALSE
               /\ snapAgentErr' = FALSE
               /\ snapAdmitFail' = FALSE
               /\ observe' = "prompt-accepted"
               /\ UnchangedTurns
               /\ UNCHANGED <<closing>>

(* session.ts:283: the second concurrent prompt is rejected invalidParams *)
(* and must not disturb the first prompt's slot.                            *)
PromptBusy == /\ phase # "free"
              /\ ~closing
              /\ observe' = "busy"
              /\ UNCHANGED <<phase, msgQueued, turn, nextTurn, startedTurns,
                             endedTurns, endReason, endTurn, cancelReq,
                             cancelInAdmission, outputErr, agentErr, closing,
                             settled, snapCancel, snapEndReason, snapOutputErr,
                             snapAgentErr, snapAdmitFail>>

(* session.ts:504-506: assertActive rejects prompts once close() started.   *)
PromptWhileClosing == /\ closing
                      /\ phase = "free"
                      /\ observe' = "closing"
                      /\ UNCHANGED <<phase, msgQueued, turn, nextTurn,
                                     startedTurns, endedTurns, endReason,
                                     endTurn, cancelReq, cancelInAdmission,
                                     outputErr, agentErr, closing, settled,
                                     snapCancel, snapEndReason, snapOutputErr,
                                     snapAgentErr, snapAdmitFail>>

(***************************************************************************)
(* Admission success (session.ts:321-333): the abort check is the guard    *)
(* (throwIfAborted), then the message is queued and followup runs in one  *)
(* synchronous block. Cancel accepted during admission therefore can      *)
(* never leave this branch (R-4).                                          *)
(***************************************************************************)
AdmitSuccess == /\ phase = "admitting"
                /\ ~cancelReq
                /\ phase' = "queued"
                /\ msgQueued' = TRUE
                /\ observe' = "admitted"
                /\ UNCHANGED <<turn, endReason, endTurn, cancelReq,
                               cancelInAdmission, outputErr, agentErr,
                               closing, settled>>
                /\ UnchangedTurns
                /\ UnchangedSnaps

(* Admission failure with cancel already accepted (session.ts:345-348    *)
(* via cancelPrompt's settleAfterQuiescence): the prompt settles          *)
(* "cancelled"; no message was ever queued.                                *)
AdmitFailCancelled == /\ phase = "admitting"
                      /\ cancelReq
                      /\ phase' = "free"
                      /\ InflightReset
                      /\ settled' = "cancelled"
                      /\ snapCancel' = TRUE
                      /\ snapEndReason' = "none"
                      /\ snapOutputErr' = FALSE
                      /\ snapAgentErr' = FALSE
                      /\ snapAdmitFail' = FALSE
                      /\ observe' = "admit-cancelled"
                      /\ UnchangedTurns
                      /\ UNCHANGED <<closing>>

(* Admission failure without cancel (session.ts:349-357): invalid content, *)
(* agent disposed outside the bridge, or a synchronous followup throw.    *)
(* The slot is freed immediately (R-5); the prompt is rejected.             *)
AdmitFailReject == /\ phase = "admitting"
                   /\ ~cancelReq
                   /\ phase' = "free"
                   /\ InflightReset
                   /\ settled' = "rejected"
                   /\ snapCancel' = FALSE
                   /\ snapEndReason' = "none"
                   /\ snapOutputErr' = FALSE
                   /\ snapAgentErr' = FALSE
                   /\ snapAdmitFail' = TRUE
                   /\ observe' = "admit-failed"
                   /\ UnchangedTurns
                   /\ UNCHANGED <<closing>>

(***************************************************************************)
(* onInboxClaimed (session.ts:430-435): the queued message is correlated   *)
(* with the next allocated turn.                                           *)
(***************************************************************************)
ClaimTurn == /\ phase = "queued"
             /\ nextTurn <= MaxTurns
             /\ phase' = "running"
             /\ turn' = nextTurn
             /\ startedTurns' = startedTurns \cup {nextTurn}
             /\ nextTurn' = nextTurn + 1
             /\ UNCHANGED <<msgQueued, endReason, endTurn, cancelReq,
                            cancelInAdmission, outputErr, agentErr, closing,
                            settled, observe>>
             /\ UNCHANGED <<endedTurns>>
             /\ UnchangedSnaps

(* Autonomous or in-process foreign producers can start turns at any time  *)
(* (turns.spec.ts:211-236, edges.spec.ts:106-121).                          *)
AutonomousTurnStart == /\ nextTurn <= MaxTurns
                       /\ startedTurns' = startedTurns \cup {nextTurn}
                       /\ nextTurn' = nextTurn + 1
                       /\ observe' = "autonomous-start"
                       /\ UNCHANGED <<phase, msgQueued, turn, endReason,
                                      endTurn, cancelReq, cancelInAdmission,
                                      outputErr, agentErr, closing, settled>>
                       /\ UNCHANGED <<endedTurns>>
                       /\ UnchangedSnaps

(***************************************************************************)
(* A durable turn/end event commits (session.ts:416-421): it writes        *)
(* inflight.endReason ONLY when it belongs to the inflight prompt's own    *)
(* turn (R-3). Foreign or late ends are ignored.                           *)
(***************************************************************************)
TurnEndEvent == /\ \E t \in (startedTurns \ endedTurns) :
                    \E r \in {"completed", "maxtokens", "hookabort",
                              "interrupted", "error"} :
                       /\ endedTurns' = endedTurns \cup {t}
                       /\ endReason' = IF phase = "running" /\ turn = t
                                       THEN r
                                       ELSE endReason
                       /\ endTurn' = IF phase = "running" /\ turn = t
                                     THEN t
                                     ELSE endTurn
                       /\ UNCHANGED <<phase, msgQueued, turn, nextTurn,
                                      startedTurns, cancelReq,
                                      cancelInAdmission, outputErr, agentErr,
                                      closing, settled, observe>>
                       /\ UnchangedSnaps

(***************************************************************************)
(* onAgentError (session.ts:442-450): an interval failure outside the     *)
(* inflight turn is attributed to the prompt; an in-turn failure is       *)
(* balanced by a durable turn/end instead. Failures while the message is  *)
(* not yet queued (admission) are NOT attributed (turns.spec.ts:365-396).  *)
(***************************************************************************)
AgentErrorEvent == /\ phase \in {"queued", "running"}
                   /\ msgQueued
                   /\ \E t \in startedTurns : t # turn
                   /\ agentErr' = TRUE
                   /\ UNCHANGED <<phase, msgQueued, turn, nextTurn,
                                  startedTurns, endedTurns, endReason,
                                  endTurn, cancelReq, cancelInAdmission,
                                  outputErr, closing, settled, observe>>
                   /\ UnchangedSnaps

(* Assistant output delivery failure for the inflight turn (session.ts:    *)
(* 381-393): recorded on the matching turn only; settlement awaits the    *)
(* ordered delivery tail, so the flag is readable at settlement (A-3).     *)
OutputErrorEvent == /\ phase = "running"
                    /\ outputErr' = TRUE
                    /\ UNCHANGED <<phase, msgQueued, turn, nextTurn,
                                   startedTurns, endedTurns, endReason,
                                   endTurn, cancelReq, cancelInAdmission,
                                   agentErr, closing, settled, observe>>
                    /\ UnchangedSnaps

(***************************************************************************)
(* session/cancel, a JSON-RPC request abort, or close() reaching          *)
(* cancelPrompt (session.ts:508-515): sets cancelRequested and aborts     *)
(* admission. With no inflight prompt, cancel targets unrelated Agent work *)
(* only (excluded, see design.md).                                        *)
(***************************************************************************)
Cancel == /\ phase # "free"
          /\ ~cancelReq
          /\ cancelReq' = TRUE
          /\ cancelInAdmission' = IF phase = "admitting"
                                 THEN TRUE
                                 ELSE cancelInAdmission
          /\ observe' = "cancel-accepted"
          /\ UNCHANGED <<phase, msgQueued, turn, nextTurn, startedTurns,
                         endedTurns, endReason, endTurn, outputErr, agentErr,
                         closing, settled>>
          /\ UnchangedSnaps

(* close() (session.ts:462-502): memoized once; cancels any inflight       *)
(* prompt first. The drain/flush/dispose ordering after the cancel is      *)
(* single-owner sequential code and is excluded (design.md E-2).            *)
Close == /\ ~closing
         /\ closing' = TRUE
         /\ cancelReq' = IF phase # "free" THEN TRUE ELSE cancelReq
         /\ cancelInAdmission' = IF phase = "admitting"
                                THEN TRUE
                                ELSE cancelInAdmission
         /\ observe' = "closed"
         /\ UNCHANGED <<phase, msgQueued, turn, nextTurn, startedTurns,
                        endedTurns, endReason, endTurn, outputErr, agentErr,
                        settled>>
         /\ UnchangedSnaps

(***************************************************************************)
(* settleAfterQuiescence body (session.ts:517-557): after admission and   *)
(* (if queued) whole-Agent quiescence, the slot is cleared exactly once    *)
(* and the client outcome follows the code's precedence chain:            *)
(* cancelRequested > outputError > agentError > endReason                  *)
(* (none -> "cancelled", error -> reject, else codec mapping).            *)
(***************************************************************************)
Settle == /\ phase \in {"queued", "running"}
          /\ (phase = "queued" \/ turn \in endedTurns)
          /\ settled' = IF cancelReq THEN "cancelled"
                        ELSE IF outputErr THEN "rejected"
                        ELSE IF agentErr THEN "rejected"
                        ELSE IF endReason = "none" THEN "cancelled"
                        ELSE IF endReason = "error" THEN "rejected"
                        ELSE MapStop(endReason)
          /\ snapCancel' = cancelReq
          /\ snapEndReason' = endReason
          /\ snapOutputErr' = outputErr
          /\ snapAgentErr' = agentErr
          /\ snapAdmitFail' = FALSE
          /\ phase' = "free"
          /\ InflightReset
          /\ observe' = "settled"
          /\ UnchangedTurns
          /\ UNCHANGED <<closing>>

TerminalStutter == /\ closing
                   /\ UNCHANGED vars

Next == PromptStart \/ PromptBusy \/ PromptWhileClosing \/ AdmitSuccess
        \/ AdmitFailCancelled \/ AdmitFailReject \/ ClaimTurn
        \/ AutonomousTurnStart \/ TurnEndEvent \/ AgentErrorEvent
        \/ OutputErrorEvent \/ Cancel \/ Close \/ Settle \/ TerminalStutter
Spec == Init /\ [][Next]_vars

(************************** properties ************************************)
TypeOK == /\ phase \in Phases
          /\ msgQueued \in BOOLEAN
          /\ turn \in 0..MaxTurns
          /\ nextTurn \in 1..MaxTurns + 1
          /\ startedTurns \subseteq 1..MaxTurns
          /\ endedTurns \subseteq startedTurns
          /\ startedTurns = 1..(nextTurn - 1)
          /\ endReason \in EndReasons
          /\ endTurn \in 0..MaxTurns
          /\ cancelReq \in BOOLEAN
          /\ cancelInAdmission \in BOOLEAN
          /\ outputErr \in BOOLEAN
          /\ agentErr \in BOOLEAN
          /\ closing \in BOOLEAN
          /\ settled \in Settleds
          /\ snapCancel \in BOOLEAN
          /\ snapEndReason \in EndReasons
          /\ snapOutputErr \in BOOLEAN
          /\ snapAgentErr \in BOOLEAN
          /\ snapAdmitFail \in BOOLEAN
          /\ observe \in Observations

(* R-1/R-5: exactly one prompt owns the slot; a claimed turn implies a    *)
(* queued message; the slot is free exactly when no message is queued.    *)
SlotConsistency == /\ msgQueued => phase \in {"queued", "running"}
                   /\ (turn # 0) <=> (phase = "running")
                   /\ (phase = "running") => msgQueued
                   /\ cancelInAdmission => phase \in {"admitting", "free"}

(* R-2: once cancel was accepted, the prompt settles "cancelled" whatever *)
(* late output errors, agent errors or turn ends arrive.                  *)
CancelWinsSettlement == snapCancel => settled = "cancelled"

(* R-3: endReason was written only by the inflight prompt's own turn; a   *)
(* late end from a cancelled or foreign turn cannot corrupt the next     *)
(* prompt (turns.spec.ts:501-514).                                         *)
LateEndIsolation == (endReason # "none") => /\ endTurn = turn
                                           /\ phase = "running"

(* R-4: cancel accepted during admission never leaves a queued message   *)
(* (turns.spec.ts:306-332).                                              *)
CancelInAdmissionNeverQueues == ~(cancelInAdmission /\ msgQueued)

(* R-7/R-8: the settled outcome is exactly the code's precedence chain.   *)
StopReasonMapping == /\ (settled = "end_turn") =>
                           /\ snapEndReason \in {"completed", "hookabort"}
                           /\ ~snapCancel /\ ~snapOutputErr
                           /\ ~snapAgentErr /\ ~snapAdmitFail
                     /\ (settled = "max_tokens") =>
                           /\ snapEndReason = "maxtokens"
                           /\ ~snapCancel /\ ~snapOutputErr
                           /\ ~snapAgentErr /\ ~snapAdmitFail
                     /\ (settled = "cancelled") =>
                           \/ snapCancel
                           \/ snapEndReason \in {"none", "interrupted"}
                     /\ (settled = "rejected") =>
                           \/ snapOutputErr \/ snapAgentErr
                           \/ snapEndReason = "error"
                           \/ snapAdmitFail

(* Strict probe (expected REFUTED): cancel accepted at ANY time prevents *)
(* the message from being queued. Counterexample is documented behavior: *)
(* cancel after admission keeps the queued message and its partial       *)
(* output (turns.spec.ts:448-459, :501-514 "partialnext").                *)
StrictCancelNeverQueues == ~(cancelReq /\ msgQueued)

(* Strict probe (expected REFUTED): a turn aborted by a hook or another  *)
(* owner settles "cancelled". Counterexample is documented behavior:     *)
(* codec.ts maps aborted -> end_turn ("cancelled" is reserved for        *)
(* explicit client cancellation; turns.spec.ts:461-471).                 *)
StrictAbortedMeansCancelled == (snapEndReason = "hookabort") => settled = "cancelled"

=============================================================================
