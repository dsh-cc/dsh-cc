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
(*   (save.ts:239); DreamIndexFirst flips the batch order for the dream AND *)
(*   the extraction (both share the fork-ordered writeMemoryFiles path),   *)
(*   which is what makes a crash leave a dangling pointer. A batch may     *)
(*   also simply omit a topic file (MissingTopic): the write-back gate      *)
(*   (writeback.ts:99-155) never checks that index pointers have topic      *)
(*   files in the batch.                                                    *)
(* - the pressure marker is read and stamped separately by the code        *)
(*   (index.ts:300 reads, :316 stamps with the CAPTURED arm, pressure.ts:   *)
(*   107), so a concurrent re-arm between the two is clobbered. The        *)
(*   convention models the intended atomic step; SplitStamp models the     *)
(*   real split. A successful dream clears the marker in BOTH modes (the   *)
(*   rebuild makes a pending arm obsolete, index.ts:355-359) and serves     *)
(*   the current arm; ClearWithoutRun tombstones without serving.          *)
(* - a successful dream writes NO lock: the file keeps the holder and the   *)
(*   acquisition epoch, which is lastConsolidatedAt, so the next dream      *)
(*   waits for the stale window — including the same process, because      *)
(*   the stale check reads only the epoch (lock.ts:84-87).                  *)
(* - the index stays within its cap; SkipCap drops the batch cap guard     *)
(*   (defence in depth: the write-back gate and the truncate fallback also  *)
(*   enforce the cap).                                                     *)
(*                                                                         *)
(* Protection bookkeeping: savedSince is the single lost-update log — the    *)
(* pointers a save ADDED since the current writer's snapshot; a snapshot    *)
(* resets it (the writer may legally compact anything in its own snapshot). *)
(* Single-set limitation (E-1d in design.md): the log is NOT attributable   *)
(* per writer, so a snapshot-then-abort interleaving can blind the log for  *)
(* older in-flight writers; under the convention the revision guard is the  *)
(* actual protection, and each fault probe still produces its counterexample *)
(* on the shorter trace.                                                    *)
(*                                                                         *)
(* Time is a bounded logical tick; the 1h stale window, the 60m pressure    *)
(* cooldown and the periodic time gate are abstracted to tick counts.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT UnlockedSave, DreamNoCas, DreamIndexFirst, UnlockedExtract,
         ClearWithoutRun, SkipCap, FreeTicks, MaxLines, StaleTicks,
         CooldownTicks, MinTicks, TMax, Revs, SplitStamp, MissingTopic

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
       /\ Revs \in 1..4
       /\ SplitStamp \in BOOLEAN
       /\ MissingTopic \in BOOLEAN

(* Bounded universes. Every sentinel is a string; epochs and revisions are   *)
(* naturals with 0 as "never" and are only ever compared with naturals.     *)
Procs == {"p1", "p2"}
Names == {"n1", "n2", "n3"}
Ticks == 0..TMax
RevsT == 0..Revs

Kinds  == {"none", "save", "dream", "extract"}
Phases == {"none", "read", "saving", "pread", "stamped", "locked", "forked",
           "built", "topics", "indexfirst", "written"}
(* The lock is held from acquisition until the clear; a FAILED dream may    *)
(* roll back only BEFORE it published, so "written" is excluded.           *)
CritPhases == {"locked", "forked", "built", "topics", "indexfirst"}
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
(* newest arm a completed dream served.                                       *)
VARIABLES idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
          pend, alive, now

vars == <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, savedSince,
          pend, alive, now>>

(* Only a dream is inside a critical section; the save and the extraction    *)
(* writer run unlocked and merely share phase names.                       *)
InCrit(p) == pend[p].kind = "dream" /\ pend[p].phase \in CritPhases

SomePend == \E p \in Procs : pend[p].kind # "none"

Present == {n \in Names : topic[n] = "body"}

CapReached(p) ==
  Cardinality(pend[p].snap \cup {pend[p].name}) > MaxLines

AnyCrit == \E p \in Procs : InCrit(p)

(* The topic files a batch actually writes. A consistent batch covers its   *)
(* whole report; a faulty one may omit one file the index still points at. *)
Covers(report) ==
  {cover \in SUBSET report :
     cover = report \/
       (MissingTopic /\ Cardinality(report \ cover) = 1)}

Init ==
  /\ idx = {}
  /\ rev = 0
  /\ topic = [n \in Names |-> "none"]
  /\ lock = [holder |-> "none", at |-> 0]
  /\ stamp = [armedAt |-> 0, lastForcedAt |-> 0]
  /\ savedSince = {}
  /\ lastArmAt = 0
  /\ lastServedAt = 0
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
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, pend, alive, savedSince>>

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
(* (save.ts:232-238). The decision uses the read snapshot.                  *)
SaveReject(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "read"
  /\ CapReached(p)
  /\ stamp' = [stamp EXCEPT !.armedAt = now]
  /\ lastArmAt' = now
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, lastServedAt, alive, now, savedSince>>

(* Topic file first, then the pointer (save.ts:239).                        *)
SaveTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase = "read"
  /\ ~CapReached(p)
  /\ topic' = [topic EXCEPT ![pend[p].name] = "body"]
  /\ pend' = [pend EXCEPT ![p].phase = "saving"]
  /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* The index write: read-verify-write against the revision the save read.    *)
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
  (* lost update. A snapshot resets the log — see the single-set limitation  *)
  (* recorded in design.md (E-1d).                                          *)
  /\ savedSince' = IF pend[p].name \in idx
       THEN savedSince
       ELSE savedSince \cup {pend[p].name}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now>>

(* A save whose guard no longer holds abandons the write.                   *)
SaveAbort(p) ==
  /\ alive[p]
  /\ pend[p].kind = "save"
  /\ pend[p].phase \in {"read", "saving"}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* ---------------------------------------------------- extraction (unlocked *)

(* The extraction fork writes its batch through the same writeMemoryFiles     *)
(* path with NO lock: a third writer racing saves and dreams on the index. *)
ExtractRead(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ \E nx \in SUBSET Names :
       /\ Cardinality(nx) <= MaxLines \/ SkipCap
       /\ pend' = [pend EXCEPT ![p] =
            [MakePend("extract", "none", "none", idx, nx, 0, 0, "read")
              EXCEPT !.snapRev = rev]]
       /\ savedSince' = {}
       /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now>>

ExtractTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase = "read"
  /\ \E cover \in Covers(pend[p].next) :
       /\ topic' = [n \in Names |-> IF n \in cover THEN "body" ELSE topic[n]]
       /\ pend' = [pend EXCEPT ![p].phase = "topics"]
       /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

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
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* DreamIndexFirst also covers the extraction: both writers share the        *)
(* fork-ordered writeMemoryFiles path, so the extraction batch may publish   *)
(* the index before its topic files too.                                   *)
ExtractPublishFirst(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase = "read"
  /\ DreamIndexFirst
  /\ rev < Revs
  /\ IF UnlockedExtract
       THEN idx' = pend[p].next
       ELSE /\ rev = pend[p].snapRev
            /\ idx' = pend[p].next
  /\ rev' = rev + 1
  /\ pend' = [pend EXCEPT ![p].phase = "indexfirst"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

ExtractTopicsAfter(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase = "indexfirst"
  /\ \E cover \in Covers(pend[p].next) :
       /\ topic' = [n \in Names |-> IF n \in cover THEN "body" ELSE topic[n]]
       /\ pend' = [pend EXCEPT ![p].phase = "written"]
       /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

ExtractAbort(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase \in {"read", "topics", "indexfirst"}
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* The extraction writer settles from "written": its protection set was      *)
(* already checked against the published index by the invariant.            *)
ExtractFinish(p) ==
  /\ alive[p]
  /\ pend[p].kind = "extract"
  /\ pend[p].phase = "written"
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* --------------------------------------------------------------- dreams *)

(* Pressure mode, intended protocol: the read and the stamp are one step.    *)
DreamPressureAtomic(p) ==
  /\ ~SplitStamp
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ stamp.armedAt > 0
  /\ now >= stamp.lastForcedAt + CooldownTicks
  /\ stamp' = [stamp EXCEPT !.lastForcedAt = now]
  /\ pend' = [pend EXCEPT ![p] =
       MakePend("dream", "pressure", "none", {}, {}, stamp.armedAt, 0, "stamped")]
  /\ UNCHANGED <<idx, rev, topic, lock, lastArmAt, lastServedAt, savedSince,
                 alive, now>>

(* Pressure mode under SplitStamp (the real code shape): the dream reads the *)
(* marker and captures the arm in one step, then stamps in another.          *)
DreamReadPressure(p) ==
  /\ SplitStamp
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ stamp.armedAt > 0
  /\ now >= stamp.lastForcedAt + CooldownTicks
  /\ pend' = [pend EXCEPT ![p] =
       MakePend("dream", "pressure", "none", {}, {}, stamp.armedAt, 0, "pread")]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* The stamp write (index.ts:316). The intended protocol stamps atomically   *)
(* with the read; SplitStamp models the real code shape — the write carries *)
(* the CAPTURED arm (pressure.ts:107), so a concurrent re-arm between the   *)
(* read and the stamp is clobbered.                                        *)
DreamStampPressure(p) ==
  /\ SplitStamp
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].mode = "pressure"
  /\ pend[p].phase = "pread"
  /\ IF SplitStamp
       THEN stamp' = [stamp EXCEPT !.armedAt = pend[p].armed,
                                   !.lastForcedAt = now]
       ELSE stamp' = [stamp EXCEPT !.lastForcedAt = now]
  /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.phase = "stamped"]]
  /\ UNCHANGED <<idx, rev, topic, lock, lastArmAt, lastServedAt, alive, now, savedSince>>

(* Periodic mode: the time gate over the last consolidation epoch, which the *)
(* lock file carries. gates.ts:29-32 opens the gate immediately on a zero    *)
(* epoch; the model conservatively delays the very first periodic dream by   *)
(* one tick (a declared conservative deviation, E-1e).                       *)
DreamStampPeriodic(p) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ stamp.armedAt = 0
  /\ now >= lock.at + MinTicks
  /\ pend' = [pend EXCEPT ![p] =
       MakePend("dream", "periodic", "none", {}, {}, 0, 0, "stamped")]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* Reclaim is allowed when the lock is free or its stamp passed the stale    *)
(* window (lock.ts:84-87 reads only the epoch — the holder's identity,      *)
(* including the same process, does not matter).                           *)
DreamLock(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "stamped"
  /\ \/ lock.holder = "none"
     \/ now >= lock.at + StaleTicks
  /\ lock' = [holder |-> p, at |-> now]
  /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.prior = lock.at, !.phase = "locked"]]
  /\ UNCHANGED <<idx, rev, topic, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

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
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* The fork reads the index. Its snapshot displaces the lost-update log;     *)
(* an abort restores it.                                                    *)
DreamFork(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "locked"
  /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.snap = idx, !.snapRev = rev,
                                                   !.phase = "forked"]]
  /\ savedSince' = {}
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now>>

(* The reported batch decides the next index content: it may keep, merge or  *)
(* drop entries. The cap guard stands unless SkipCap.                       *)
DreamBuild(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "forked"
  /\ \E nx \in SUBSET Names :
       /\ Cardinality(nx) <= MaxLines \/ SkipCap
       /\ pend' = [pend EXCEPT ![p] = [pend[p] EXCEPT !.next = nx, !.phase = "built"]]
       /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

DreamWriteTopics(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "built"
  /\ \E cover \in Covers(pend[p].next) :
       /\ topic' = [n \in Names |-> IF n \in cover THEN "body" ELSE topic[n]]
       /\ pend' = [pend EXCEPT ![p].phase = "topics"]
       /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

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
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

DreamClobber(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "topics"
  /\ DreamNoCas
  /\ rev < Revs
  /\ idx' = pend[p].next
  /\ rev' = rev + 1
  /\ pend' = [pend EXCEPT ![p].phase = "written"]
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

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
  /\ UNCHANGED <<topic, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

DreamTopicsAfter(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "indexfirst"
  /\ \E cover \in Covers(pend[p].next) :
       /\ topic' = [n \in Names |-> IF n \in cover THEN "body" ELSE topic[n]]
       /\ pend' = [pend EXCEPT ![p].phase = "written"]
       /\ UNCHANGED <<idx, rev, lock, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* Completion clears the marker in BOTH modes (a successful rebuild makes a  *)
(* pending arm obsolete, index.ts:355-359) and serves the current arm:      *)
(* the cooldown reference advances to the clear time (pressure.ts:117-122). *)
(* ClearWithoutRun tombstones WITHOUT serving — the model-visible "queued"   *)
(* sentence is then a lie.                                                  *)
DreamClear(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase = "written"
  /\ IF ClearWithoutRun
       THEN UNCHANGED lastServedAt
       ELSE lastServedAt' = IF stamp.armedAt > lastServedAt
                             THEN stamp.armedAt
                             ELSE lastServedAt
  /\ stamp' = [stamp EXCEPT !.armedAt = 0, !.lastForcedAt = now]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, lastArmAt, alive, now, savedSince>>

(* A failed or killed dream rolls the lock back to the epoch it captured      *)
(* (lock.ts:120-124) — only BEFORE it published: a completed dream never     *)
(* touches the lock. The abort also restores the lost-update log the fork    *)
(* displaced.                                                                *)
DreamFail(p) ==
  /\ alive[p]
  /\ pend[p].kind = "dream"
  /\ pend[p].phase \in CritPhases
  /\ lock' = [holder |-> "none", at |-> pend[p].prior]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, stamp, lastArmAt, lastServedAt, alive, now, savedSince>>

(* A crash loses in-process state only.                                      *)
Crash(p) ==
  /\ alive[p]
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<idx, rev, topic, lock, stamp, lastArmAt, lastServedAt, now, savedSince>>

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

(* Terminal: every process dead, or the revision budget spent and nothing    *)
(* in flight.                                                               *)
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
       \/ ExtractPublishFirst(p)
       \/ ExtractTopicsAfter(p)
       \/ ExtractFinish(p)
       \/ ExtractAbort(p)
       \/ DreamPressureAtomic(p)
       \/ DreamReadPressure(p)
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
