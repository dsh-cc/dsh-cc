--------------------------- MODULE Model ---------------------------
(***************************************************************************)
(* Bounded model of the dsh-cc subagent child lifecycle:                   *)
(* capacity admission (25-cap), epoch end / settle, grace-window           *)
(* auto-release tombstones, send_message admission gate, manual            *)
(* release_agent eviction, Ctrl+B promotion, and session-exit drain.       *)
(*                                                                         *)
(* Abstracted from packages/subagent/task (background-start.ts,            *)
(* grace-window.ts, release.ts, epoch-collector.ts, tool.ts) and          *)
(* packages/subagent/resume-pins (plugin.ts send_message gate).            *)
(* See code-anchors.md for verbatim source excerpts.                       *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS MaxLive, SplitAdmission, SplitContinue

Children == 1..3

Statuses == {"none", "pending", "running", "idle", "ready", "gone"}

(* status of a child:                                                     *)
(*   none    - never spawned                                              *)
(*   pending - capacity check passed, startContinuable still in flight    *)
(*             (only reachable when SplitAdmission = TRUE)                *)
(*   running - live activation executing a turn                           *)
(*   idle    - live activation, no turn in flight                         *)
(*   ready   - settled; registry row exists, no live activation           *)
(*   gone    - evicted (released / drained)                                *)

VARIABLES status, tier, epochOpen, admitted,
          graceMember, gracePending, tombstoned, tombstoneEver,
          releasing, released, promoted, lateEpoch, drained

vars == <<status, tier, epochOpen, admitted,
          graceMember, gracePending, tombstoned, tombstoneEver,
          releasing, released, promoted, lateEpoch, drained>>

TypeOK ==
  /\ status \in [Children -> Statuses]
  /\ tier \in [Children -> {"fg", "bg"}]
  /\ epochOpen \in [Children -> BOOLEAN]
  /\ admitted \subseteq Children
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

(* ----------------------------------------------------------------------- *)
(* Init                                                                    *)
(* ----------------------------------------------------------------------- *)

Init ==
  /\ status = [c \in Children |-> "none"]
  /\ tier = [c \in Children |-> "fg"]
  /\ epochOpen = [c \in Children |-> FALSE]
  /\ admitted = {}
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
(* Spawn: capacity admission                                              *)
(* Convention (SplitAdmission = FALSE): the live-capacity guard and the   *)
(* start are one atomic step (assertLiveCapacity then startContinuable    *)
(* with no observable interleaving point in the modeled abstraction).     *)
(* Strict probe (SplitAdmission = TRUE): the guard reads LiveCount, then  *)
(* a separate step completes the start - the two awaits in               *)
(* background-start.ts:220-228 admit an overshoot.                        *)
(* ----------------------------------------------------------------------- *)

SpawnAtomic(c) ==
  /\ ~SplitAdmission
  /\ ~drained
  /\ status[c] = "none"
  /\ c \notin released
  /\ LiveCount < MaxLive
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ tier' = [tier EXCEPT ![c] = "fg"]
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  /\ graceMember' = graceMember \union {c}
  /\ admitted' = admitted
  /\ gracePending' = gracePending
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

SpawnCheck(c) ==
  /\ SplitAdmission
  /\ ~drained
  /\ status[c] = "none"
  /\ c \notin released
  /\ LiveCount < MaxLive
  /\ status' = [status EXCEPT ![c] = "pending"]
  /\ tier' = [tier EXCEPT ![c] = "fg"]
  /\ epochOpen' = epochOpen
  /\ graceMember' = graceMember \union {c}
  /\ admitted' = admitted
  /\ gracePending' = gracePending
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

SpawnStart(c) ==
  /\ SplitAdmission
  /\ status[c] = "pending"
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ admitted' = admitted
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
(* EpochEnd: subagent/end while the activation is still live -> idle;      *)
(* the grace timer is (re)armed for registry members.                      *)
(* Settle: the activation is dropped -> ready (cold-resumable row);       *)
(* grace timer armed for registry members.                                 *)
(* ----------------------------------------------------------------------- *)

ArmGrace(c, mem, pend) ==
  IF mem THEN pend \union {c} ELSE pend

EpochEnd(c) ==
  /\ status[c] = "running"
  /\ status' = [status EXCEPT ![c] = "idle"]
  /\ gracePending' = ArmGrace(c, c \in graceMember, gracePending)
  /\ epochOpen' = [epochOpen EXCEPT ![c] = FALSE]
  /\ tier' = tier
  /\ admitted' = admitted
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
  /\ admitted' = admitted
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
(* timer re-arms (no state change in the model); a ready child is          *)
(* tombstoned (release marker set).                                        *)
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
  /\ admitted' = admitted
  /\ graceMember' = graceMember
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* ----------------------------------------------------------------------- *)
(* send_message admission gate and restart (a new epoch on a ready child). *)
(* Convention (SplitContinue = FALSE): the marker check and the restart   *)
(* are one atomic step; a tombstoned or released id is denied.             *)
(* Strict probe (SplitContinue = TRUE): the gate check is a separate step  *)
(* from the restart, so a grace fire landing between them admits one      *)
(* extra epoch for an auto-released child (documented accepted residual,  *)
(* release.ts:110-117).                                                    *)
(* ----------------------------------------------------------------------- *)

ContinueCheck(c) ==
  /\ SplitContinue
  /\ ~drained
  /\ status[c] = "ready"
  /\ c \in graceMember
  /\ c \notin tombstoned
  /\ c \notin released
  /\ admitted' = admitted \union {c}
  /\ status' = status
  /\ tier' = tier
  /\ epochOpen' = epochOpen
  /\ graceMember' = graceMember
  /\ gracePending' = gracePending
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ releasing' = releasing
  /\ released' = released
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

Restart(c) ==
  /\ ~drained
  /\ status[c] = "ready"
  /\ c \in graceMember
  /\ c \notin released
  /\ \/ /\ ~SplitContinue
        /\ c \notin tombstoned
     \/ /\ SplitContinue
        /\ c \in admitted
  /\ status' = [status EXCEPT ![c] = "running"]
  /\ epochOpen' = [epochOpen EXCEPT ![c] = TRUE]
  (* a restart through a stale admission that races a grace fire is        *)
  (* recorded as a late epoch; subagent/start clears the tombstone         *)
  (* (grace-window clearTombstone path), so tombstoned is cleared          *)
  (* either way.                                                           *)
  /\ lateEpoch' = lateEpoch \union (IF c \in tombstoned THEN {c} ELSE {})
  /\ tombstoned' = tombstoned \ {c}
  /\ admitted' = admitted \ {c}
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
(* Guard: the epoch is still open (the collect has not settled) and the    *)
(* child was not promoted before; a FINISHED collect cannot promote.      *)
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
  /\ admitted' = admitted
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
(* markReleasing is placed before the drain issuance so a concurrent       *)
(* collect sees the mark; the eviction frees the slot exactly when the     *)
(* child was running. Released is monotone for process life.               *)
(* ----------------------------------------------------------------------- *)

Release(c) ==
  /\ ~drained
  /\ c \notin released
  /\ status[c] \in {"running", "idle", "ready"}
  (* markReleasing is placed before the drain issuance (F12a);           *)
  (* markReleased moves the id releasing -> released (releases delete     *)
  (* the releasing mark).                                                  *)
  /\ releasing' = (releasing \union {c}) \ {c}
  /\ released' = released \union {c}
  /\ status' = [status EXCEPT ![c] = "gone"]
  /\ gracePending' = gracePending \ {c}
  /\ epochOpen' = [epochOpen EXCEPT ![c] = FALSE]
  /\ admitted' = admitted \ {c}
  /\ tier' = tier
  /\ graceMember' = graceMember
  /\ tombstoned' = tombstoned
  /\ tombstoneEver' = tombstoneEver
  /\ promoted' = promoted
  /\ lateEpoch' = lateEpoch
  /\ drained' = drained

(* Late handler of a timed-out release attempt trying to clear the        *)
(* releasing mark; refused while released (clobber-proofing,              *)
(* release.ts clearReleasing guard).                                       *)

LateClear(c) ==
  /\ c \in releasing
  /\ c \notin released
  /\ releasing' = releasing \ {c}
  /\ status' = status
  /\ tier' = tier
  /\ epochOpen' = epochOpen
  /\ admitted' = admitted
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
(* Every in-flight turn is aborted, every activation evicted; a drained   *)
(* child does not resume on the next send_message (persisted session      *)
(* survives on disk only).                                                  *)
(* ----------------------------------------------------------------------- *)

SessionExit ==
  /\ ~drained
  /\ drained' = TRUE
  /\ status' = [c \in Children |-> "gone"]
  /\ admitted' = {}
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

(* Terminal self-loop: keeps deadlock checking enabled without            *)
(* disabling any behavior.                                                 *)

Idle == UNCHANGED vars

Next ==
  \/ \E c \in Children : SpawnAtomic(c)
  \/ \E c \in Children : SpawnCheck(c)
  \/ \E c \in Children : SpawnStart(c)
  \/ \E c \in Children : EpochEnd(c)
  \/ \E c \in Children : Settle(c)
  \/ \E c \in Children : GraceFire(c)
  \/ \E c \in Children : ContinueCheck(c)
  \/ \E c \in Children : Restart(c)
  \/ \E c \in Children : Promote(c)
  \/ \E c \in Children : Release(c)
  \/ \E c \in Children : LateClear(c)
  \/ SessionExit
  \/ Idle

Spec == Init /\ [][Next]_vars

(* ----------------------------------------------------------------------- *)
(* Invariants                                                               *)
(* ----------------------------------------------------------------------- *)

(* S-1: the live-capacity contract: at most MaxLive running children.     *)
CapOK == LiveCount <= MaxLive

(* S-2: a released child never regains a live activation (one-way        *)
(* eviction; send_message denied before pin admission).                   *)
NoResurrect ==
  \A c \in released : status[c] \notin {"running", "pending", "idle"}

(* S-3: released and releasing marks are disjoint (markReleased moves     *)
(* releasing -> released), and the refused-while-released clearReleasing  *)
(* guard means a stale late handler of a timed-out attempt can never      *)
(* resurrect or clobber a completed release.                              *)
ReleasedDisjoint == released \intersect releasing = {}

(* S-4: an auto-release tombstone is only ever set on a child with no     *)
(* live activation, and never coexists with a live one.                   *)
TombstoneNonLive ==
  \A c \in tombstoned : status[c] \in {"ready", "gone"}

(* S-5: grace timers only exist for registry members.                     *)
GraceMemberOnly == gracePending \subseteq graceMember

(* S-6: no child runs an epoch after having been auto-released            *)
(* (tombstoned) without an intervening legitimate restart. Under the       *)
(* convention (atomic gate) this holds; the split-gate probe violates     *)
(* it by design (accepted residual).                                       *)
NoLateEpoch == lateEpoch = {}

(* S-7: after session exit every child is drained - no live activation    *)
(* and no pending admission survives.                                     *)
DrainedQuiescent == drained => (\A c \in Children : status[c] = "gone")

(* S-8: promotion re-tiers the child to background exactly once and       *)
(* never leaves a foreground tier behind (the settle-wins race itself is  *)
(* encoded structurally: Promote requires epochOpen, so a FINISHED        *)
(* collect - whose Settle closed the epoch - cannot promote; TLC         *)
(* explores both interleavings).                                           *)
PromotedIsBackground == \A c \in promoted : tier[c] = "bg"

(* L-1 (excluded): eventual settle of a running child requires fairness  *)
(* and a real-time model of the harness turn loop; excluded - see         *)
(* design.md "Exclusions".                                                 *)

=============================================================================
