-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* Background dream-task lifecycle (memory-consolidation): cancel,         *)
(* completion and bounded retry. Faithful abstraction of                  *)
(* packages/memory/memory-consolidation/src/{index,memory-job}.ts.        *)
(* See design.md in this directory for the requirement/property mapping.  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT MaxAttempts
ASSUME MaxAttempts \in Nat \ {0}

(***************************************************************************)
(* final: the dream window's terminal state ("none" while active).         *)
(* attempt: 0 before the dream starts, else the current attempt number.   *)
(* phase: "idle" (no window), "running" (child in flight), "mapping"       *)
(*   (child settled, outcome-mapping handler not yet run), "writing"      *)
(*   (handler read aborted=FALSE and the host-side write-back is in       *)
(*   flight), "settled" (this attempt's outcome is determined).            *)
(* childState: the current attempt's child result.                         *)
(* aborted: the current attempt's AbortController state.                   *)
(* abortBeforeSettle: cancel was accepted while the child was still        *)
(*   unsettled (the completion message had NOT yet arrived).               *)
(* readAborted: the value the handler read when it ran.                    *)
(* outcome: the current attempt's mapped outcome.                          *)
(* writesPerformed / writeAttempt: a durable memory write (full or         *)
(*   partial) happened, tagged with the attempt that performed it.         *)
(* respawns: retry spawns so far.                                         *)
(* lock: "free" | "held" | "committed" | "rolled-back".                    *)
(* markerCleared: the pressure marker was tombstoned on success.          *)
(***************************************************************************)
VARIABLES final, attempt, phase, childState, aborted, abortBeforeSettle, 
          readAborted, outcome, writesPerformed, writeAttempt, respawns, 
          lock, markerCleared
vars == <<final, attempt, phase, childState, aborted, abortBeforeSettle, 
          readAborted, outcome, writesPerformed, writeAttempt, respawns, 
          lock, markerCleared>>

AttemptPhases == {"running", "mapping", "writing", "settled"}
ChildResults == {"unsettled", "completed", "error", "rejected"}
Outcomes == {"none", "completed", "killed", "failed"}
Finals == {"none", "success", "cancelled", "failed"}
Locks == {"free", "held", "committed", "rolled-back"}

Init == /\ final = "none"
        /\ attempt = 0
        /\ phase = "idle"
        /\ childState = "unsettled"
        /\ aborted = FALSE
        /\ abortBeforeSettle = FALSE
        /\ readAborted = FALSE
        /\ outcome = "none"
        /\ writesPerformed = FALSE
        /\ writeAttempt = 0
        /\ respawns = 0
        /\ lock = "free"
        /\ markerCleared = FALSE

(***************************************************************************)
(* Gates passed and the consolidation lock was acquired (tryAcquireLock):  *)
(* the dream window opens with attempt 1. Admission (gates, single-flight,*)
(* lock contention) is environment, not lifecycle.                         *)
(***************************************************************************)
StartDream == /\ phase = "idle"
              /\ final = "none"
              /\ attempt' = 1
              /\ phase' = "running"
              /\ childState' = "unsettled"
              /\ aborted' = FALSE
              /\ abortBeforeSettle' = FALSE
              /\ readAborted' = FALSE
              /\ outcome' = "none"
              /\ lock' = "held"
              /\ UNCHANGED <<final, writesPerformed, writeAttempt, 
                             respawns, markerCleared>>

(***************************************************************************)
(* The fork's result promise settles (memory-job.ts run.result): with a    *)
(* completed stopReason, a child-level error stopReason, or an            *)
(* infrastructure rejection. One settlement per attempt (A-3).            *)
(***************************************************************************)
ChildSettles == /\ phase = "running"
                /\ outcome = "none"
                /\ childState' \in {"completed", "error", "rejected"}
                /\ phase' = "mapping"
                /\ UNCHANGED <<final, attempt, aborted, abortBeforeSettle, 
                             readAborted, outcome, writesPerformed, 
                             writeAttempt, respawns, lock, markerCleared>>

(***************************************************************************)
(* controller.abort() — via job.abort(reason) or the agent-disposal        *)
(* effect. Enabled while this attempt's outcome is undetermined: while the *)
(* child runs, after it settled but before the handler read, or while the  *)
(* write-back is in flight (the last is the real race window: the handler  *)
(* already read aborted=FALSE, so the write still completes). After the   *)
(* outcome is determined abort() is a no-op on the resolved promise.       *)
(* It targets only the CURRENT attempt: the original job handle cannot     *)
(* abort a retry (each startMemoryJob call owns a fresh controller).      *)
(***************************************************************************)
Abort == /\ phase \in {"running", "mapping", "writing"}
         /\ outcome = "none"
         /\ aborted' = TRUE
         /\ abortBeforeSettle' = IF phase = "running" THEN TRUE 
                                 ELSE abortBeforeSettle
         /\ UNCHANGED <<final, attempt, phase, childState, readAborted, 
                       outcome, writesPerformed, writeAttempt, respawns, 
                       lock, markerCleared>>

(***************************************************************************)
(* The outcome-mapping handler (memory-job.ts done): reads                 *)
(* controller.signal.aborted FIRST, then the child result. The read and    *)
(* the write-back are separate steps — this is the modeled non-atomicity.  *)
(***************************************************************************)
RunHandler == /\ phase = "mapping"
              /\ outcome = "none"
              /\ readAborted' = aborted
              /\ \/ /\ aborted
                   /\ outcome' = "killed"
                   /\ phase' = "settled"
                   /\ UNCHANGED <<writesPerformed, writeAttempt>>
                 \/ /\ ~aborted
                   /\ childState # "completed"
                   /\ outcome' = "failed"
                   /\ phase' = "settled"
                   /\ UNCHANGED <<writesPerformed, writeAttempt>>
                 \/ /\ ~aborted
                   /\ childState = "completed"
                   /\ phase' = "writing"
                   /\ outcome' = "none"
                   /\ UNCHANGED <<writesPerformed, writeAttempt>>
              /\ UNCHANGED <<final, attempt, childState, aborted, 
                            abortBeforeSettle, respawns, lock, markerCleared>>

(***************************************************************************)
(* validateMemoryWrites + writeMemoryFiles succeed: the batch is persisted *)
(* host-side and the outcome is completed.                                 *)
(***************************************************************************)
WriteCommit == /\ phase = "writing"
               /\ outcome' = "completed"
               /\ phase' = "settled"
               /\ writesPerformed' = TRUE
               /\ writeAttempt' = attempt
               /\ UNCHANGED <<final, attempt, childState, aborted, 
                             abortBeforeSettle, readAborted, respawns, 
                             lock, markerCleared>>

(***************************************************************************)
(* F-3: writeMemoryFiles throws mid-loop (per-file writes, non-atomic):    *)
(* the outcome is failed but PARTIAL durable writes remain.                 *)
(***************************************************************************)
WriteThrow == /\ phase = "writing"
              /\ outcome' = "failed"
              /\ phase' = "settled"
              /\ writesPerformed' = TRUE
              /\ writeAttempt' = attempt
              /\ UNCHANGED <<final, attempt, childState, aborted, 
                            abortBeforeSettle, readAborted, respawns, 
                            lock, markerCleared>>

(***************************************************************************)
(* The index.ts outcome dispatch (job.done.then): completed commits the    *)
(* lock (success stamp doubles as lastConsolidatedAt) and tombs the        *)
(* pressure marker; killed rolls the lock back and NEVER respawns; failed  *)
(* gets exactly one retry reusing the held lock (fresh controller, same    *)
(* prompt) — or the retry dispatch itself throws (F-4) and rolls back; a   *)
(* failed retry at the bound rolls back with no third attempt.             *)
(***************************************************************************)
HandleOutcome == /\ phase = "settled"
                 /\ final = "none"
                 /\ \/ /\ outcome = "completed"
                      /\ final' = "success"
                      /\ lock' = "committed"
                      /\ markerCleared' = TRUE
                      /\ UNCHANGED <<attempt, phase, childState, aborted, 
                                    abortBeforeSettle, readAborted, 
                                    outcome, writesPerformed, 
                                    writeAttempt, respawns>>
                   \/ /\ outcome = "killed"
                      /\ final' = "cancelled"
                      /\ lock' = "rolled-back"
                      /\ UNCHANGED <<attempt, phase, childState, aborted, 
                                    abortBeforeSettle, readAborted, 
                                    outcome, writesPerformed, 
                                    writeAttempt, respawns, markerCleared>>
                   \/ /\ outcome = "failed"
                      /\ attempt < MaxAttempts
                      /\ \/ (* retry spawn: fresh attempt state *)
                             /\ attempt' = attempt + 1
                             /\ respawns' = respawns + 1
                             /\ phase' = "running"
                             /\ childState' = "unsettled"
                             /\ aborted' = FALSE
                             /\ abortBeforeSettle' = FALSE
                             /\ readAborted' = FALSE
                             /\ outcome' = "none"
                             /\ UNCHANGED <<final, writesPerformed, 
                                           writeAttempt, lock, 
                                           markerCleared>>
                           \/ (* F-4: the retry dispatch throws *)
                             /\ final' = "failed"
                             /\ lock' = "rolled-back"
                             /\ UNCHANGED <<attempt, phase, childState, 
                                           aborted, abortBeforeSettle, 
                                           readAborted, outcome, 
                                           writesPerformed, writeAttempt, 
                                           respawns, markerCleared>>
                   \/ /\ outcome = "failed"
                      /\ attempt = MaxAttempts
                      /\ final' = "failed"
                      /\ lock' = "rolled-back"
                      /\ UNCHANGED <<attempt, phase, childState, aborted, 
                                    abortBeforeSettle, readAborted, 
                                    outcome, writesPerformed, 
                                    writeAttempt, respawns, markerCleared>>

TerminalStutter == /\ final # "none"
                   /\ UNCHANGED vars

Next == StartDream \/ ChildSettles \/ Abort \/ RunHandler \/ WriteCommit 
        \/ WriteThrow \/ HandleOutcome \/ TerminalStutter
Spec == Init /\ [][Next]_vars

(************************** properties ************************************)
TypeOK == /\ final \in Finals
          /\ attempt \in 0..MaxAttempts
          /\ phase \in {"idle"} \cup AttemptPhases
          /\ childState \in ChildResults
          /\ aborted \in BOOLEAN
          /\ abortBeforeSettle \in BOOLEAN
          /\ readAborted \in BOOLEAN
          /\ outcome \in Outcomes
          /\ writesPerformed \in BOOLEAN
          /\ writeAttempt \in 0..MaxAttempts
          /\ respawns \in 0..MaxAttempts
          /\ lock \in Locks
          /\ markerCleared \in BOOLEAN

AttemptBound == /\ (phase = "idle") <=> (attempt = 0)
                /\ attempt <= MaxAttempts
                /\ respawns <= MaxAttempts - 1

(* R-1 (Q1): a completion message that arrives AFTER cancel was accepted  *)
(* cannot complete the attempt. *)
LateCompleteCannotComplete == abortBeforeSettle => outcome # "completed"

(* R-3 (Q3): a killed window is terminal — lock rolled back, no respawn.  *)
KilledStable == (final = "cancelled") => lock = "rolled-back"

(* R-2/R-3: success commits the lock and the marker, and its durable      *)
(* write is attributed to the attempt that completed. *)
SuccessCommits == (final = "success") => /\ lock = "committed"
                                         /\ markerCleared
                                         /\ writesPerformed
                                         /\ writeAttempt = attempt

(* R-2 (Q2): only a current-or-past attempt's write is on record; success  *)
(* is always attributed to the final attempt (with SuccessCommits). *)
FinalWriteFromFinalAttempt == writesPerformed => writeAttempt <= attempt

(* R-1' (candidate, probed in strict-race): cancel accepted at ANY point  *)
(* before outcome commit excludes completion. Expected REFUTED: abort      *)
(* during the write-back still completes. *)
StrictNoCompleteAfterAbort == aborted => /\ outcome # "completed"
                                          /\ final # "success"

(* R-2' (candidate, probed in strict-race): a cancelled window performed   *)
(* no durable writes. Expected REFUTED: a partial write from a failed     *)
(* first attempt survives the retry's cancellation. *)
StrictCancelledNoWrite == (final = "cancelled") => ~writesPerformed

=============================================================================
