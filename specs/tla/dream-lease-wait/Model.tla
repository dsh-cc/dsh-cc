------------------------------- MODULE Model -------------------------------
EXTENDS Naturals

(***************************************************************************)
(* The dream lane's bounded FIFO wait for the memory mutation lease.      *)
(*                                                                        *)
(* Defect (2026-11-23): in shadow/active extraction mode the coordinator  *)
(* holds the per-plugin mutation lease for the whole fork job; dream used *)
(* tryAcquire and balked, so dream structurally never won the slot while  *)
(* extraction was active. The fix: dream queues FIFO with a bounded wait, *)
(* so the running extraction's release hands the slot to dream before any *)
(* newer extraction attempt.                                              *)
(*                                                                        *)
(* Safety-only by repo convention. The wait-termination guarantee is     *)
(* structural: from "queued" the only outgoing transitions are the FIFO   *)
(* handoff ("granted") and the bound-exhausted timeout ("timed-out").     *)
(***************************************************************************)

CONSTANTS WaitBound,        \* dream's wait budget at queue time
          DreamBalks,      \* PROBE: the pre-fix behavior (dream gives up)
          FifoBreak,       \* PROBE: a release that skips the queued dream
          TimerFiresEarly  \* PROBE: the timeout fires before the bound

VARIABLES leaseOwner,   \* "none" / "extraction" / "dream"
          dream,        \* "idle"/"gated"/"queued"/"granted"/"done"/"timed-out"/"lost"
          budget,       \* dream's remaining wait budget while queued
          ext2          \* a newer extraction attempt

vars == <<leaseOwner, dream, budget, ext2>>

TypeOK ==
  /\ leaseOwner \in {"none", "extraction", "dream"}
  /\ dream \in {"idle", "gated", "queued", "granted", "done", "timed-out", "aborted", "lost"}
  /\ budget \in 0 .. WaitBound
  /\ ext2 \in {"none", "queued", "granted", "released"}

Init ==
  /\ leaseOwner = "extraction"    \* the defect scenario opens mid-extraction
  /\ dream = "idle"
  /\ budget = 0
  /\ ext2 = "none"

(***************************** dream lane ********************************)

(* turn-stopping: dream's gates pass and it reaches the lease *)
DreamGatesPass ==
  /\ dream = "idle"
  /\ dream' = "gated"
  /\ UNCHANGED <<leaseOwner, budget, ext2>>

(* The fix's fast path: a free slot with no waiters is taken at once *)
DreamTakesFree ==
  /\ dream = "gated"
  /\ leaseOwner = "none"
  /\ ext2 # "queued"
  /\ dream' = "granted"
  /\ leaseOwner' = "dream"
  /\ UNCHANGED <<budget, ext2>>

(* The fix's contended path: FIFO queue with a bounded wait *)
DreamQueues ==
  /\ dream = "gated"
  /\ leaseOwner = "extraction"
  /\ dream' = "queued"
  /\ budget' = WaitBound
  /\ UNCHANGED <<leaseOwner, ext2>>

(* PROBE (pre-fix behavior): dream balks and the round is lost forever *)
DreamGivesUp ==
  /\ DreamBalks
  /\ dream = "gated"
  /\ leaseOwner = "extraction"
  /\ dream' = "lost"
  /\ UNCHANGED <<leaseOwner, budget, ext2>>

(* Time passes while dream waits *)
Tick ==
  /\ dream = "queued"
  /\ budget > 0
  /\ budget' = budget - 1
  /\ UNCHANGED <<leaseOwner, dream, ext2>>

(* The bound is exhausted: the abort removes dream from the queue *)
DreamTimesOut ==
  /\ dream = "queued"
  /\ budget = 0 \/ TimerFiresEarly
  /\ dream' = "timed-out"
  /\ UNCHANGED <<leaseOwner, budget, ext2>>

(* Disposal cancellation (specified behavior, not a probe): the fiber      *)
(* teardown aborts the queued wait at ANY remaining budget. Distinct from   *)
(* the timer's bound-exhausted timeout; no lease-timeout semantics.        *)
DreamAborted ==
  /\ dream = "queued"
  /\ dream' = "aborted"
  /\ UNCHANGED <<leaseOwner, budget, ext2>>

(* Dream's fork completes and releases the lease *)
DreamDone ==
  /\ dream = "granted"
  /\ dream' = "done"
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<budget, ext2>>

(**************************** extraction lane ****************************)

(* The real mechanism: the release drains to the oldest waiter ATOMICALLY *)
ExtReleasesHandoff ==
  /\ leaseOwner = "extraction"
  /\ dream = "queued"
  /\ ~FifoBreak
  /\ leaseOwner' = "dream"
  /\ dream' = "granted"
  /\ UNCHANGED <<budget, ext2>>

(* PROBE: the release skips the queued dream (a non-FIFO drain) *)
ExtReleasesSkips ==
  /\ leaseOwner = "extraction"
  /\ dream = "queued"
  /\ FifoBreak
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<dream, budget, ext2>>

(* Extraction releases with no dream waiting *)
ExtReleases ==
  /\ leaseOwner = "extraction"
  /\ dream # "queued"
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<dream, budget, ext2>>

(* A NEWER extraction attempt queues behind ANY slot holder (arrived after  *)
(* dream): covers both the extraction-held case and the D5 inversion where   *)
(* dream owns the slot and the extraction attempt queues behind it.         *)
Ext2Queues ==
  /\ ext2 = "none"
  /\ dream \in {"queued", "granted"}
  /\ leaseOwner # "none"
  /\ ext2' = "queued"
  /\ UNCHANGED <<leaseOwner, dream, budget>>

(* FIFO: the newer attempt is granted only once dream is out of the queue *)
Ext2Granted ==
  /\ ext2 = "queued"
  /\ leaseOwner = "none"
  /\ dream # "queued" \/ FifoBreak
  /\ ext2' = "granted"
  /\ leaseOwner' = "extraction"
  /\ UNCHANGED <<dream, budget>>

Ext2Releases ==
  /\ ext2 = "granted"
  /\ ext2' = "released"
  /\ leaseOwner' = "none"
  /\ UNCHANGED <<dream, budget>>

(* Terminal: the dream round is settled and no lane has work left. The repo  *)
(* convention (extraction-watermark `Idle`, memory-write-lifecycle `Idle`): *)
(* an explicit no-op keeps settled states out of the deadlock check.       *)
Terminal ==
  /\ dream \in {"done", "timed-out", "aborted", "lost"}
  /\ leaseOwner = "none"
  /\ ext2 # "queued"
  /\ UNCHANGED vars

Next ==
  \/ DreamGatesPass \/ DreamTakesFree \/ DreamQueues \/ DreamGivesUp
  \/ Tick \/ DreamTimesOut \/ DreamAborted \/ DreamDone
  \/ ExtReleasesHandoff \/ ExtReleasesSkips \/ ExtReleases
  \/ Ext2Queues \/ Ext2Granted \/ Ext2Releases
  \/ Terminal

Spec == Init /\ [][Next]_vars

(****************************** invariants ********************************)

(* REQ-1: single owner across dream's queued -> granted -> done span *)
SingleOwner ==
  /\ (leaseOwner = "dream") <=> (dream = "granted")

(* REQ-2: a newer extraction attempt never overtakes a queued dream *)
FifoNoOvertake ==
  (ext2 = "granted") => dream # "queued"

(* REQ-3: the timeout fires only at the bound *)
TimeoutOnlyAtBound ==
  (dream = "timed-out") => budget = 0

(* REQ-4: the pre-fix lost round is unreachable under the fixed protocol *)
NoLostDream == dream # "lost"

=============================================================================
\* Modification History
\* Created 2026-11-23 by the orchestrator for the dream-lease-wait model.
