-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* vwa-batch-run v2: the batch page loop contract of the batch-autonomous *)
(* design (docs/plans/2026-10-28-vwa-batch-autonomous-review.md §2.4, §8). *)
(*                                                                         *)
(* F1 durable init idempotency -- reserve-before-create; the torn write    *)
(*    window is restricted to the ORIGINAL reservation write (phase=       *)
(*    "write"): a retry that re-reads an on-disk reservation never        *)
(*    rewrites it (review fold: the v1 fault let a retry-adopted           *)
(*    reservation be torn, a fault the design does not have).             *)
(* F6 checkpoint contract -- per-checkpoint consecutive-failure counters  *)
(*    (a checkpoint SUCCESS resets the counter of the checkpoint it        *)
(*    completes, so skipping requires SkipAfter failures without an       *)
(*    intervening success), graphBound before review, report before the   *)
(*    single commit, commit -> push -> PR -> CI, the no-commit/no-PR      *)
(*    terminal, the content gate (push only after clean content; a        *)
(*    detected violation fails the page), and the stale-cache protocol    *)
(*    fault (a driver that trusts the cache ahead of the evidence).       *)
(*                                                                         *)
(* CHECK_DEADLOCK is meaningful: the self-loop is enabled only when every  *)
(* driver is dead, so a stuck LIVE state is a TLC deadlock (review fold;  *)
(* the torn-reservation recovery is the AbandonReservation action).       *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT SkipAfter, CommitBeforeReport, CacheFirst, AdoptTorn, SkipContentGate,
         AdoptConflicting

ASSUME /\ SkipAfter \in 1..2
       /\ CommitBeforeReport \in BOOLEAN
       /\ CacheFirst \in BOOLEAN
       /\ AdoptTorn \in BOOLEAN
       /\ SkipContentGate \in BOOLEAN
       /\ AdoptConflicting \in BOOLEAN

(* Bounded universes. *)
Drivers == {"d1", "d2"}
Reqs    == {"q1"}
Payloads == {"h1", "h2"}
Kinds   == {"none", "prep", "write"}
Phases  == {"none", "write", "retry"}
Contents == {"none", "md", "other"}
PageStatuses == {"pending", "skipped", "failed"}

PendType ==
  [ kind:  Kinds
  , phase: Phases
  , req:   {"none"} \cup Reqs
  , payload: Payloads ]

(* Durable evidence. Content is sampled when the commit is built; the     *)
(* content gate and the post-commit violation detection live on it.      *)
EvType ==
  [ res:      {"none", "reserved", "torn"}
  , resFor:   Payloads
  , projFor:  Payloads
  , proj:     BOOLEAN
  , bound:    BOOLEAN
  , reviewed: BOOLEAN
  , frozen:   BOOLEAN
  , rep:      BOOLEAN
  , com:      BOOLEAN
  , content:  Contents
  , push:     BOOLEAN
  , pr:       BOOLEAN
  , nopr:     BOOLEAN
  , ci:       BOOLEAN
  , sf:       0..SkipAfter
  , status:   PageStatuses ]

ClType ==
  [ rep:  BOOLEAN
  , com:  BOOLEAN
  , push: BOOLEAN
  , ci:   BOOLEAN
  , status: PageStatuses ]

VARIABLES alive, lock, inLock, pend, ev, cl

vars == <<alive, lock, inLock, pend, ev, cl>>

PendNone == [kind |-> "none", phase |-> "none", req |-> "none", payload |-> "h1"]

Init ==
  /\ alive = [d \in Drivers |-> TRUE]
  /\ lock = "none"
  /\ inLock = FALSE
  /\ pend = [d \in Drivers |-> PendNone]
  /\ ev = [ res |-> "none", resFor |-> "h1", projFor |-> "h1",
            proj |-> FALSE, bound |-> FALSE,
            reviewed |-> FALSE, frozen |-> FALSE, rep |-> FALSE, com |-> FALSE,
            content |-> "none", push |-> FALSE, pr |-> FALSE, nopr |-> FALSE,
            ci |-> FALSE, sf |-> 0, status |-> "pending" ]
  /\ cl = [ rep |-> FALSE, com |-> FALSE, push |-> FALSE, ci |-> FALSE,
            status |-> "pending" ]

(***************************************************************************)
(* F1: reserve-before-create (phase "write"), retry adoption (phase        *)
(* "retry"), torn only inside the original write window, recovery by      *)
(* abandoning the file (design §2.4 STORE_IO_FAILED delete-to-recover).   *)
(***************************************************************************)

ReserveFile(d, h) ==
  /\ alive[d]
  /\ pend[d].kind = "none"
  /\ ev.res = "none"
  /\ ~ev.proj
  /\ ev' = [ev EXCEPT !.res = "reserved", !.resFor = h]
  /\ pend' = [pend EXCEPT ![d] =
      [kind |-> "prep", phase |-> "write", req |-> "q1", payload |-> h]]
  /\ UNCHANGED <<alive, lock, inLock, cl>>

(* The caller's input `h` is independent of the reservation's payload: a
   matching retry adopts the reserved id; a mismatching one is refused. *)
RetryPrepare(d, h) ==
  /\ alive[d]
  /\ pend[d].kind = "none"
  /\ ev.res /= "none"
  /\ (AdoptTorn \/ ev.res = "reserved")
  /\ pend' = [pend EXCEPT ![d] =
      [kind |-> "prep", phase |-> "retry", req |-> "q1", payload |-> h]]
  /\ UNCHANGED <<alive, lock, inLock, ev, cl>>

(* IDEMPOTENCY_CONFLICT: the tool call RETURNS the error -- the pending
   action clears and no project is created (design SS2.4). *)
ResolveConflict(d) ==
  /\ alive[d]
  /\ pend[d].kind = "prep"
  /\ pend[d].payload /= ev.resFor
  /\ pend' = [pend EXCEPT ![d] = PendNone]
  /\ UNCHANGED <<alive, lock, inLock, ev, cl>>

CreateProject(d) ==
  /\ alive[d]
  /\ pend[d].kind = "prep"
  /\ (ev.res = "reserved" \/ (AdoptTorn /\ ev.res = "torn"))
  /\ (AdoptConflicting \/ pend[d].payload = ev.resFor)
  /\ ~ev.proj
  /\ ev' = [ev EXCEPT !.proj = TRUE, !.projFor = pend[d].payload]
  /\ (* The reservation is consumed: any driver still holding a prepare
        action yields to the created project. *)
     pend' = [x \in Drivers |->
        IF pend[x].kind = "prep" THEN PendNone ELSE pend[x]]
  /\ UNCHANGED <<alive, lock, inLock, cl>>

(* Torn is reachable ONLY in the original reservation write window: the   *)
(* writing driver has phase "write" and the project does not exist yet.   *)
CrashTornReservation(d) ==
  /\ alive[d]
  /\ pend[d].kind = "prep"
  /\ pend[d].phase = "write"
  /\ ev.res = "reserved"
  /\ ~ev.proj
  /\ ev' = [ev EXCEPT !.res = "torn", !.proj = FALSE]
  /\ alive' = [alive EXCEPT ![d] = FALSE]
  /\ pend' = [pend EXCEPT ![d] = PendNone]
  /\ UNCHANGED <<lock, inLock, cl>>

(* The documented recovery for a torn reservation: delete the file and    *)
(* start over with a fresh requestId (design §2.4).                       *)
AbandonReservation(d) ==
  /\ alive[d]
  /\ ev.res = "torn"
  /\ ev' = [ev EXCEPT !.res = "none"]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(***************************************************************************)
(* state-writer lock                                                        *)
(***************************************************************************)

TakeLock(d) ==
  /\ alive[d]
  /\ pend[d].kind = "none"
  /\ lock \in ({"none"} \cup {x \in Drivers : ~alive[x]})
  /\ lock' = d
  /\ inLock' = TRUE
  /\ pend' = [pend EXCEPT ![d] =
      [kind |-> "write", phase |-> "none", req |-> "none", payload |-> "h1"]]
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
(* Checkpoints. Every SUCCESS resets the consecutive-failure counter of    *)
(* the checkpoint it completes (review fold K5: a plain counter let        *)
(* fail(review)/succeed/fail(freeze)/skip through, which the design's      *)
(* "same checkpoint consecutively" forbids).                              *)
(***************************************************************************)

BindGraph(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.proj
  /\ ~ev.bound
  /\ ev' = [ev EXCEPT !.bound = TRUE, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

Review(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.bound
  /\ ~ev.reviewed
  /\ ev' = [ev EXCEPT !.reviewed = TRUE, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

FreezeEvaluation(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.reviewed
  /\ ~ev.frozen
  /\ ev' = [ev EXCEPT !.frozen = TRUE, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

WriteReport(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.frozen
  /\ ~ev.rep
  /\ ev' = [ev EXCEPT !.rep = TRUE, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* The single commit carries fix+report; its content is sampled here      *)
(* (md = tracked .md/.mdx only; other = a content-scope violation).      *)
Commit(d, c) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.nopr
  /\ ev.frozen
  /\ ~ev.com
  /\ c \in {"md", "other"}
  /\ (CommitBeforeReport \/ ev.rep)
  /\ ev' = [ev EXCEPT !.com = TRUE, !.content = c, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Post-commit violation detection (the `commit -a` residual, §3.6): a    *)
(* detected violation fails the page; pushing it is forbidden.           *)
DetectViolation(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.nopr
  /\ ev.com
  /\ ev.content = "other"
  /\ ev' = [ev EXCEPT !.status = "failed"]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Content gate: push only clean content (§3.6 pre-check).                *)
(* SkipContentGate is the fault that pushes a violating commit.          *)
Push(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.nopr
  /\ ev.com
  /\ ~ev.push
  /\ (SkipContentGate \/ ev.content = "md")
  /\ ev' = [ev EXCEPT !.push = TRUE, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

PrOpen(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.nopr
  /\ ev.push
  /\ ~ev.pr
  /\ ev' = [ev EXCEPT !.pr = TRUE, !.sf = 0]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* The no-commit / no-PR terminal (§8.3 checkpoint 8): a page with        *)
(* nothing to deliver ends done without CI.                               *)
MarkNoPr(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ev.frozen
  /\ ~ev.com
  /\ ~ev.push
  /\ ~ev.nopr
  /\ ev' = [ev EXCEPT !.nopr = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

ConfirmCi(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.nopr
  /\ ev.pr
  /\ ~ev.ci
  /\ ev' = [ev EXCEPT !.ci = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

FailCheckpoint(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.ci
  /\ ~ev.nopr
  /\ ev.sf < SkipAfter
  /\ ev' = [ev EXCEPT !.sf = ev.sf + 1]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

SkipPage(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ ev.status = "pending"
  /\ ~ev.ci
  /\ ~ev.nopr
  /\ ev.sf >= SkipAfter
  /\ ev' = [ev EXCEPT !.status = "skipped"]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Cache write: normal mode copies durable truth (state.json is a cache); *)
(* CacheFirst is the documented fault -- it claims push ahead of evidence. *)
WriteClaim(d) ==
  /\ alive[d]
  /\ lock = d
  /\ inLock
  /\ cl' = [ rep |-> ev.rep,
             com |-> IF CacheFirst /\ ev.rep /\ ~ev.com THEN TRUE ELSE ev.com,
             push |-> ev.push,
             ci |-> ev.ci,
             status |-> ev.status ]
  /\ UNCHANGED <<alive, lock, inLock, pend, ev>>

(* The stale-cache PROTOCOL fault: a driver that trusts the ahead cache   *)
(* skips the commit and pushes directly -- the concrete violation the     *)
(* shape invariant alone could not express (review fold).                  *)
PushFromStaleCache(d) ==
  /\ alive[d]
  /\ CacheFirst
  /\ cl.com
  /\ ~ev.com
  /\ ~ev.push
  /\ ev' = [ev EXCEPT !.push = TRUE]
  /\ UNCHANGED <<alive, lock, inLock, pend, cl>>

(* Resume: recompute the cache from disk evidence (never the reverse).    *)
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
(* Crashes                                                                  *)
(***************************************************************************)

Crash(d) ==
  /\ alive[d]
  /\ alive' = [alive EXCEPT ![d] = FALSE]
  /\ pend' = [pend EXCEPT ![d] = PendNone]
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

(* The self-loop is enabled ONLY when every driver is dead, so a stuck    *)
(* LIVE state is a genuine TLC deadlock (review fold).                     *)
Idle ==
  /\ \A d \in Drivers : ~alive[d]
  /\ UNCHANGED vars

Next ==
  \/ \E d \in Drivers, h \in Payloads : ReserveFile(d, h)
  \/ \E d \in Drivers, h \in Payloads : RetryPrepare(d, h)
  \/ \E d \in Drivers : ResolveConflict(d)
  \/ \E d \in Drivers : CreateProject(d)
  \/ \E d \in Drivers : CrashTornReservation(d)
  \/ \E d \in Drivers : AbandonReservation(d)
  \/ \E d \in Drivers : TakeLock(d)
  \/ \E d \in Drivers : ReleaseLock(d)
  \/ \E d \in Drivers : BindGraph(d)
  \/ \E d \in Drivers : Review(d)
  \/ \E d \in Drivers : FreezeEvaluation(d)
  \/ \E d \in Drivers : WriteReport(d)
  \/ \E d \in Drivers, c \in {"md", "other"} : Commit(d, c)
  \/ \E d \in Drivers : DetectViolation(d)
  \/ \E d \in Drivers : Push(d)
  \/ \E d \in Drivers : PrOpen(d)
  \/ \E d \in Drivers : MarkNoPr(d)
  \/ \E d \in Drivers : ConfirmCi(d)
  \/ \E d \in Drivers : FailCheckpoint(d)
  \/ \E d \in Drivers : SkipPage(d)
  \/ \E d \in Drivers : WriteClaim(d)
  \/ \E d \in Drivers : PushFromStaleCache(d)
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

InitSound ==
  /\ (ev.proj => (ev.res = "reserved" /\ ev.projFor = ev.resFor))
  /\ (ev.res = "torn" => ~ev.proj)
  /\ (ev.bound => ev.proj)
  /\ (ev.reviewed => ev.bound)

(* The graph is bound before the review runs (checkpoint 2, review fold). *)
BoundBeforeReview == ev.reviewed => ev.bound

FrozenBeforeReport == ev.rep => ev.frozen

ReportBeforeCommit == ev.com => ev.rep

DeliveryOrder ==
  /\ (ev.push => ev.com)
  /\ (ev.pr => ev.push)
  /\ (ev.ci => ev.pr)

(* Content gate + violation stop (§3.6/§8.3, review fold K7).             *)
ContentGateSound ==
  /\ (ev.push => ev.content = "md")
  /\ (ev.status = "failed" => ~ev.push)

(* The no-PR terminal is only for pages with nothing delivered.           *)
NoPrSound == ev.nopr => (~ev.com /\ ~ev.push /\ ~ev.pr /\ ~ev.ci)

ClaimNeverAhead ==
  /\ (cl.rep => ev.rep)
  /\ (cl.com => ev.com)
  /\ (cl.push => ev.push)
  /\ (cl.ci => ev.ci)
  /\ (cl.status = "skipped" => ev.status = "skipped")
  /\ (cl.status = "failed" => ev.status = "failed")

SkipNeedsFailures == ev.status = "skipped" => ev.sf >= SkipAfter

StateWriteExclusive ==
  inLock => ( /\ lock \in Drivers
              /\ alive[lock]
              /\ pend[lock].kind = "write" )

TerminalStable ==
  /\ (ev.status = "skipped" => (~ev.ci /\ ~ev.nopr))
  /\ (ev.status = "failed" => (~ev.ci /\ ~ev.nopr))

ToolchainFingerprint == <<SkipAfter, CommitBeforeReport, CacheFirst, AdoptTorn,
                          SkipContentGate, AdoptConflicting>>

=============================================================================
