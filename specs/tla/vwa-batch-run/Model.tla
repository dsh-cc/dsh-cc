-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* vwa-batch-run: the batch page loop contract of the batch-autonomous     *)
(* design (docs/plans/2026-10-28-vwa-batch-autonomous-review.md §2.4, §8). *)
(* Two mechanisms share one per-page state machine:                        *)
(*   F1 durable init idempotency -- reserve-before-create                 *)
(*      (.dsh/vwa/inits/<requestId>.json then ProjectStore.init,           *)
(*      store.ts:200-220; torn reservation write must never yield a        *)
(*      project, §2.4);                                                    *)
(*   F6 checkpoint ordering and crash recovery -- evidence over cache      *)
(*      (state.json is a cache; every boolean is recomputed from disk      *)
(*      evidence), the single commit that carries fix+report, the          *)
(*      consecutive-failure skip rule (§8.3).                              *)
(* Durable checkpoints are independent booleans so that ordering           *)
(* invariants are non-vacuous: review -> frozen -> reportWritten ->        *)
(* committed -> pushed -> ciConfirmed.                                     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT SkipAfter, CommitBeforeReport, CacheFirst, AdoptTorn

ASSUME /\ SkipAfter \in 1..2
       /\ CommitBeforeReport \in BOOLEAN
       /\ CacheFirst \in BOOLEAN
       /\ AdoptTorn \in BOOLEAN

(* Bounded universes. *)
Drivers == {"d1", "d2"}
Reqs    == {"q1"}
Payloads == {"h1", "h2"}
Kinds   == {"none", "prep", "write"}

PendType ==
  [ kind:  Kinds
  , req:   {"none"} \cup Reqs
  , payload: Payloads ]

(* Durable evidence (disk truth: reservation file, project dir, report      *)
(* file, git objects, CI run). Durable across crashes.                     *)
EvType ==
  [ res:      {"none", "reserved", "torn"}
  , resFor:   Payloads
  , proj:     BOOLEAN
  , reviewed: BOOLEAN
  , frozen:   BOOLEAN
  , rep:      BOOLEAN
  , com:      BOOLEAN
  , push:     BOOLEAN
  , ci:       BOOLEAN
  , sf:       0..SkipAfter
  , status:   {"pending", "skipped"} ]

(* state.json cache claims (lost on crash, may lag the evidence).          *)
ClType ==
  [ rep:  BOOLEAN
  , com:  BOOLEAN
  , push: BOOLEAN
  , ci:   BOOLEAN
  , status: {"pending", "skipped"} ]

VARIABLES alive, lock, inLock, pend, ev, cl

vars == <<alive, lock, inLock, pend, ev, cl>>

PendNone == [kind |-> "none", req |-> "none", payload |-> "h1"]

Init ==
  /\ alive = [d \in Drivers |-> TRUE]
  /\ lock = "none"
  /\ inLock = FALSE
  /\ pend = [d \in Drivers |-> PendNone]
  /\ ev = [ res |-> "none", resFor |-> "h1", proj |-> FALSE,
            reviewed |-> FALSE, frozen |-> FALSE, rep |-> FALSE,
            com |-> FALSE, push |-> FALSE, ci |-> FALSE,
            sf |-> 0, status |-> "pending" ]
  /\ cl = [ rep |-> FALSE, com |-> FALSE, push |-> FALSE, ci |-> FALSE,
            status |-> "pending" ]

(***************************************************************************)
(* F1: reserve-before-create, including the torn write window.             *)
(***************************************************************************)

ReserveFile(d, h) ==
  /\ alive[d]
  /\ pend[d].kind = "none"
  /\ ev.res = "none"
  /\ ~ev.proj
  /\ ev' = [ev EXCEPT !.res = "reserved", !.resFor = h]
  /\ pend' = [pend EXCEPT ![d] =
      [kind |-> "prep", req |-> "q1", payload |-> h]]
  /\ UNCHANGED <<alive, lock, inLock, cl>>

(* A retry re-prepares from the on-disk reservation: legitimate recovery   *)
(* after a crash between reservation and creation (res = "reserved"), and  *)
(* the fault path when AdoptTorn lets a truncated file be adopted.         *)
RetryPrepare(d) ==
  /\ alive[d]
  /\ pend[d].kind = "none"
  /\ ev.res /= "none"
  /\ (AdoptTorn \/ ev.res = "reserved")
  /\ pend' = [pend EXCEPT ![d] =
      [kind |-> "prep", req |-> "q1", payload |-> ev.resFor]]
  /\ UNCHANGED <<alive, lock, inLock, ev, cl>>

(* A retry adopts the reserved projectId and creates the project; init of  *)
(* an existing project is the ownership-verified recovery path (§2.3).     *)
CreateProject(d) ==
  /\ alive[d]
  /\ pend[d].kind = "prep"
  /\ (ev.res = "reserved" \/ (AdoptTorn /\ ev.res = "torn"))
  /\ pend[d].payload = ev.resFor
  /\ ev.resFor = "h1"
  /\ ~ev.proj
  /\ ev' = [ev EXCEPT !.proj = TRUE]
  (* The reservation is consumed: any driver still holding a prepare action
     yields to the created project (no later truncation of a live file). *)
  /\ pend' = [x \in Drivers |->
       IF pend[x].kind = "prep" THEN PendNone ELSE pend[x]]
  /\ UNCHANGED <<alive, lock, inLock, cl>>

(* Crash mid-write: the truncated file is not a usable reservation and no  *)
(* project may exist behind it (STORE_IO_FAILED, §2.4).                    *)
CrashTornReservation(d) ==
  /\ alive[d]
  /\ pend[d].kind = "prep"
  /\ ev.res = "reserved"
  /\ ~ev.proj
  /\ ev' = [ev EXCEPT !.res = "torn", !.proj = FALSE]
  /\ alive' = [alive EXCEPT ![d] = FALSE]
  /\ pend' = [pend EXCEPT ![d] = PendNone]
  /\ UNCHANGED <<lock, inLock, cl>>

(***************************************************************************)
(* state-writer lock (the design's state.lock; lock.ts primitive:          *)
(* exclusive create, dead-holder reclaim, torn file never reclaimed).      *)
(***************************************************************************)

TakeLock(d) ==
  /\ alive[d]
  /\ pend[d].kind = "none"
  /\ lock \in ({"none"} \cup {x \in Drivers : ~alive[x]})
  /\ lock' = d
  /\ inLock' = TRUE
  /\ pend' = [pend EXCEPT ![d] =
      [kind |-> "write", req |-> "none", payload |-> "h1"]]
  /\ UNCHANGED <<alive, ev, cl>>

ReleaseLock(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ lock' = "none"
  /\ inLock' = FALSE
  /\ pend' = [pend EXCEPT ![d] = PendNone]
  /\ UNCHANGED <<alive, ev, cl>>

(***************************************************************************)
(* Checkpoint transitions. Each guarded action is one durable effect; the  *)
(* ordering-guard placement is the design decision under test.             *)
(***************************************************************************)

Review(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.proj
  /\ ~ev.reviewed
  /\ ev' = [ev EXCEPT !.reviewed = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

FreezeEvaluation(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.reviewed
  /\ ~ev.frozen
  /\ ev' = [ev EXCEPT !.frozen = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Report write (as-of re-render may follow fixes, hence only `frozen` is  *)
(* required, not `reviewed` again).                                        *)
WriteReport(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.frozen
  /\ ~ev.rep
  /\ ev' = [ev EXCEPT !.rep = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* The single commit carries fix+report. CommitBeforeReport is the         *)
(* documented fault switch: it drops the report guard so the ordering      *)
(* invariant ReportBeforeCommit must catch the resulting commit.           *)
Commit(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.frozen
  /\ ~ev.com
  /\ (CommitBeforeReport \/ ev.rep)
  /\ ev' = [ev EXCEPT !.com = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

Push(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.com
  /\ ~ev.push
  /\ ev' = [ev EXCEPT !.push = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

ConfirmCi(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.push
  /\ ~ev.ci
  /\ ev' = [ev EXCEPT !.ci = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Consecutive-failure accounting for the current checkpoint (§8.3).       *)
FailCheckpoint(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.ci
  /\ ev.sf < SkipAfter
  /\ ev' = [ev EXCEPT !.sf = ev.sf + 1]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

SucceedCheckpoint(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.sf > 0
  /\ ev' = [ev EXCEPT !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Skip after SkipAfter consecutive failures; the batch continues.         *)
SkipPage(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.ci
  /\ ev.sf >= SkipAfter
  /\ ev' = [ev EXCEPT !.status = "skipped"]
  /\ cl' = [cl EXCEPT !.status = "skipped"]
  /\ UNCHANGED <<alive, lock, inLock, pend>>

(* Cache write. Normal mode copies durable truth; CacheFirst is the        *)
(* documented fault that lets the cache claim a checkpoint one step ahead, *)
(* which ClaimNeverAhead must catch.                                       *)
WriteClaim(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ cl' = [ rep  |-> ev.rep,
             com  |-> ev.com,
             push |-> IF CacheFirst /\ ev.rep /\ ~ev.com THEN TRUE ELSE ev.push,
             ci   |-> ev.ci,
             status |-> ev.status ]
  /\ UNCHANGED <<alive, lock, inLock, pend, ev>>

(* Resume: recompute the cache from disk evidence (never the reverse).     *)
Reconcile(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ cl /= [ rep |-> ev.rep, com |-> ev.com, push |-> ev.push,
             ci |-> ev.ci, status |-> ev.status ]
  /\ cl' = [ rep |-> ev.rep, com |-> ev.com, push |-> ev.push,
             ci |-> ev.ci, status |-> ev.status ]
  /\ UNCHANGED <<alive, lock, inLock, pend, ev>>

(***************************************************************************)
(* Crashes                                                                 *)
(***************************************************************************)

Crash(d) ==
  /\ alive[d]
  /\ alive' = [alive EXCEPT ![d] = FALSE]
  /\ pend' = [pend EXCEPT ![d] = PendNone]
  (* inLock is in-process state: the crash loses it, while the lock FILE
     stays behind, held by a now-dead holder (reclaimable). *)
  /\ inLock' = FALSE
  /\ UNCHANGED <<lock, ev, cl>>

CrashTornLock(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ pend[d].kind = "write"
  /\ alive' = [alive EXCEPT ![d] = FALSE]
  /\ lock' = "torn"
  /\ inLock' = FALSE
  /\ pend' = [pend EXCEPT ![d] = PendNone]
  /\ UNCHANGED <<ev, cl>>

Idle == UNCHANGED vars

Next ==
  \/ \E d \in Drivers, h \in Payloads : ReserveFile(d, h)
  \/ \E d \in Drivers : RetryPrepare(d)
  \/ \E d \in Drivers : CreateProject(d)
  \/ \E d \in Drivers : CrashTornReservation(d)
  \/ \E d \in Drivers : TakeLock(d)
  \/ \E d \in Drivers : ReleaseLock(d)
  \/ \E d \in Drivers : Review(d)
  \/ \E d \in Drivers : FreezeEvaluation(d)
  \/ \E d \in Drivers : WriteReport(d)
  \/ \E d \in Drivers : Commit(d)
  \/ \E d \in Drivers : Push(d)
  \/ \E d \in Drivers : ConfirmCi(d)
  \/ \E d \in Drivers : FailCheckpoint(d)
  \/ \E d \in Drivers : SucceedCheckpoint(d)
  \/ \E d \in Drivers : SkipPage(d)
  \/ \E d \in Drivers : WriteClaim(d)
  \/ \E d \in Drivers : Reconcile(d)
  \/ \E d \in Drivers : Crash(d)
  \/ \E d \in Drivers : CrashTornLock(d)
  \/ Idle

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety properties                                                        *)
(***************************************************************************)

TypeOK ==
  /\ alive \in [Drivers -> BOOLEAN]
  /\ lock \in ({"none"} \cup Drivers) \cup {"torn"}
  /\ inLock \in BOOLEAN
  /\ pend \in [Drivers -> PendType]
  /\ ev \in EvType
  /\ cl \in ClType

(* S-1 (F1): a project exists only behind one well-formed reservation for  *)
(* this request/payload; a torn reservation never yields a project.        *)
InitSound ==
  /\ (ev.proj => (ev.res = "reserved" /\ ev.resFor = "h1"))
  /\ (ev.res = "torn" => ~ev.proj)
  /\ (ev.reviewed => ev.proj)

(* S-2: the evaluation was frozen before the report was written.           *)
FrozenBeforeReport == ev.rep => ev.frozen

(* S-3: the report is durable before the single commit carrying it.        *)
ReportBeforeCommit == ev.com => ev.rep

(* S-4/S-5: commit before push, push before CI confirmation.               *)
DeliveryOrder ==
  /\ (ev.push => ev.com)
  /\ (ev.ci => ev.push)

(* S-6: the state.json cache never claims progress the evidence lacks.     *)
ClaimNeverAhead ==
  /\ (cl.rep => ev.rep)
  /\ (cl.com => ev.com)
  /\ (cl.push => ev.push)
  /\ (cl.ci => ev.ci)

(* S-7: a page is skipped only after SkipAfter consecutive failures.       *)
SkipNeedsFailures == ev.status = "skipped" => ev.sf >= SkipAfter

(* S-8: only the live holder writes, and it holds a write action.          *)
StateWriteExclusive ==
  inLock => ( /\ lock \in Drivers
              /\ alive[lock]
              /\ pend[lock].kind = "write" )

(* S-9: a skipped page never reaches CI confirmation.                      *)
TerminalStable ==
  /\ (ev.status = "skipped" => ~ev.ci)
  /\ (cl.status = "skipped" => ev.status = "skipped")

ToolchainFingerprint == <<SkipAfter, CommitBeforeReport, CacheFirst, AdoptTorn>>

=============================================================================
