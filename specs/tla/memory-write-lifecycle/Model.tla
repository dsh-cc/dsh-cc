-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* memory-write-lifecycle: the concurrent write path of the memory system.  *)
(*                                                                         *)
(* Three writers share one memory directory: the visible save (tool-        *)
(* invoked, unlocked), the turn-end extraction fork (unlocked,            *)
(* index.ts:218-235 -> memory-job.ts:150-151), and the consolidation dream *)
(* (lock-guarded, started by the forced-dream marker or the periodic gate). *)
(*                                                                         *)
(* The model pins the INTENDED protocol and exposes each gap through a      *)
(* fault switch:                                                          *)
(*                                                                         *)
(* - every index write is a read-verify-write against the index REVISION    *)
(*   it read (the read-back idiom lock.ts:100-106 already uses for the lock *)
(*   file). A revision, not just a pointer set, is required: a save that    *)
(*   rewrites an existing pointer's content leaves the set unchanged but    *)
(*   still invalidates an older writer's snapshot. UnlockedSave /           *)
(*   DreamNoCas / UnlockedExtract drop the guard for one writer each.       *)
(* - topic files are written before the index entries that point at them    *)
(*   (save.ts:239); DreamIndexFirst flips the dream batch order, which is   *)
(*   what makes a crash leave a dangling pointer.                          *)
(* - the pressure marker is only tombstoned by a dream that serves the arm  *)
(*   it read, and the cooldown reference advances to the clear time         *)
(*   (pressure.ts:117-122); ClearWithoutRun drops that guard.              *)
(* - a successful dream writes NO lock: the file keeps the holder and the   *)
(*   acquisition epoch, which is lastConsolidatedAt, so the next dream      *)
(*   waits for the stale window (index.ts:353-359).                        *)
(* - the index stays within its cap; SkipCap drops the dream/extraction     *)
(*   cap guard (defence in depth: the write-back gate + truncate fallback   *)
(*   also enforce it).                                                     *)
(*                                                                         *)
(* Time is a bounded logical tick; the 1h stale window, the 60m pressure    *)
(* cooldown and the periodic time gate are abstracted to tick counts.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT UnlockedSave, DreamNoCas, DreamIndexFirst, UnlockedExtract,
         ClearWithoutRun, SkipCap, FreeTicks, MaxLines, StaleTicks,
         CooldownTicks, MinTicks, TMax, Revs

ASSUME /\ UnlockedSave \in BOOLEAN
       /\ DreamNoCas \in BOOLEAN
       /\ DreamIndexFirst \in BOOLEAN
       /\ UnlockedExtract \in BOOLEAN
       /\ ClearWithoutRun \in BOOLEAN
       /\ SkipCap \in BOOLEAN
       /\ FreeTicks \in BOOLEAN
       /\ MaxLines \in 1..3
       /\ StaleTicks \in 1..3
       /\ CooldownTicks \in 0..2
       /\ MinTicks \in 0..3
       /\ TMax \in 2..4
       /\ Revs \in 2..4

(* Bounded universes. Every sentinel is a string; epochs and revisions are   *)
(* naturals with 0 as "never" and are only ever compared with naturals.     *)
Procs == {"p1", "p2"}
Names == {"n1", "n2", "n3"}
Ticks == 0..TMax
RevsT == 0..Revs

Kinds  == {"none", "save", "dream", "extract"}
Phases == {"none", "read", "saving", "stamped", "locked", "forked", "built",
           "topics", "indexfirst", "written"}
(* The lock is held from acquisition through the clear/fail.               *)
CriticalPhases == {"locked", "forked", "built", "topics", "indexfirst",
                   "written"}
Bodies == {"none", "body"}
Modes  == {"none", "pressure", "periodic"}

PendType ==
  [ kind:    Kinds
  , mode:    Modes
  , name:    {"none"} \cup Names
  , snap:    SUBSET Names
  , next:    SUBSET Names
  , armed:   Ticks
  , prior:   Ticks
  , snapRev: RevsT
  , phase:   Phases ]

LockType  == [holder: {"none"} \cup Procs, at: Ticks]
StampType == [armedAt: Ticks, lastForcedAt: Ticks]

PendNone ==
  [ kind |-> "none", mode |-> "none", name |-> "none", snap |-> {},
    next |-> {}, armed |-> 0, prior |-> 0, snapRev |-> 0, phase |-> "none" ]

MakePend(k, m, n, sn, nx, ar, pr, ph) ==
  [ kind |-> k, mode |-> m, name |-> n, snap |-> sn, next |-> nx,
    armed |-> ar, prior |-> pr, snapRev |-> 0, phase |-> ph ]

(* Durable state: the index pointer set and its revision, topic-file bodies, *)
(* the lock file, the pressure marker, the newest arm timestamp and the      *)
(* newest arm a dream actually served. savedSince holds names whose pointer  *)
(* a save committed after the current writer's snapshot; that snapshot is    *)
(* where a rewrite would destroy them.                                      *)
VARIABLES idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
          pend, alive, now

vars == <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
          pend, alive, now>>

(* Only a dream is inside a critical section; the save and the extraction    *)
(* writer run unlocked and merely share phase names.                       *)
InCrit(p) == pend[p].kind = "dream" /\ pend[p].phase \in CriticalPhases

SomePend == \E p \in Procs : pend[p].kind # "none"

Present == {n \in Names : topic[n] = "body"}

CapReached(p) ==
  Cardinality(pend[p].snap \cup {pend[p].name}) > MaxLines

AnyCrit == \E p \in Procs : InCrit(p)

Init ==
  /\ idx = {}
  /\ rev = 0
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
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                 savedSince, pend, alive>>

(* ---------------------------------------------------------------- saves *)

(* The save reads the index and validates topic + upserted pointer as one    *)
(* batch (save.ts:200-237). No lock is taken.                               *)
SaveRead(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ \E n \in Names :
       /\ pend' = [pend EXCEPT ![p] = [MakePend("save", "none", n, idx, {}, 0, 0, "read")
                                     EXCEPT !.snapRev = rev]]
       /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                       savedSince, alive, now>>

(* Cap rejection: nothing is written and the forced-dream marker is armed    *)
(* (save.ts:232-238). Arming preserves lastForcedAt. The decision uses the   *)
(* read snapshot, as the validator does.                                    *)
SaveReject(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "read"
  /\ CapReached(p)
  /\ stamp' = [stamp EXCEPT !.armedAt = now]
  /\ lastArmAt' = now
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, lastServedAt, savedSince, alive, now>>

(* Topic file first, then the pointer (save.ts:239).                        *)
SaveTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "read"
  /\ ~CapReached(p)
  /\ topic' = [topic EXCEPT ![pend[p].name] = "body"]
  /\ pend' = [pend EXCEPT ![p].phase = "saving"]
  /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

(* The index write: read-verify-write against the revision the save read.    *)
(* UnlockedSave drops the verification, so a concurrent writer's pointer is  *)
(* overwritten by the stale upsert result.                                  *)
SaveIndex(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "saving"
  /\ rev < Revs
  /\ IF UnlockedSave
       THEN idx' = pend[p].snap \cup {pend[p].name}
       ELSE /\ rev = pend[p].snapRev
            /\ idx' = idx \cup {pend[p].name}
  /\ rev' = rev + 1
  (* Only an ADDED pointer is protected: overwriting a name that is already  *)
  (* indexed changes no pointer, so a later compaction dropping it is not a  *)
  (* lost update.                                                           *)
  /\ savedSince' = IF pend[p].name \in idx
       THEN savedSince
       ELSE savedSince \cup {pend[p].name}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now>>

(* A save whose guard no longer holds abandons the write: the intended       *)
(* protocol retries or drops, it never parks the caller.                   *)
SaveAbort(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase \in {"read", "saving"}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                 savedSince, alive, now>>

(* ---------------------------------------------------- extraction (unlocked *)

(* The extraction fork writes its batch through the same writeMemoryFiles     *)
(* path with NO lock: a third writer racing saves and dreams on the index.   *)
ExtractRead(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ \E nx \in SUBSET Names :
       /\ Cardinality(nx) <= MaxLines \/ SkipCap
       /\ pend' = [pend EXCEPT ![p] = [MakePend("extract", "none", "none", idx, nx, 0, 0, "read")
                                     EXCEPT !.snapRev = rev]]
       (* a snapshot: pointers saved after it are the ones this write must    *)
       (* not destroy, so the protection baseline restarts here, as at a      *)
       (* dream fork.                                                         *)
       /\ savedSince' = {}
       /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                       alive, now>>

ExtractTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase = "read"
  /\ topic' = [n \in Names |-> IF n \in pend[p].next THEN "body" ELSE topic[n]]
  /\ pend' = [pend EXCEPT ![p].phase = "topics"]
  /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

ExtractIndex(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase = "topics"
  /\ rev < Revs
  /\ IF UnlockedExtract
       THEN idx' = pend[p].next
       ELSE /\ rev = pend[p].snapRev
            /\ idx' = pend[p].next
  /\ rev' = rev + 1
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, savedSince, alive,
                 now>>

ExtractAbort(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase \in {"read", "topics"}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                 savedSince, alive, now>>

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
  /\ UNCHANGED <<idx, rev, topic, lock, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

(* Periodic mode: the time gate over the last consolidation epoch, which the *)
(* lock file carries (gates.ts:29-32). The session-count gate is E-7.        *)
DreamStampPeriodic(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ stamp.armedAt = 0
  /\ now >= lock.at + MinTicks
  /\ pend' = [pend EXCEPT ![p] =
       MakePend("dream", "periodic", "none", {}, {}, 0, 0, "stamped")]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                 savedSince, alive, now>>

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
  /\ UNCHANGED <<idx, rev, topic, stamp, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

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
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                 savedSince, alive, now>>

(* The fork reads the index. That snapshot is the baseline: pointers a save  *)
(* commits after it are the ones a rewrite must not destroy.               *)
DreamFork(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "locked"
  /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.snap = idx, !.snapRev = rev,
                                                   !.phase = "forked"]]
  /\ savedSince' = {}
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive,
                 now>>

(* The reported batch decides the next index content: it may keep, merge or  *)
(* drop entries. The cap guard stands unless SkipCap.                       *)
DreamBuild(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "forked"
  /\ \E nx \in SUBSET Names :
       /\ Cardinality(nx) <= MaxLines \/ SkipCap
       /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.next = nx, !.phase = "built"]]
       /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                       savedSince, alive, now>>

DreamWriteTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "built"
  /\ topic' = [n \in Names |-> IF n \in pend[p].next THEN "body" ELSE topic[n]]
  /\ pend' = [pend EXCEPT ![p].phase = "topics"]
  /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

(* Intended order: topics, then the index, verified against the revision at  *)
(* fork time. DreamNoCas drops the verification.                            *)
DreamPublish(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "topics"
  /\ ~DreamNoCas
  /\ rev < Revs
  /\ rev = pend[p].snapRev
  /\ idx' = pend[p].next
  /\ rev' = rev + 1
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, savedSince, alive,
                 now>>

DreamClobber(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "topics"
  /\ DreamNoCas
  /\ rev < Revs
  /\ idx' = pend[p].next
  /\ rev' = rev + 1
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
  /\ rev < Revs
  /\ IF DreamNoCas
       THEN idx' = pend[p].next
       ELSE /\ rev = pend[p].snapRev
            /\ idx' = pend[p].next
  /\ rev' = rev + 1
  /\ pend' = [pend EXCEPT ![p].phase = "indexfirst"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, savedSince, alive,
                 now>>

DreamTopicsAfter(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "indexfirst"
  /\ topic' = [n \in Names |-> IF n \in pend[p].next THEN "body" ELSE topic[n]]
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

(* Completion tombstones the marker, advances the cooldown reference to the  *)
(* clear time, and writes NO lock: the file keeps the holder and the         *)
(* acquisition epoch (lastConsolidatedAt).                                  *)
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
  /\ stamp' = [stamp EXCEPT !.armedAt = 0, !.lastForcedAt = now]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, lastArmAt, savedSince, alive, now>>

(* A failed or killed dream rolls the lock back to the epoch it captured      *)
(* (lock.ts:120-124).                                                        *)
DreamFail(p) ==
  /\ alive[p]
  /\ InCrit(p)
  /\ lock' = [holder |-> "none", at |-> pend[p].prior]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, stamp, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

(* A crash loses in-process state only.                                      *)
Crash(p) ==
  /\ alive[p]
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt,
                 savedSince, now>>

(* ------------------------------------------------------------- safety *)

TypeOK ==
  /\ idx \in SUBSET Names
  /\ rev \in RevsT
  /\ topic \in [Names -> Bodies]
  /\ lock \in LockType
  /\ stamp \in StampType
  /\ lastArmAt \in Ticks
  /\ lastServedAt \in Ticks
  /\ savedSince \in SUBSET Names
  /\ pend \in [Procs -> PendType]
  /\ alive \in [Procs -> BOOLEAN]
  /\ now \in Ticks

(* S-1: a pointer a save committed after a writer's snapshot is still in the *)
(* index after that writer publishes.                                          *)
NoLostSave == savedSince \subseteq idx

(* S-2: the index never points at a topic file that was not written first.  *)
NoDanglingPointer == idx \subseteq Present

(* S-3: the published index stays within its cap.                           *)
CapSound == Cardinality(idx) <= MaxLines

(* S-4: pressure is level-triggered; an arm is never tombstoned unserved.   *)
NoLostPressure == stamp.armedAt > 0 \/ lastServedAt >= lastArmAt

(* S-5: at most one dream in the critical section, and it is the holder.    *)
OneDreamer == \A p, q \in Procs : p # q => ~(InCrit(p) /\ InCrit(q))

HoldsLock == \A p \in Procs : InCrit(p) => lock.holder = p

(* --------------------------------------------------------------- spec *)

(* A bounded-model terminal: every process dead, or the revision budget is   *)
(* spent and nothing is in flight. Without the second arm the exhausted      *)
(* revision budget would show up as a spurious deadlock.                   *)
Idle ==
  /\ \/ \A p \in Procs : ~alive[p]
     \/ (rev = Revs /\ ~SomePend)
  /\ UNCHANGED vars

Next ==
  \/ Tick
  \/ Idle
  \/ \E p \in Procs :
       \/ SaveRead(p)
       \/ SaveReject(p)
       \/ SaveTopics(p)
       \/ SaveIndex(p)
       \/ SaveAbort(p)
       \/ ExtractRead(p)
       \/ ExtractTopics(p)
       \/ ExtractIndex(p)
       \/ ExtractAbort(p)
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
