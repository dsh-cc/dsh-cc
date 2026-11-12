---- MODULE Model ----
(***************************************************************************)
(* Compaction governed-message pinning (input-governance doc 2).           *)
(* Behavioral source:                                                      *)
(* docs/plans/2026-11-12-compaction-governed-pinning.md --                 *)
(* capture/detect/restore with the end-error belt and the                  *)
(* conservative no-end rule (b).                                          *)
(* Code anchors: code-anchors.md (engine commit ordering, failure          *)
(* path, pressure trigger, user/message payload shape).                    *)
(*                                                                       *)
(* Scope: the pinning plugin's observable contract against the compaction *)
(* engine's three failure windows:                                        *)
(*   F1: checkpoint append fails -> end(error) appended -> belt cancels;  *)
(*   F2: checkpoint committed, end append fails -> no end at all;          *)
(*   F3: checkpoint append fails AND end(error) append fails ->            *)
(*       summary logged, nothing else.                                    *)
(* Rule (a): a successful end makes the schedule restorable in the same  *)
(* drain. Rule (b): a schedule with no end of any kind becomes            *)
(* restorable after one turn -- with RequireCheckpoint=TRUE additionally  *)
(* gated on the compaction actually having committed a checkpoint (the   *)
(* fixed design; the original draft rule is the FALSE probe).             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS RequireCheckpoint,   (* TRUE: rule (b) also requires a committed *)
                                 (* checkpoint for that compaction id      *)
          RestoreEnabled,      (* FALSE: the drain appends no restores     *)
          BeltEnabled,         (* FALSE: end(error) does not cancel a       *)
                                 (* schedule                               *)
          MaxPinned            (* capture ring capacity                   *)

MaxPins == 2
Pins == {"p1", "p2"}
MaxNoise == 1
MaxSurface == 5
CIDs == 1..2
MaxTicks == 5
Ticks == 0..MaxTicks

NoPin == "np"
NoCid == 0

PinNode(p) == [k |-> "pin", p |-> p, c |-> NoCid]
NoiseNode == [k |-> "noise", p |-> NoPin, c |-> NoCid]
CheckpointNode(c) == [k |-> "checkpoint", p |-> NoPin, c |-> c]
RestoreNode(p, c) == [k |-> "restore", p |-> p, c |-> c]

(* Engine transaction phase. Other actions are blocked while a           *)
(* compaction transaction is in flight: the engine call is synchronous.  *)
Phases == {"idle", "logged", "committed", "failed"}

VARIABLES surface,     (* sequence of nodes, positions are surface seqs   *)
          ring,        (* captured pin ids (bounded by MaxPinned)        *)
          cPhase,      (* engine transaction phase                       *)
          curCid,      (* in-flight compaction id                        *)
          nextCid,     (* id allocator                                  *)
          cStart,      (* in-flight span start (surface position)       *)
          cEnd,        (* in-flight span end (surface position)         *)
          cShadow,     (* pins carried by nodes in the in-flight span   *)
          schedules,   (* set of [cid, rs, at]: pending restores         *)
          endOk,       (* cids with a successful compaction/end          *)
          endErr,      (* cids with an error compaction/end              *)
          committed,   (* cids that appended a checkpoint node           *)
          shadowedLog, (* function CIDs -> pins shadowed by that cid   *)
          promised,    (* pins owed a restore (shadowed while captured)  *)
          lastShadow,  (* function Pins -> tick of last shadowing       *)
          tickCount,   (* drain/tick clock                              *)
          faults       (* bookkeeping: which fault arms fired           *)

vars == <<surface, ring, cPhase, curCid, nextCid, cStart, cEnd, cShadow,
          schedules, endOk, endErr, committed, shadowedLog, promised,
          lastShadow, tickCount, faults>>

TypeOK ==
  /\ IsFiniteSet(schedules)
  /\ \A s \in schedules :
       s.cid \in CIDs /\ s.rs \subseteq Pins /\ s.at \in Ticks
  /\ ring \subseteq Pins
  /\ cPhase \in Phases
  /\ curCid \in CIDs \cup {NoCid}
  /\ nextCid \in 1..3
  /\ cStart \in 1..MaxSurface
  /\ cEnd \in 0..MaxSurface
  /\ cShadow \subseteq Pins
  /\ endOk \subseteq CIDs
  /\ endErr \subseteq CIDs
  /\ committed \subseteq CIDs
  /\ shadowedLog \in [CIDs -> SUBSET Pins]
  /\ promised \subseteq Pins
  /\ lastShadow \in [Pins -> Ticks]
  /\ tickCount \in Ticks
  /\ faults \subseteq {"fail-commit", "fail-end"}
  (* Arrivals are guarded to MaxSurface; one drain can append at most    *)
  (* |Pins| = 2 restore nodes (concurrent eligible schedules carry      *)
  (* disjoint pin sets), so the envelope admits MaxSurface + 2.          *)
  /\ Len(surface) \in 0..MaxSurface + 2
  /\ \A i \in DOMAIN surface :
       /\ surface[i].k \in {"pin", "noise", "checkpoint", "restore"}
       /\ surface[i].p \in Pins \cup {NoPin}
       /\ surface[i].c \in CIDs \cup {NoCid}

Init ==
  /\ surface = <<>>
  /\ ring = {}
  /\ cPhase = "idle"
  /\ curCid = NoCid
  /\ nextCid = 1
  /\ cStart = 1
  /\ cEnd = 0
  /\ cShadow = {}
  /\ schedules = {}
  /\ endOk = {}
  /\ endErr = {}
  /\ committed = {}
  /\ shadowedLog = [c \in CIDs |-> {}]
  /\ promised = {}
  /\ lastShadow = [p \in Pins |-> 0]
  /\ tickCount = 0
  /\ faults = {}

(* ---- helpers ------------------------------------------------------- *)

ReplaceSpan(s, i, j, n) ==
  (IF i = 1 THEN <<>> ELSE SubSeq(s, 1, i - 1))
    \o <<n>>
    \o (IF j = Len(s) THEN <<>> ELSE SubSeq(s, j + 1, Len(s)))

PinsIn(s, i, j) ==
  {p \in Pins : \E k \in i..j : s[k].p = p}

LivePins == {p \in Pins : \E i \in DOMAIN surface : surface[i].p = p}

NodeCount(k) == Cardinality({i \in DOMAIN surface : surface[i].k = k})

(* A schedule is restorable when rule (a) or the guarded rule (b) fires. *)
(* BeltEnabled=FALSE disables BOTH the end-error cancellation and the     *)
(* endErr exclusion inside rule (b) -- the as-drafted design had only    *)
(* the belt standing between an error-ended compaction and a phantom.   *)
Eligible(s) ==
  /\ (BeltEnabled => s.cid \notin endErr)
  /\ ( s.cid \in endOk
       \/ ( /\ tickCount - s.at >= 1
            /\ ~RequireCheckpoint \/ s.cid \in committed ) )

(* Dead schedules (belt-off or no-checkpoint worlds) are GC'd after     *)
(* aging past the rule-(b) window without becoming eligible.             *)
Dead(s) == ~Eligible(s) /\ tickCount - s.at >= 2

(* Deterministic drain order: cid ascending, then p1 before p2.         *)
RestoresOf(s) ==
  IF "p1" \in s.rs THEN
    (IF "p2" \in s.rs
       THEN <<RestoreNode("p1", s.cid), RestoreNode("p2", s.cid)>>
       ELSE <<RestoreNode("p1", s.cid)>>)
  ELSE (IF "p2" \in s.rs
          THEN <<RestoreNode("p2", s.cid)>>
          ELSE <<>>)

SchedOf(c) == CHOOSE s \in schedules : s.cid = c

RestoresAll ==
  (IF \E s \in schedules : s.cid = 1 /\ Eligible(s)
     THEN RestoresOf(SchedOf(1)) ELSE <<>>)
    \o (IF \E s \in schedules : s.cid = 2 /\ Eligible(s)
     THEN RestoresOf(SchedOf(2)) ELSE <<>>)


EligibleSet == {s \in schedules : Eligible(s)}

(* ---- producer arrivals ---------------------------------------------- *)

AppendNode(n) == surface' = Append(surface, n)

ArrivePin(p) ==
  /\ cPhase = "idle"
  /\ p \notin LivePins
  /\ p \notin promised
  /\ Len(surface) < MaxSurface
  /\ AppendNode(PinNode(p))
  /\ (* ring admission with capacity; an over-capacity admission evicts  *)
     (* all other captured pins (arbitrary-eviction abstraction of FIFO) *)
     ring' = (IF Cardinality(ring) < MaxPinned
                THEN ring \cup {p}
                ELSE {p})
  /\ UNCHANGED <<cPhase, curCid, nextCid, cStart, cEnd, cShadow,
                 schedules, endOk, endErr, committed, shadowedLog,
                 promised, lastShadow, tickCount, faults>>

ArriveNoise ==
  /\ cPhase = "idle"
  /\ NodeCount("noise") < MaxNoise
  /\ Len(surface) < MaxSurface
  /\ AppendNode(NoiseNode)
  /\ UNCHANGED <<ring, cPhase, curCid, nextCid, cStart, cEnd, cShadow,
                 schedules, endOk, endErr, committed, shadowedLog,
                 promised, lastShadow, tickCount, faults>>

(* ---- compaction engine transaction ---------------------------------- *)

StartCompaction ==
  /\ cPhase = "idle"
  /\ Len(surface) >= 1
  /\ nextCid \in CIDs
  /\ \E i, j \in 1..Len(surface) :
       /\ i <= j
       /\ cStart' = i
       /\ cEnd' = j
  /\ curCid' = nextCid
  /\ nextCid' = nextCid + 1
  /\ cPhase' = "logged"
  /\ cShadow' = PinsIn(surface, cStart', cEnd')
  /\ schedules' = schedules \union
       {[cid |-> nextCid, rs |-> (cShadow' \intersect ring), at |-> tickCount]}
  /\ UNCHANGED <<surface, ring, endOk, endErr, committed, shadowedLog,
                 promised, lastShadow, tickCount, faults>>

(* F2/F3 arm chooser: the checkpoint replace either commits or fails.   *)
CommitCheckpoint ==
  /\ cPhase = "logged"
  /\ surface' = ReplaceSpan(surface, cStart, cEnd, CheckpointNode(curCid))
  /\ cPhase' = "committed"
  /\ committed' = committed \union {curCid}
  /\ shadowedLog' = [shadowedLog EXCEPT ![curCid] = cShadow]
  /\ promised' = promised \union (cShadow \intersect ring)
  /\ lastShadow' = [q \in Pins |-> IF q \in (cShadow \intersect ring)
                                       THEN tickCount
                                       ELSE lastShadow[q]]
  /\ UNCHANGED <<ring, curCid, nextCid, cStart, cEnd, cShadow, schedules,
                 endOk, endErr, tickCount, faults>>

(* F1/F3 arm: the checkpoint append fails; the span is NOT replaced.    *)
FailBeforeCommit ==
  /\ cPhase = "logged"
  /\ cPhase' = "failed"
  /\ faults' = faults \union {"fail-commit"}
  /\ UNCHANGED <<surface, ring, curCid, nextCid, cStart, cEnd, cShadow,
                 schedules, endOk, endErr, committed, shadowedLog,
                 promised, lastShadow, tickCount>>

(* The end append either succeeds or fails; the F3 world is the         *)
(* compound failure (fail-commit then fail-end).                        *)
AppendEndOk ==
  /\ cPhase = "committed"
  /\ endOk' = endOk \union {curCid}
  /\ cPhase' = "idle"
  /\ UNCHANGED <<surface, ring, curCid, nextCid, cStart, cEnd, cShadow,
                 schedules, endErr, committed, shadowedLog, promised,
                 lastShadow, tickCount, faults>>

AppendEndError ==
  /\ cPhase = "failed"
  /\ endErr' = endErr \union {curCid}
  /\ schedules' = IF BeltEnabled
                     THEN {s \in schedules : s.cid # curCid}
                     ELSE schedules
  /\ cPhase' = "idle"
  /\ UNCHANGED <<surface, ring, curCid, nextCid, cStart, cEnd, cShadow,
                 endOk, committed, shadowedLog, promised, lastShadow,
                 tickCount, faults>>

AppendEndFails ==
  /\ cPhase \in {"committed", "failed"}
  /\ cPhase' = "idle"
  /\ faults' = faults \union {"fail-end"}
  /\ UNCHANGED <<surface, ring, curCid, nextCid, cStart, cEnd, cShadow,
                 schedules, endOk, endErr, committed, shadowedLog,
                 promised, lastShadow, tickCount>>

(* ---- drain (end of a pre-step tick) ---------------------------------- *)

Tick ==
  /\ cPhase = "idle"
  /\ tickCount < MaxTicks
  /\ (IF RestoreEnabled
       THEN ( /\ surface' = surface \o RestoresAll
              /\ promised' = promised \ (UNION {s.rs : s \in EligibleSet})
              /\ schedules' = {s \in schedules : ~Eligible(s) /\ ~Dead(s)} )
       ELSE UNCHANGED <<surface, promised, schedules>>)
  /\ tickCount' = tickCount + 1
  /\ UNCHANGED <<cPhase, ring, curCid, nextCid, cStart, cEnd, cShadow,
                 endOk, endErr, committed, shadowedLog, lastShadow,
                 faults>>

(* Terminal states (ticks exhausted, nothing arrivable) self-loop:       *)
(* named stuttering so TLC's deadlock check sees a successor.             *)
Idle == UNCHANGED vars

Next ==
  \/ \E p \in Pins : ArrivePin(p)
  \/ ArriveNoise
  \/ StartCompaction
  \/ CommitCheckpoint
  \/ FailBeforeCommit
  \/ AppendEndOk
  \/ AppendEndError
  \/ AppendEndFails
  \/ Tick
  \/ Idle

Spec == Init /\ [][Next]_vars

(* ---- invariants ------------------------------------------------------ *)

(* No phantom restore: every restore node on the surface corresponds to  *)
(* a pin actually shadowed by a checkpoint that really committed.        *)
NoPhantom ==
  \A i \in DOMAIN surface :
    surface[i].k = "restore" =>
      /\ surface[i].c \in committed
      /\ surface[i].p \in shadowedLog[surface[i].c]

(* At most one live copy per pin id (producer re-arrival while live is  *)
(* excluded by an arrival guard; only a phantom restore can break this). *)
AtMostOneLivePerPin ==
  \A p \in Pins :
    Cardinality({i \in DOMAIN surface : surface[i].p = p}) <= 1

(* Every promised pin is restored (or still pending) within one drain    *)
(* after the shadowing tick: the no-loss bound with a one-tick budget    *)
(* for the rule-(b) window.                                             *)
NoStalePromise ==
  \A p \in promised : tickCount - lastShadow[p] <= 1

(* Every schedule is either waiting on its own turn or already serviced; *)
(* a serviced schedule never survives (drain removes exactly the         *)
(* eligible set, GC removes the dead).                                   *)
ScheduleAccounting ==
  \A s \in schedules : ~Eligible(s) => tickCount - s.at <= 2

=============================================================================
