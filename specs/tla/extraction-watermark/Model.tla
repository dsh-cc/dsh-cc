---- MODULE Model ----
(***************************************************************************)
(* Memory extraction gate watermark/lease lifecycle (S1-04).             *)
(* Behavioral source:                                                     *)
(* docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md --        *)
(* coordinator phases, watermark commit rules, cooldown, the mutation   *)
(* lease, and owner takeover.                                            *)
(*                                                                       *)
(* Scope: the coordinator only. The watermark advances only on           *)
(* job.done=completed at the captured head; a failed window enters       *)
(* cooldown retried only by a later stop; a skip verdict commits only   *)
(* after full re-validation; the mutation lease has one owner; a new     *)
(* Agent taking over the same key starts again at watermark -1.          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS AdvanceOnStart,     (* probe: watermark advances when the job   *)
                                 (* starts, not when job.done=completed  *)
          SkipNoReval,        (* probe: skip committed without            *)
                                 (* re-validation of the evidence head   *)
          CooldownAutoRetry,  (* probe: a timer retries the same failed   *)
                                 (* window                               *)
          LeaseDoubleOwner    (* probe: two owners on the same dir        *)

MaxHead == 3
Max(a, b) == IF a >= b THEN a ELSE b
WmInit == 0

PHASE == {"idle", "gating", "waiting-lease", "extracting",
          "cooldown", "disposed"}
FAULTS == {"skip-stale", "start-commit", "timer-retry", "double-owner"}

VARIABLES phase, wm, pendingHead, capturedHead, retryAt, gen,
          leaseOwner, jobDone, alive, faults

vars == <<phase, wm, pendingHead, capturedHead, retryAt, gen,
          leaseOwner, jobDone, alive, faults>>

TypeOK ==
  /\ phase \in PHASE
  /\ wm \in WmInit..MaxHead
  /\ pendingHead \in 0..MaxHead
  /\ capturedHead \in 0..MaxHead
  /\ retryAt \in 0..2
  /\ gen \in 1..3
  /\ leaseOwner \in {"none", "extraction", "dream"}
  /\ jobDone \in {"none", "running", "completed", "failed", "killed"}
  /\ alive \in BOOLEAN
  /\ faults \subseteq FAULTS

Init ==
  /\ phase = "idle"
  /\ wm = WmInit
  /\ pendingHead = 0
  /\ capturedHead = 0
  /\ retryAt = 0
  /\ gen = 1
  /\ leaseOwner = "none"
  /\ jobDone = "none"
  /\ alive = TRUE
  /\ faults = {}

(************************************** turn-stopping *********************)

(* A stop arrives with a newer evidence head. Idle or a past-cooldown    *)
(* starts a gate at that head; during gating/waiting-lease/extracting it *)
(* only overwrites pendingHead -- the active captured window is never    *)
(* rewritten.                                                            *)
Stop(h) ==
  /\ alive
  /\ h > pendingHead
  /\ IF phase \in {"idle", "gating", "waiting-lease", "extracting"}
       THEN /\ pendingHead' = h
            /\ UNCHANGED <<phase, wm, capturedHead, retryAt, gen,
                            leaseOwner, jobDone, faults, alive>>
       ELSE /\ phase' = "gating"
            /\ pendingHead' = h
            /\ capturedHead' = h
            /\ jobDone' = "none"
            /\ wm' = IF AdvanceOnStart THEN h ELSE wm
            /\ faults' = faults
                 \union (IF AdvanceOnStart
                            THEN {"start-commit"} ELSE {})
            /\ UNCHANGED <<retryAt, gen, leaseOwner, alive>>

(* Probe-only: a timer retries the same failed cooldown window with no   *)
(* new stop and no head past retryAt.                                    *)
TimerRetry ==
  /\ alive
  /\ phase = "cooldown"
  /\ CooldownAutoRetry
  /\ phase' = "gating"
  /\ jobDone' = "none"
  /\ faults' = faults \union {"timer-retry"}
  /\ UNCHANGED <<wm, pendingHead, capturedHead, retryAt, gen, leaseOwner,
                  alive>>

(************************************** gate ******************************)

(* A skip verdict commits the watermark only after full re-validation:   *)
(* the evidence head must not have moved past the captured window.      *)
GateSkip ==
  /\ alive
  /\ phase = "gating"
  /\ IF pendingHead # capturedHead
       THEN /\ SkipNoReval
            /\ wm' = Max(wm, capturedHead)
            /\ faults' = faults \union {"skip-stale"}
       ELSE /\ wm' = Max(wm, capturedHead)
            /\ faults' = faults
  /\ phase' = "idle"
  /\ UNCHANGED <<pendingHead, capturedHead, retryAt, gen, leaseOwner,
                  jobDone, alive>>

GateNeedLease ==
  /\ alive
  /\ phase = "gating"
  /\ phase' = "waiting-lease"
  /\ UNCHANGED <<wm, pendingHead, capturedHead, retryAt, gen, leaseOwner,
                  jobDone, faults, alive>>

(************************************** lease *****************************)

AcquireLease ==
  /\ alive
  /\ phase = "waiting-lease"
  /\ (leaseOwner = "none" \/ LeaseDoubleOwner)
  /\ faults' = IF leaseOwner # "none"
                 THEN faults \union {"double-owner"}
                 ELSE faults
  /\ leaseOwner' = "extraction"
  /\ phase' = "extracting"
  /\ jobDone' = "running"
  /\ UNCHANGED <<wm, pendingHead, capturedHead, retryAt, gen, alive>>

DreamTakesLease ==
  /\ alive
  /\ (phase # "extracting" \/ LeaseDoubleOwner)
  /\ (leaseOwner = "none" \/ LeaseDoubleOwner)
  /\ faults' = IF leaseOwner # "none"
                 THEN faults \union {"double-owner"}
                 ELSE faults
  /\ leaseOwner' = "dream"
  /\ UNCHANGED <<phase, wm, pendingHead, capturedHead, retryAt, gen,
                  jobDone, alive>>

DreamReleases ==
  /\ leaseOwner = "dream"
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<phase, wm, pendingHead, capturedHead, retryAt, gen,
                  jobDone, faults, alive>>

(************************************** job outcome **********************)

(* job.done=completed: the watermark commits to the captured head --     *)
(* never past it, so newer input that arrived during extraction is not   *)
(* covered by the old success.                                          *)
JobCompleted ==
  /\ alive
  /\ phase = "extracting"
  /\ jobDone = "running"
  /\ jobDone' = "completed"
  /\ wm' = Max(wm, capturedHead)
  /\ phase' = "idle"
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<pendingHead, capturedHead, retryAt, gen, faults,
                  alive>>

(* job.done=failed: the watermark keeps its previous value, the lease is *)
(* released by the finally, and the window enters cooldown -- no         *)
(* automatic retry timer is installed.                                  *)
JobFailed ==
  /\ alive
  /\ phase = "extracting"
  /\ jobDone = "running"
  /\ jobDone' = "failed"
  /\ phase' = "cooldown"
  /\ retryAt' = 1
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<wm, pendingHead, capturedHead, gen, faults, alive>>

(* job.done=killed (from dispose): the watermark keeps its value, the   *)
(* lease is released, and the state is disposed.                        *)
JobKilled ==
  /\ phase = "extracting"
  /\ jobDone = "running"
  /\ jobDone' = "killed"
  /\ phase' = "disposed"
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<wm, pendingHead, capturedHead, retryAt, gen, faults,
                  alive>>

(* A cooldown exit is always stop-driven and its head must have passed   *)
(* retryAt.                                                              *)
CooldownRetry(h) ==
  /\ alive
  /\ phase = "cooldown"
  /\ h > pendingHead
  /\ h > retryAt
  /\ phase' = "gating"
  /\ pendingHead' = h
  /\ capturedHead' = h
  /\ jobDone' = "none"
  /\ UNCHANGED <<wm, retryAt, gen, leaseOwner, faults, alive>>

(************************************** drain & takeover *****************)

(* After a settle, pending work is drained once via a microtask; never   *)
(* in a while-loop retrying the same failed window.                     *)
DrainPending ==
  /\ alive
  /\ phase = "idle"
  /\ pendingHead > wm
  /\ phase' = "gating"
  /\ capturedHead' = pendingHead
  /\ jobDone' = "none"
  /\ UNCHANGED <<wm, pendingHead, retryAt, gen, leaseOwner, faults,
                  alive>>

(* A new Agent instance takes over the same key: the old owner's job has *)
(* settled, and the new state starts at watermark -1 (repeat extraction  *)
(* preferred over permanent missed memory).                              *)
Takeover ==
  /\ alive
  /\ gen < 3
  /\ phase \in {"idle", "cooldown", "disposed"}
  /\ jobDone # "running"
  /\ phase' = "idle"
  /\ wm' = WmInit
  /\ gen' = gen + 1
  /\ pendingHead' = 0
  /\ capturedHead' = 0
  /\ jobDone' = "none"
  /\ leaseOwner' = "none"
  /\ retryAt' = 0
  /\ UNCHANGED <<faults, alive>>

Dispose ==
  /\ alive
  /\ alive' = FALSE
  /\ phase' = "disposed"
  /\ leaseOwner' = "none"
  /\ jobDone' = IF jobDone = "running" THEN "killed" ELSE jobDone
  /\ UNCHANGED <<wm, pendingHead, capturedHead, retryAt, gen, faults>>

Idle == /\ phase = "disposed"
        /\ UNCHANGED <<phase, wm, pendingHead, capturedHead, retryAt, gen,
                       leaseOwner, jobDone, faults, alive>>

Next == \/ \E h \in 1..MaxHead : Stop(h) \/ CooldownRetry(h)
        \/ GateSkip \/ GateNeedLease \/ AcquireLease \/ DreamTakesLease \/
           TimerRetry \/
           DreamReleases \/ JobCompleted \/ JobFailed \/ JobKilled \/
           DrainPending \/ Takeover \/ Dispose \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

(* The watermark never passes the captured head of the window that      *)
(* produced the commit.                                                  *)
WmWithinCaptured == wm <= capturedHead

(* Pending work is never lost while the coordinator lives and is not     *)
(* in cooldown/disposed.                                                 *)
PendingNeverLost ==
  (alive /\ phase \in {"idle", "gating", "waiting-lease",
                        "extracting"}) => pendingHead >= wm

(* The extraction lease is never left behind a finished or non-running   *)
(* job.                                                                  *)
NoLeaseAfterTerminal ==
  (phase # "extracting" \/ jobDone # "running") =>
    leaseOwner # "extraction"

(* A running job belongs to the extracting phase of a live coordinator.  *)
RunningSound ==
  (jobDone = "running") => (phase = "extracting" /\ alive)

(* No probe fault is reachable in a convention run: skip commits are      *)
(* revalidated, watermark commits wait for job.done, cooldown exits are  *)
(* stop-driven, and the lease has one owner.                             *)
NoFaults == faults = {}

=============================================================================
