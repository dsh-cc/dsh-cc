--------------------------- MODULE Model ---------------------------
(***************************************************************************)
(* Bounded model of the dsh-cc subagent child lifecycle after the rc.5      *)
(* capacity move: the per-parent admission lease, the harness resident-     *)
(* activation pool (maxActiveSubagents, 25), epoch end / settle, the grace  *)
(* window auto-release tombstones, the send_message cold-resume admission,  *)
(* manual release_agent eviction, Ctrl+B promotion and session-exit drain.  *)
(*                                                                         *)
(* The capacity valve is the harness pool, not a dsh-cc-side count: a slot  *)
(* is reserved at materialization and returned only at disposal, resident   *)
(* activations are running children, idle parents waiting on child          *)
(* settlement and cold-resumed children, and a send_message follow-up to an *)
(* already-resident child takes no slot (task/src/live-capacity.ts:1-16,    *)
(* resume-pins/src/live-capacity.ts:1-16). What dsh-cc still owns is the    *)
(* per-parent admission lease that serializes check+creation               *)
(* (resume-pins/src/admission.ts:19-55) and the continuation gate at        *)
(* tools/execute (dispatch-admission.ts:10-26).                            *)
(*                                                                         *)
(* See code-anchors.md for verbatim source excerpts.                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxLive, SplitContinue, CapIgnored, SkipSlotRelease

ASSUME /\ MaxLive \in 1..2
       /\ SplitContinue \in BOOLEAN
       /\ CapIgnored \in BOOLEAN
       /\ SkipSlotRelease \in BOOLEAN

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
          slotHolder, releasing, released, promoted, lateEpoch, drained

vars == <<status, tier, epochOpen, graceMember, gracePending, tombstoned,
          tombstoneEver, slotHolder, releasing, released, promoted, lateEpoch,
          drained>>

TypeOK ==
  /\ status \in [Children -> Statuses]
  /\ tier \in [Children -> {"fg", "bg"}]
  /\ epochOpen \in [Children -> BOOLEAN]
  /\ graceMember \subseteq Children
  /\ gracePending \subseteq Children
  /\ tombstoned \subseteq Children
  /\ tombstoneEver \subseteq Children
  /\ slotHolder \subseteq Children
  /\ releasing \subseteq Children
  /\ released \subseteq Children
  /\ promoted \subseteq Children
  /\ lateEpoch \subseteq Children
  /\ drained \in BOOLEAN

(* The pool contract: one slot per resident activation, and the pool refuses *)
(* past MaxLive. A follow-up to a resident child takes no new slot; a cold   *)
(* resume of a settled child does.                                          *)
ResidentCount == Cardinality(slotHolder)

PoolHasRoom(c) == CapIgnored \/ (c \in slotHolder \/ ResidentCount < MaxLive)

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
  /\ slotHolder = {}
  /\ releasing = {}
  /\ released = {}
  /\ promoted = {}
  /\ lateEpoch = {}
  /\ drained = FALSE

(* ----------------------------------------------------------------------- *)
(* Spawn: one atomic step (harness `startActivation` reserves the slot and  *)
(* materializes under the admission lease the dsh-cc lane holds across the  *)
(* creation call). A refusal at the cap is ACTIVATION_LIMIT_REACHED.        *)
(* ----------------------------------------------------------------------- *)

SpawnAtomic(c) ==
  /\ ~drained
  /\ status[c] = "none"
  /\ c \notin released
  /\ PoolHasRoom(c)
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ slotHolder' = slotHolder \union {c}
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

(* A follow-up to an already-resident child: it takes no slot, so it is      *)
(* admitted even at the cap (index.ts:185).                                 *)
FollowUp(c) ==
  /\ ~drained
  /\ status[c] = "idle"
  /\ c \in slotHolder
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<tier, graceMember, gracePending, tombstoned, tombstoneEver,
                 slotHolder, releasing, released, promoted, lateEpoch, drained>>

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
  /\ UNCHANGED <<tier, graceMember, tombstoned, tombstoneEver, slotHolder,
                 releasing, released, promoted, lateEpoch, drained>>

(* Settle disposes the activation, so the slot goes back to the pool.       *)
Settle(c) ==
  /\ status[c] \in {"running", "idle"}
  /\ status' = [status EXCEPT ![c] = "ready"]
  /\ slotHolder' = slotHolder \ {c}
  /\ gracePending' = ArmGrace(c, c \in graceMember, gracePending)
  /\ epochOpen' = [epochOpen EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<tier, graceMember, tombstoned, tombstoneEver, releasing,
                 released, promoted, lateEpoch, drained>>

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
  /\ UNCHANGED <<status, tier, epochOpen, graceMember, slotHolder, releasing,
                 released, promoted, lateEpoch, drained>>

(* ----------------------------------------------------------------------- *)
(* send_message continuation admission (tools/execute, after approval).     *)
(* A cold resume of a settled child needs a pool slot: the harness throws   *)
(* ACTIVATION_LIMIT_REACHED inside the activation, so the refusal now       *)
(* happens after the lease is taken, not at a dsh-cc-side count.           *)
(*                                                                         *)
(* SplitContinue = FALSE (convention): the tombstone gate and the delivery *)
(* are ordered. SplitContinue = TRUE (probe): a grace fire lands between    *)
(* them (the documented accepted residual, release.ts:110-117).            *)
(* ----------------------------------------------------------------------- *)

ContinueAdmit(c) ==
  /\ ~drained
  /\ status[c] = "ready"
  /\ c \in graceMember
  /\ c \notin released
  /\ PoolHasRoom(c)
  /\ IF SplitContinue THEN TRUE ELSE c \notin tombstoned
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ slotHolder' = slotHolder \union {c}
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  /\ lateEpoch' = lateEpoch \union (IF c \in tombstoned THEN {c} ELSE {})
  /\ tombstoned' = tombstoned \ {c}
  /\ gracePending' = gracePending \ {c}
  /\ UNCHANGED <<tier, graceMember, tombstoneEver, releasing, released,
                 promoted, drained>>

(* ----------------------------------------------------------------------- *)
(* Ctrl+B promotion: a foreground child is re-tiered to background and its  *)
(* grace window re-armed.                                                  *)
(* ----------------------------------------------------------------------- *)

Promote(c) ==
  /\ c \notin promoted
  /\ status[c] \in {"running", "idle", "ready"}
  /\ promoted' = promoted \union {c}
  /\ tier' = [tier EXCEPT ![c] = "bg"]
  /\ gracePending' = ArmGrace(c, c \in graceMember, gracePending)
  /\ UNCHANGED <<status, epochOpen, graceMember, tombstoned, tombstoneEver,
                 slotHolder, releasing, released, lateEpoch, drained>>

(* ----------------------------------------------------------------------- *)
(* release_agent: mark, then evict. The eviction returns the slot.          *)
(* ----------------------------------------------------------------------- *)

ReleaseStart(c) ==
  /\ c \notin released
  /\ c \notin releasing
  /\ status[c] \in {"running", "idle", "ready"}
  /\ releasing' = releasing \union {c}
  /\ UNCHANGED <<status, tier, epochOpen, graceMember, gracePending, tombstoned,
                 tombstoneEver, slotHolder, released, promoted, lateEpoch,
                 drained>>

ReleaseFinish(c) ==
  /\ c \in releasing
  /\ releasing' = releasing \ {c}
  /\ released' = released \union {c}
  /\ status' = [status EXCEPT ![c] = "gone"]
  /\ slotHolder' = IF SkipSlotRelease THEN slotHolder ELSE slotHolder \ {c}
  /\ gracePending' = gracePending \ {c}
  /\ UNCHANGED <<tier, epochOpen, graceMember, tombstoned, tombstoneEver,
                 promoted, lateEpoch, drained>>

(* A late continuation arriving after the release marker is refused; the     *)
(* marker is cleared only once the eviction settled.                       *)
LateClear(c) ==
  /\ c \in releasing
  /\ releasing' = releasing \ {c}
  /\ UNCHANGED <<status, tier, epochOpen, graceMember, gracePending, tombstoned,
                 tombstoneEver, slotHolder, released, promoted, lateEpoch,
                 drained>>

(* ----------------------------------------------------------------------- *)
(* Session exit drains the whole forest.                                    *)
(* ----------------------------------------------------------------------- *)

SessionExit ==
  /\ ~drained
  /\ drained' = TRUE
  /\ status' = [c \in Children |-> "gone"]
  /\ released' = releasing \union released \union Children
  /\ slotHolder' = IF SkipSlotRelease THEN slotHolder ELSE {}
  /\ releasing' = {}
  /\ gracePending' = {}
  /\ UNCHANGED <<tier, epochOpen, graceMember, tombstoned, tombstoneEver,
                 promoted, lateEpoch>>

(* ----------------------------------------------------------------------- *)
(* Invariants                                                              *)
(* ----------------------------------------------------------------------- *)

(* S-1: the pool's resident-activation cap. A slot exists exactly while a   *)
(* resident activation exists, so the cap is on residents, not on running   *)
(* children only.                                                          *)
CapOK == ResidentCount <= MaxLive

(* S-2: a slot is held exactly by a resident activation: running, or idle   *)
(* waiting on settlement. A settled (ready) or evicted (gone) child holds   *)
(* none.                                                                  *)
SlotIsActivation == slotHolder = {c \in Children : status[c] \in {"running", "idle"}}

(* S-3: an eviction returns its slot; a drained forest holds none.          *)
DrainedNoSlot == drained => slotHolder = {}

(* S-4: a released child never regains a live activation.                  *)
NoResurrect ==
  \A c \in released : status[c] \notin {"running", "idle"}

(* S-5: released and releasing marks are disjoint.                         *)
ReleasedDisjoint == released \intersect releasing = {}

(* S-6: an auto-release tombstone is only ever set on a child with no      *)
(* live activation.                                                        *)
TombstoneNonLive ==
  \A c \in tombstoned : status[c] \in {"ready", "gone"}

(* S-7: grace timers only exist for registry members.                      *)
GraceMemberOnly == gracePending \subseteq graceMember

(* S-8: no child runs an epoch after auto-release without a restart.        *)
NoLateEpoch == lateEpoch = {}

(* S-9: after session exit every child is drained.                          *)
DrainedQuiescent == drained => (\A c \in Children : status[c] = "gone")

(* S-10: promotion re-tiers the child to background exactly once.            *)
PromotedIsBackground == \A c \in promoted : tier[c] = "bg"

(* L-1 (excluded): eventual settle needs fairness and a harness turn-loop   *)
(* model; excluded - see design.md.                                        *)

(* ----------------------------------------------------------------------- *)
(* Spec                                                                    *)
(* ----------------------------------------------------------------------- *)

(* Terminal self-loop: once the forest is drained nothing may change, but    *)
(* CHECK_DEADLOCK stays meaningful for every live state.                    *)
Idle ==
  /\ drained
  /\ UNCHANGED vars

Next ==
  \/ Idle
  \/ \E c \in Children :
       \/ SpawnAtomic(c)
       \/ FollowUp(c)
       \/ EpochEnd(c)
       \/ Settle(c)
       \/ GraceFire(c)
       \/ ContinueAdmit(c)
       \/ Promote(c)
       \/ ReleaseStart(c)
       \/ ReleaseFinish(c)
       \/ LateClear(c)
  \/ SessionExit

Spec == Init /\ [][Next]_vars

=============================================================================
