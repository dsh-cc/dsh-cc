-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* memory-write-lifecycle: the concurrent write path of the memory system.  *)
(*                                                                         *)
(* Two host processes share one memory directory. Each may run the visible  *)
(* save (tool-invoked, unlocked) and the turn-end consolidation dream       *)
(* (lock-guarded, started either by the forced-dream marker or by the       *)
(* periodic time gate). The model pins the INTENDED protocol and exposes    *)
(* each gap through a fault switch:                                        *)
(*                                                                         *)
(* - an index write is a read-verify-write: the writer commits only when    *)
(*   the durable index still equals the snapshot it built from (the same    *)
(*   read-back idiom lock.ts:100-106 already uses for the lock file).       *)
(*   UnlockedSave drops that guard for saves; DreamNoCas drops it for the   *)
(*   dream batch.                                                          *)
(* - topic files are written before the index entries that point at them    *)
(*   (save.ts:239 writeMemoryFiles order); DreamIndexFirst flips the batch  *)
(*   order for the dream, which is what makes a crash leave a dangling      *)
(*   pointer.                                                              *)
(* - the pressure marker is only tombstoned by a dream that served the arm  *)
(*   it read; ClearWithoutRun drops that guard (a save that arms during a   *)
(*   running dream is then lost).                                          *)
(* - the index stays within its cap; SkipCap drops the dream's cap guard.   *)
(*                                                                         *)
(* Lock mechanics are atomic in the model (acquire = write + read-back      *)
(* verify); the acknowledged sub-millisecond symmetric collision is an      *)
(* accepted residual (E-2), not re-derived. A dream that outlives the stale *)
(* window preempting a live holder is a separate probe (strict-live-        *)
(* preemption): with FreeTicks the clock advances inside a critical         *)
(* section and lock.ts:19's documented preemption becomes reachable.        *)
(*                                                                         *)
(* Time is a bounded logical tick; the 1h stale window, the 60m pressure    *)
(* cooldown and the periodic time gate are abstracted to tick counts.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT UnlockedSave, DreamNoCas, DreamIndexFirst, ClearWithoutRun, SkipCap,
         FreeTicks, MaxLines, StaleTicks, CooldownTicks, MinTicks, TMax

ASSUME /\ UnlockedSave \in BOOLEAN
       /\ DreamNoCas \in BOOLEAN
       /\ DreamIndexFirst \in BOOLEAN
       /\ ClearWithoutRun \in BOOLEAN
       /\ SkipCap \in BOOLEAN
       /\ FreeTicks \in BOOLEAN
       /\ MaxLines \in 1..3
       /\ StaleTicks \in 1..3
       /\ CooldownTicks \in 0..2
       /\ MinTicks \in 1..3
       /\ TMax \in 2..4

(* Bounded universes. Every sentinel is a string; epochs are naturals with 0 *)
(* as "never" and are only ever compared with naturals.                     *)
Procs == {"p1", "p2"}
Names == {"n1", "n2", "n3"}
Ticks == 0..TMax

Kinds  == {"none", "save", "dream"}
Phases == {"none", "read", "saving", "stamped", "locked", "forked", "built",
           "topics", "indexfirst", "written"}
(* The lock is held from acquisition through the clear/fail: "written" is    *)
(* still inside the critical section, since the marker and the lock are only *)
(* released by DreamClear or DreamFail.                                      *)
CriticalPhases == {"locked", "forked", "built", "topics", "indexfirst",
                   "written"}
Bodies == {"none", "body"}
Modes  == {"none", "pressure", "periodic"}

PendType ==
  [ kind:  Kinds
  , mode:  Modes
  , name:  {"none"} \cup Names
  , snap:  SUBSET Names
  , next:  SUBSET Names
  , armed: Ticks
  , prior: Ticks
  , phase: Phases ]

LockType  == [holder: {"none"} \cup Procs, at: Ticks]
StampType == [armedAt: Ticks, lastForcedAt: Ticks]

PendNone ==
  [ kind |-> "none", mode |-> "none", name |-> "none", snap |-> {},
    next |-> {}, armed |-> 0, prior |-> 0, phase |-> "none" ]

MakePend(k, m, n, sn, nx, ar, pr, ph) ==
  [ kind |-> k, mode |-> m, name |-> n, snap |-> sn, next |-> nx,
    armed |-> ar, prior |-> pr, phase |-> ph ]

(* Durable state: the index pointer set, topic-file bodies, the lock file,   *)
(* the pressure marker, the newest arm timestamp and the newest arm a dream  *)
(* actually served (both monotone epochs, so pressure is level-triggered).   *)
(* savedSince holds names whose pointer a save committed after the current   *)
(* dream's fork snapshot; that snapshot is the point from which a rewrite    *)
(* would destroy them.                                                      *)
VARIABLES idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince, pend,
          alive, now

vars == <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince, pend,
          alive, now>>

InCrit(p) == pend[p].phase \in CriticalPhases

Present == {n \in Names : topic[n] = "body"}

(* The cap decision is taken at READ time against the snapshot the save read  *)
(* (save.ts:200-222 reads the entrypoint, then validates topic + upserted     *)
(* pointer as one batch), and it is not re-evaluated when the write lands.    *)
CapReached(p) ==
  Cardinality(pend[p].snap \cup {pend[p].name}) > MaxLines

AnyCrit == \E p \in Procs : InCrit(p)

Init ==
  /\ idx = {}
  /\ topic = [n \in Names |-> "none"]
  /\ lock = [holder |-> "none", at |-> 0]
  /\ stamp = [armedAt |-> 0, lastForcedAt |-> 0]
  /\ lastArmAt = 0
  /\ lastServedAt = 0
  /\ savedSince = {}
  /\ pend = [p \in Procs |-> PendNone]
  /\ alive = [p \in Procs |-> TRUE]
  /\ now = 0

(* Logical time. By default a tick is a quiescent boundary: the stale window *)
(* and the cooldown only pass between operations, which a dream of seconds   *)
(* against a one-hour window justifies. FreeTicks removes that restriction   *)
(* so the live-holder preemption stays reachable as a probe.                *)
Tick ==
  /\ now < TMax
  /\ \/ FreeTicks
     \/ ~AnyCrit
  /\ now' = now + 1
  /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
             pend, alive>>

(* ---------------------------------------------------------------- saves *)

(* The save reads the index and validates topic + upserted pointer as one    *)
(* batch (save.ts:200-237). No lock is taken.                               *)
SaveRead(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ \E n \in Names :
       /\ pend' = [pend EXCEPT ![p] = MakePend("save", "none", n, idx, {}, 0, 0, "read")]
       /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

(* Cap rejection: nothing is written and the forced-dream marker is armed    *)
(* (save.ts:232-238). Arming preserves lastForcedAt.                        *)
SaveReject(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "read"
  /\ CapReached(p)
  /\ stamp' = [stamp EXCEPT !.armedAt = now]
  /\ lastArmAt' = now
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, topic, lock, lastServedAt, savedSince, alive, now>>

(* Topic file first, then the pointer: the order that makes a dangling       *)
(* pointer unreachable for the save path (save.ts:239).                     *)
SaveTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "read"
  /\ ~CapReached(p)
  /\ topic' = [topic EXCEPT ![pend[p].name] = "body"]
  /\ pend' = [pend EXCEPT ![p].phase = "saving"]
  /\ UNCHANGED <<idx, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

(* The index write. The intended protocol is read-verify-write: the commit   *)
(* requires the durable index to still equal the snapshot the save read.     *)
(* UnlockedSave drops the verification, so a concurrent writer's pointer is  *)
(* overwritten by the stale upsert result.                                  *)
SaveIndex(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "saving"
  /\ IF UnlockedSave
       THEN idx' = pend[p].snap \cup {pend[p].name}
       ELSE /\ idx = pend[p].snap
            /\ idx' = idx \cup {pend[p].name}
  (* Only an ADDED pointer is protected: overwriting a name that is already  *)
  (* indexed changes no pointer, so a later compaction dropping it is not a  *)
  (* lost update.                                                           *)
  /\ savedSince' = IF pend[p].name \in idx
       THEN savedSince
       ELSE savedSince \cup {pend[p].name}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now>>

(* --------------------------------------------------------------- dreams *)

(* Pressure mode: an armed marker bypasses the time and session gates, and   *)
(* markPressureForced runs BEFORE lock acquisition (index.ts:316 vs :339),   *)
(* so the cooldown slot is consumed even when the lock is held elsewhere.    *)
DreamStampPressure(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ stamp.armedAt > 0
  /\ now >= stamp.lastForcedAt + CooldownTicks
  /\ stamp' = [stamp EXCEPT !.lastForcedAt = now]
  /\ pend' = [pend EXCEPT ![p] =
       MakePend("dream", "pressure", "none", {}, {}, stamp.armedAt, 0, "stamped")]
  /\ UNCHANGED <<idx, topic, lock, lastArmAt, lastServedAt, savedSince, alive,
             now>>

(* Periodic mode: the time gate over the last consolidation epoch, which the *)
(* lock file carries (gates.ts:29-32). The session-count gate is E-7.       *)
DreamStampPeriodic(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ stamp.armedAt = 0
  /\ now >= lock.at + MinTicks
  /\ pend' = [pend EXCEPT ![p] =
       MakePend("dream", "periodic", "none", {}, {}, 0, 0, "stamped")]
  /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

(* Reclaim is allowed when the lock is free or its stamp passed the stale    *)
(* window (lock.ts:84); a fresh holder blocks.                              *)
DreamLock(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "stamped"
  /\ \/ lock.holder = "none"
     \/ (lock.holder # p /\ now >= lock.at + StaleTicks)
  /\ lock' = [holder |-> p, at |-> now]
  /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.prior = lock.at, !.phase = "locked"]]
  /\ UNCHANGED <<idx, topic, stamp, lastArmAt, lastServedAt, savedSince, alive,
             now>>

(* A fresh foreign holder makes the dream return without rollback; the stamp *)
(* stays consumed (index.ts:353-397).                                       *)
DreamBlocked(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "stamped"
  /\ lock.holder # "none"
  /\ lock.holder # p
  /\ now < lock.at + StaleTicks
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

(* The fork reads the index. That snapshot is the baseline: pointers a save  *)
(* commits after it are the ones a rewrite must not destroy, so the saved-   *)
(* pointer set starts empty here rather than at the index write.            *)
DreamFork(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "locked"
  /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.snap = idx, !.phase = "forked"]]
  /\ savedSince' = {}
  /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, alive, now>>

(* The reported batch decides the next index content: it may keep, merge or  *)
(* drop entries, which is why it is an arbitrary subset rather than a        *)
(* superset of the snapshot. The cap guard stands unless SkipCap; the        *)
(* truncate fallback is the in-cap alternative for an over-limit report.     *)
DreamBuild(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "forked"
  /\ \E nx \in SUBSET Names :
       /\ Cardinality(nx) <= MaxLines \/ SkipCap
       /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.next = nx, !.phase = "built"]]
       /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

DreamWriteTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "built"
  /\ topic' = [n \in Names |-> IF n \in pend[p].next THEN "body" ELSE topic[n]]
  /\ pend' = [pend EXCEPT ![p].phase = "topics"]
  /\ UNCHANGED <<idx, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

(* Intended order: topics, then the index over the content the batch built.  *)
(* The read-verify guard is the one a save may have invalidated since the    *)
(* fork; when that happened the dream must abort rather than overwrite.      *)
DreamPublish(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "topics"
  /\ ~DreamNoCas
  /\ idx = pend[p].snap
  /\ idx' = pend[p].next
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, savedSince, alive,
             now>>

(* DreamNoCas: the batch publishes its own content over the index without    *)
(* checking that the index still matched its snapshot. A pointer a save      *)
(* committed after the fork is erased.                                      *)
DreamClobber(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "topics"
  /\ DreamNoCas
  /\ idx' = pend[p].next
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, savedSince, alive,
             now>>

(* DreamIndexFirst: the index is published before the topic files it points  *)
(* at, so a crash between the two leaves a dangling pointer.                *)
DreamPublishFirst(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "built"
  /\ DreamIndexFirst
  /\ IF DreamNoCas
       THEN idx' = pend[p].next
       ELSE /\ idx = pend[p].snap
            /\ idx' = pend[p].next
  /\ pend' = [pend EXCEPT ![p].phase = "indexfirst"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, savedSince, alive,
             now>>

DreamTopicsAfter(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "indexfirst"
  /\ topic' = [n \in Names |-> IF n \in pend[p].next THEN "body" ELSE topic[n]]
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<idx, lock, stamp, lastArmAt, lastServedAt, savedSince,
             alive, now>>

(* Completion tombstones the marker and releases the lock while keeping the  *)
(* consolidation epoch. The intended guard: the dream may only tombstone the *)
(* arm it actually serves. A newer arm (a save that armed during the run)    *)
(* must survive.                                                            *)
DreamClear(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "written"
  /\ \/ /\ ~ClearWithoutRun
        /\ stamp.armedAt = pend[p].armed
        /\ lastServedAt' = IF pend[p].armed > lastServedAt
                             THEN pend[p].armed
                             ELSE lastServedAt
     \/ /\ ClearWithoutRun
        /\ UNCHANGED lastServedAt
  /\ stamp' = [stamp EXCEPT !.armedAt = 0]
  /\ lock' = [holder |-> "none", at |-> now]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, topic, lastArmAt, savedSince, alive, now>>

(* A failed or killed dream rolls the lock back to the epoch it captured      *)
(* before acquisition, so the consolidation timestamp does not advance       *)
(* (lock.ts:120-124).                                                        *)
DreamFail(p) ==
  /\ alive[p]
  /\ InCrit(p)
  /\ lock' = [holder |-> "none", at |-> pend[p].prior]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, topic, stamp, lastArmAt, lastServedAt, savedSince, alive,
             now>>

(* A crash loses in-process state only: the index, topics, lock file and     *)
(* marker are durable, so a crashed holder is reclaimed only through the     *)
(* stale window.                                                            *)
Crash(p) ==
  /\ alive[p]
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
             now>>

(* ------------------------------------------------------------- safety *)

TypeOK ==
  /\ idx \in SUBSET Names
  /\ topic \in [Names -> Bodies]
  /\ lock \in LockType
  /\ stamp \in StampType
  /\ lastArmAt \in Ticks
  /\ lastServedAt \in Ticks
  /\ savedSince \in SUBSET Names
  /\ pend \in [Procs -> PendType]
  /\ alive \in [Procs -> BOOLEAN]
  /\ now \in Ticks

(* S-1: a pointer a save committed after a dream's fork snapshot is still in *)
(* the index after that dream publishes. Both the save/save lost update and  *)
(* the dream erasing a newer save violate this.                             *)
NoLostSave == savedSince \subseteq idx

(* S-2: the index never points at a topic file that was not written first.  *)
NoDanglingPointer == idx \subseteq Present

(* S-3: the index stays within its cap; the truncate fallback is the only    *)
(* in-cap way to serve an over-limit report.                                *)
CapSound == Cardinality(idx) <= MaxLines

(* S-4: pressure is level-triggered: while any arm is outstanding the marker *)
(* is armed, and a served arm covers every older arm. The only violation is  *)
(* a tombstone that served nothing at or after the newest arm.                *)
NoLostPressure == stamp.armedAt > 0 \/ lastServedAt >= lastArmAt

(* S-5: at most one process is inside the dream critical section, and it is  *)
(* the recorded lock holder. Only the stale-window preemption of a dream     *)
(* that outlives the window can break this (probe strict-live-preemption).   *)
OneDreamer == \A p, q \in Procs : p # q => ~(InCrit(p) /\ InCrit(q))

HoldsLock == \A p \in Procs : InCrit(p) => lock.holder = p

(* --------------------------------------------------------------- spec *)

Idle ==
  /\ \A p \in Procs : ~alive[p]
  /\ UNCHANGED vars

Next ==
  \/ Tick
  \/ Idle
  \/ \E p \in Procs :
       \/ SaveRead(p)
       \/ SaveReject(p)
       \/ SaveTopics(p)
       \/ SaveIndex(p)
       \/ DreamStampPressure(p)
       \/ DreamStampPeriodic(p)
       \/ DreamLock(p)
       \/ DreamBlocked(p)
       \/ DreamFork(p)
       \/ DreamBuild(p)
       \/ DreamWriteTopics(p)
       \/ DreamPublish(p)
       \/ DreamClobber(p)
       \/ DreamPublishFirst(p)
       \/ DreamTopicsAfter(p)
       \/ DreamClear(p)
       \/ DreamFail(p)
       \/ Crash(p)

Spec == Init /\ [][Next]_vars

=============================================================================
