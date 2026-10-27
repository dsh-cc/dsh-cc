--------------------------- MODULE Model ---------------------------
(***************************************************************************)
(* Bounded model of the dsh-cc subagent child lifecycle:                   *)
(* capacity admission (the shared per-parent admission lease +             *)
(* continuation slot reservations with their safety TTL and the            *)
(* dispatch-time recheck), epoch end / settle, grace-window auto-release   *)
(* tombstones, the send_message admission gate, manual release_agent       *)
(* eviction, Ctrl+B promotion, and session-exit drain.                     *)
(*                                                                         *)
(* Abstracted from packages/subagent/task (background-start.ts,            *)
(* live-capacity.ts, grace-window.ts, epoch-collector.ts, tool.ts), the    *)
(* shared admission in packages/subagent/resume-pins (admission.ts,        *)
(* live-capacity.ts, dispatch-recheck.ts) and the resume-pins plugin       *)
(* send_message gate (plugin.ts).                                          *)
(* See code-anchors.md for verbatim source excerpts.                       *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS MaxLive, SplitContinue, CapacityObservable

Children == 1..3

Statuses == {"none", "running", "idle", "ready", "gone"}

(* status of a child:                                                     *)
(*   none    - never spawned                                              *)
(*   running - live activation executing a turn                           *)
(*   idle    - live activation, no turn in flight                         *)
(*   ready   - settled; registry row exists, no live activation           *)
(*   gone    - evicted (released / drained)                               *)

VARIABLES status, tier, epochOpen,
          graceMember, gracePending, tombstoned, tombstoneEver,
          releasing, released, promoted, lateEpoch, drained

vars == <<status, tier, epochOpen,
          graceMember, gracePending, tombstoned, tombstoneEver,
          releasing, released, promoted, lateEpoch, drained>>

TypeOK ==
  /\ status \in [Children -> Statuses]
  /\ tier \in [Children -> {"fg", "bg"}]
  /\ epochOpen \in [Children -> BOOLEAN]
  /\ graceMember \subseteq Children
  /\ gracePending \subseteq Children
  /\ tombstoned \subseteq Children
  /\ tombstoneEver \subseteq Children
  /\ releasing \subseteq Children
  /\ released \subseteq Children
  /\ promoted \subseteq Children
  /\ lateEpoch \subseteq Children
  /\ drained \in BOOLEAN

LiveCount == Cardinality({c \in Children : status[c] = "running"})

(* The one capacity predicate every admission path uses. Unobservable      *)
(* capacity (missing seam, throwing listing, absent registry) degrades OPEN *)
(* - a safety valve never blocks on its own infrastructure.                *)
RoomForOne == (CapacityObservable = FALSE) \/ (LiveCount < MaxLive)

(* ----------------------------------------------------------------------- *)
(* Init                                                                    *)
(* ----------------------------------------------------------------------- *)

Init ==
  /\ status = [c \in Children |-> "none"]
  /\ tier = [c \in Children |-> "fg"]
  /\ epochOpen = [c \in Children |-> FALSE]
  /\ graceMember = {}
  /\ gracePending = {}
  /\ tombstoned = {}
  /\ tombstoneEver = {}
  /\ releasing = {}
  /\ released = {}
  /\ promoted = {}
  /\ lateEpoch = {}
  /\ drained = FALSE

(* ----------------------------------------------------------------------- *)
(* Spawn admission (all three spawn lanes + the ephemeral dispatch).       *)
(* PR #301: the capacity check and the creation call are ONE critical      *)
(* section under the per-parent admission lease, so two concurrent starts  *)
(* can no longer both pass the guard and overshoot. The old split-action   *)
(* TOCTOU probe is gone: that interleaving no longer models any code.      *)
(* ----------------------------------------------------------------------- *)

SpawnAtomic(c) ==
  /\ ~drained
  /\ status[c] = "none"
  /\ c \notin released
  /\ RoomForOne
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ tier' = [tier EXCEPT ![c] = "fg"]
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  /\ graceMember' = graceMember \union {c}
  /\ gracePending' = gracePending
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* Epoch lifecycle                                                         *)
(* ----------------------------------------------------------------------- *)

ArmGrace(c, mem, pend) ==
  IF mem THEN pend \union {c} ELSE pend

EpochEnd(c) ==
  /\ status[c] = "running"
  /\ status' = [status EXCEPT ![c] = "idle"]
  /\ gracePending' = ArmGrace(c, c \in graceMember, gracePending)
  /\ epochOpen' = [epochOpen EXCEPT ![c] = FALSE]
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

Settle(c) ==
  /\ status[c] \in {"running", "idle"}
  /\ status' = [status EXCEPT ![c] = "ready"]
  /\ gracePending' = ArmGrace(c, c \in graceMember, gracePending)
  /\ epochOpen' = [epochOpen EXCEPT ![c] = FALSE]
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* Grace-window fire (auto-release).                                       *)
(* Fire re-checks liveness: a running or idle child is skipped and the     *)
(* timer re-arms; a ready child is tombstoned (release marker set).        *)
(* ----------------------------------------------------------------------- *)

GraceFire(c) ==
  /\ c \in gracePending
  /\ ~drained
  /\ status[c] = "ready"
  /\ gracePending' = gracePending \ {c}
  /\ tombstoned' = tombstoned \union {c}
  /\ tombstoneEver' = tombstoneEver \union {c}
  /\ status' = status
  /\ tier' = tier
  /\ epochOpen' = epochOpen
  /\ graceMember' = graceMember
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* send_message continuation admission.                                    *)
(*                                                                         *)
(* SplitContinue = FALSE (convention): the capacity check, the reservation *)
(* and the restart are one atomic step under the admission lease.          *)
(* SplitContinue = TRUE (probe): the gate check is a separate step from    *)
(* the restart, so a grace fire can land between them (documented accepted *)
(* residual).                                                              *)
(* ----------------------------------------------------------------------- *)

ContinueAdmit(c) ==
  /\ ~drained
  /\ status[c] = "ready"
  /\ c \in graceMember
  /\ c \notin released
  (* PR #301: the capacity check and the delivery are ONE critical section
     under the per-parent admission lease (tools/execute for a continuation,
     the creation call for a spawn), so nothing interleaves between check and
     activation. *)
  /\ RoomForOne
  (* The tombstone gate runs earlier (tools/pre-execute) than capacity
     admission (tools/execute); SplitContinue = TRUE models the accepted
     residual where a grace fire lands between them. *)
  /\ IF SplitContinue THEN TRUE ELSE c \notin tombstoned
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  /\ lateEpoch' = lateEpoch \union (IF c \in tombstoned THEN {c} ELSE {})
  /\ tombstoned' = tombstoned \ {c}
  /\ gracePending' = gracePending \ {c}
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* Ctrl+B promotion (foreground collect -> background).                   *)
(* ----------------------------------------------------------------------- *)

Promote(c) ==
  /\ ~drained
  /\ tier[c] = "fg"
  /\ status[c] = "running"
  /\ epochOpen[c]
  /\ c \notin promoted
  /\ promoted' = promoted \union {c}
  /\ tier' = [tier EXCEPT ![c] = "bg"]
  /\ status' = status
  /\ epochOpen' = epochOpen
  /\ graceMember' = graceMember
  /\ gracePending' = gracePending
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* Manual release_agent (one-way eviction).                                *)
(* ----------------------------------------------------------------------- *)

Release(c) ==
  /\ ~drained
  /\ c \notin released
  /\ status[c] \in {"running", "idle", "ready"}
  (* markReleasing is placed before the drain issuance (F12a); markReleased *)
  (* moves the id releasing -> released.                                   *)
  /\ releasing' = (releasing \union {c}) \ {c}
  /\ released' = released \union {c}
  /\ status' = [status EXCEPT ![c] = "gone"]
  /\ gracePending' = gracePending \ {c}
  /\ epochOpen' = [epochOpen EXCEPT ![c] = FALSE]
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* Late handler of a timed-out release attempt; refused while released.    *)

LateClear(c) ==
  /\ c \in releasing
  /\ c \notin released
  /\ releasing' = releasing \ {c}
  /\ status' = status
  /\ tier' = tier
  /\ epochOpen' = epochOpen
  /\ graceMember' = graceMember
  /\ gracePending' = gracePending
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* Session exit: whole-forest drain.                                        *)
(* ----------------------------------------------------------------------- *)

SessionExit ==
  /\ ~drained
  /\ drained' = TRUE
  /\ status' = [c \in Children |-> "gone"]
  /\ gracePending' = {}
  /\ epochOpen' = [c \in Children |-> FALSE]
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch

(* Terminal self-loop: keeps deadlock checking enabled.                    *)

Idle == UNCHANGED vars

Next ==
  \/ \E c \in Children : SpawnAtomic(c)
  \/ \E c \in Children : EpochEnd(c)
  \/ \E c \in Children : Settle(c)
  \/ \E c \in Children : GraceFire(c)
  \/ \E c \in Children : ContinueAdmit(c)
  \/ \E c \in Children : Promote(c)
  \/ \E c \in Children : Release(c)
  \/ \E c \in Children : LateClear(c)
  \/ SessionExit
  \/ Idle

Spec == Init /\ [][Next]_vars

(* ----------------------------------------------------------------------- *)
(* Invariants                                                               *)
(* ----------------------------------------------------------------------- *)

(* S-1: the live-capacity contract: at most MaxLive running children.      *)
(* Both the spawn lanes and continuation admission count live + promised    *)
(* slots under one lease, so no interleaving can overshoot.                *)
CapOK == LiveCount <= MaxLive

(* S-2: a released child never regains a live activation.                  *)
NoResurrect ==
  \A c \in released : status[c] \notin {"running", "idle"}

(* S-3: released and releasing marks are disjoint.                         *)
ReleasedDisjoint == released \intersect releasing = {}

(* S-4: an auto-release tombstone is only ever set on a child with no      *)
(* live activation.                                                        *)
TombstoneNonLive ==
  \A c \in tombstoned : status[c] \in {"ready", "gone"}

(* S-5: grace timers only exist for registry members.                      *)
GraceMemberOnly == gracePending \subseteq graceMember

(* S-6: no child runs an epoch after auto-release without a restart.        *)
NoLateEpoch == lateEpoch = {}

(* S-7: after session exit every child is drained.                          *)
DrainedQuiescent == drained => (\A c \in Children : status[c] = "gone")

(* S-8: promotion re-tiers the child to background exactly once.            *)
PromotedIsBackground == \A c \in promoted : tier[c] = "bg"


(* L-1 (excluded): eventual settle needs fairness and a harness turn-loop   *)
(* model; excluded - see design.md.                                        *)

=============================================================================
