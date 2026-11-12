---- MODULE Model ----
(***************************************************************************)
(* Input admission governance (input-governance docs 1+7).                *)
(* Behavioral source:                                                      *)
(* docs/plans/2026-11-12-per-step-input-budget-governor.md and             *)
(* docs/plans/2026-11-12-injection-dedupe-notice-governance.md.           *)
(*                                                                       *)
(* Scope: one gate invocation over an enter batch. Order:                 *)
(*   1. walk the defer backlog FIFO, aging (TTL) and dropping oversize;    *)
(*      admit into own-class budgets, threading provisional dedupe/cap;    *)
(*   2. walk the fresh batch NEWEST-FIRST so that budget exhaustion        *)
(*      defers the OLDEST messages (doc 1: "FIFO-oldest trim"), with the   *)
(*      backlog's byte usage as the starting point;                       *)
(*   3. commit dedupe/cap state only for messages actually admitted.      *)
(* Unknown kinds are passthrough (never trimmed, never deferred).          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS CommitAtCheck,      (* probe: dedupe/cap state advances at     *)
                                 (* check time, not admission              *)
          UnknownAsAdvisory,  (* probe: unknown kinds classified          *)
                                 (* advisory (the r1 inversion)           *)
          ObserveMutates,     (* probe: observe mode writes the real      *)
                                 (* pipeline outcome                       *)
          Enforce             (* FALSE = observe mode                     *)

MaxSeq == 4
AB == 3                      (* advisory budget: two 2-byte advisories   *)
                             (* cannot both fit, so defer is reachable   *)
MB == 3                      (* memory budget                            *)
EB == 8                      (* enter budget (hardOver flag only)        *)
W == 3                       (* dedupe window (gate invocations)         *)
TTL == 2                     (* defer age limit (gate invocations)       *)
CapAdvisor == 1              (* per-kind cap for the advisor kind        *)

mG == [id |-> 1, kind |-> "turn-rules", bytes |-> 2, key |-> "none"]
mT == [id |-> 2, kind |-> "user",       bytes |-> 2, key |-> "none"]
mM == [id |-> 3, kind |-> "memory",     bytes |-> 3, key |-> "none"]
mA == [id |-> 4, kind |-> "advisor",    bytes |-> 2, key |-> "k1"]
mB == [id |-> 5, kind |-> "advisor",    bytes |-> 6, key |-> "k1"]
mC == [id |-> 6, kind |-> "retry-attendant", bytes |-> 2, key |-> "k2"]
mU == [id |-> 7, kind |-> "unknown",    bytes |-> 2, key |-> "none"]

MS == {mG, mT, mM, mA, mB, mC, mU}

ClassOf(m) ==
  CASE m = mU -> IF UnknownAsAdvisory THEN "advisory" ELSE "passthrough"
    [] m = mG -> "governance"
    [] m = mT -> "task"
    [] m = mM -> "memory"
    [] OTHER  -> "advisory"

IsAdvisory(m) == ClassOf(m) = "advisory"
IsMemory(m) == ClassOf(m) = "memory"
IsBudgeted(m) == IsAdvisory(m) \/ IsMemory(m)
ClassBudget(m) == IF IsAdvisory(m) THEN AB ELSE MB
ProtectedKind(m) == m \in {mG, mT, mU}

VARIABLES gateSeq,        (* monotonic gate invocation counter           *)
          batch,          (* pending producer arrivals                   *)
          queue,          (* deferred entries [eid, msg, enqueuedAt]     *)
          admittedEver,   (* a k1 message has been admitted at least once *)
          dedupeState,    (* plugin: k1 -> gateSeq of last committed admit *)
          capCount,       (* plugin: committed advisor admissions        *)
          truthAdmSeq,    (* oracle: k1 -> last true admission gateSeq   *)
          truthCapCount,  (* oracle: true advisor admissions             *)
          truthAdmittedEver, (* oracle: k1 ever truly admitted           *)
          admEids,        (* entry ids ever admitted from the backlog    *)
          droppedEids,    (* entry ids ever dropped from the backlog     *)
          admCount,       (* eid -> times admitted (exactly-once check)  *)
          nextEid,
          lastAdmittedCount, lastAdvisoryBytes, lastMemoryBytes,
          lastHardOver,
          touched         (* a protected/unknown message was deferred or *)
                          (* dropped: violation marker                   *)

vars == <<gateSeq, batch, queue, admittedEver, dedupeState, capCount,
          truthAdmSeq, truthCapCount, truthAdmittedEver, admEids,
          droppedEids, admCount, nextEid, lastAdmittedCount,
          lastAdvisoryBytes, lastMemoryBytes, lastHardOver, touched>>

TypeOK ==
  /\ gateSeq \in 0..MaxSeq
  /\ \A i \in DOMAIN batch : batch[i] \in MS
  /\ Len(batch) \in 0..2
  /\ \A i \in DOMAIN queue :
       /\ queue[i].eid \in 1..10
       /\ queue[i].msg \in MS
       /\ queue[i].enqueuedAt \in 0..MaxSeq
  /\ Len(queue) \in 0..4
  /\ admittedEver \in BOOLEAN
  /\ dedupeState \in 0..MaxSeq
  /\ capCount \in 0..12
  /\ truthAdmSeq \in 0..MaxSeq
  /\ truthCapCount \in 0..12
  /\ truthAdmittedEver \in BOOLEAN
  /\ admEids \subseteq 1..10
  /\ droppedEids \subseteq 1..10
  /\ admCount \in [1..10 -> 0..2]
  /\ nextEid \in 1..11
  /\ lastAdmittedCount \in 0..6
  /\ lastAdvisoryBytes \in 0..18
  /\ lastMemoryBytes \in 0..18
  /\ lastHardOver \in BOOLEAN
  /\ touched \in BOOLEAN

Init ==
  /\ gateSeq = 0
  /\ batch = <<>>
  /\ queue = <<>>
  /\ admittedEver = FALSE
  /\ dedupeState = 0
  /\ capCount = 0
  /\ truthAdmSeq = 0
  /\ truthCapCount = 0
  /\ truthAdmittedEver = FALSE
  /\ admEids = {}
  /\ droppedEids = {}
  /\ admCount = [i \in 1..10 |-> 0]
  /\ nextEid = 1
  /\ lastAdmittedCount = 0
  /\ lastAdvisoryBytes = 0
  /\ lastMemoryBytes = 0
  /\ lastHardOver = FALSE
  /\ touched = FALSE

(* ---- helpers ----------------------------------------------------------- *)

RECURSIVE SumB(_)
SumB(s) == IF s = << >> THEN 0 ELSE Head(s).bytes + SumB(Tail(s))

Range(s) == {s[i] : i \in DOMAIN s}
Eids(s) == {s[i].eid : i \in DOMAIN s}

RECURSIVE MsgsOf(_)
MsgsOf(s) == IF s = << >> THEN << >> ELSE <<Head(s).msg>> \o MsgsOf(Tail(s))

RECURSIVE SumAdvBytes(_)
SumAdvBytes(s) ==
  IF s = << >> THEN 0
  ELSE (IF IsAdvisory(Head(s)) THEN Head(s).bytes ELSE 0) + SumAdvBytes(Tail(s))

RECURSIVE SumMemBytes(_)
SumMemBytes(s) ==
  IF s = << >> THEN 0
  ELSE (IF IsMemory(Head(s)) THEN Head(s).bytes ELSE 0) + SumMemBytes(Tail(s))

(* Reverse of a sequence (used to walk the fresh batch newest-first).     *)
RECURSIVE Rev(_)
Rev(s) == IF s = << >> THEN << >> ELSE Rev(Tail(s)) \o <<Head(s)>>

BumpCounts(map, ids, n) ==
  [i \in 1..10 |-> map[i] + IF i \in ids THEN n ELSE 0]

(* ---- eligibility ------------------------------------------------------- *)

(* A key that was never admitted is admitted unconditionally; once        *)
(* admitted, the window rule applies (strict comparison: gap < W          *)
(* suppresses, gap = W admits).                                          *)
DedupeEligible(m) ==
  \/ ~IsAdvisory(m)
  \/ m.key = "none"
  \/ ~admittedEver
  \/ gateSeq + 1 - dedupeState >= W

CapEligible(m) == m.kind # "advisor" \/ capCount < CapAdvisor

ProvisionalDedupeEligible(m, prov) ==
  \/ ~IsAdvisory(m)
  \/ m.key = "none"
  \/ ~prov.ever
  \/ gateSeq + 1 - (IF prov.k1 THEN gateSeq + 1 ELSE dedupeState) >= W

ProvisionalCapEligible(m, prov) ==
  m.kind # "advisor" \/ capCount + prov.adv < CapAdvisor

(* ---- backlog walk (FIFO, own-class budgets) --------------------------- *)

RECURSIVE WalkBacklog(_, _, _)
WalkBacklog(rest, acc, prov) ==
  IF rest = << >> THEN acc
  ELSE LET e == Head(rest) IN
    IF gateSeq + 1 - e.enqueuedAt > TTL
    THEN WalkBacklog(Tail(rest), [acc EXCEPT !.drop = Append(@, e)], prov)
    ELSE IF e.msg.bytes > ClassBudget(e.msg)
    THEN WalkBacklog(Tail(rest), [acc EXCEPT !.drop = Append(@, e)], prov)
    ELSE IF /\ IsAdvisory(e.msg)
            /\ acc.adv + e.msg.bytes <= AB
            /\ ProvisionalDedupeEligible(e.msg, prov)
            /\ ProvisionalCapEligible(e.msg, prov)
    THEN WalkBacklog(Tail(rest),
          [acc EXCEPT !.adm = Append(@, e),
                   !.adv = @ + e.msg.bytes,
                   !.advCount = @ + IF e.msg.kind = "advisor" THEN 1 ELSE 0],
          [prov EXCEPT !.k1 = @ \/ e.msg.key = "k1",
                   !.adv = @ + IF e.msg.kind = "advisor" THEN 1 ELSE 0,
                   !.ever = @ \/ e.msg.key = "k1"])
    ELSE IF /\ IsMemory(e.msg)
            /\ acc.mem + e.msg.bytes <= MB
    THEN WalkBacklog(Tail(rest),
          [acc EXCEPT !.adm = Append(@, e),
                   !.mem = @ + e.msg.bytes], prov)
    ELSE WalkBacklog(Tail(rest), [acc EXCEPT !.keep = Append(@, e)], prov)

BacklogAcc == [adm |-> << >>, keep |-> << >>, drop |-> << >>,
                adv |-> 0, mem |-> 0, advCount |-> 0]

(* ---- fresh walk (NEWEST first, so exhaustion defers the OLDEST) -------- *)
(* facc fields mirror the backlog accumulator plus the deferred list;     *)
(* byte accounting starts at the backlog's usage so a fresh message can   *)
(* never overshoot a class budget that the backlog already consumed.      *)

RECURSIVE WalkFresh(_, _, _)
WalkFresh(rest, facc, prov) ==
  IF rest = << >> THEN facc
  ELSE LET m == Head(rest) IN
    IF ~ProvisionalDedupeEligible(m, prov)
    THEN (* dedupe suppression: dropped, not deferred *)
         WalkFresh(Tail(rest),
           [facc EXCEPT !.dropNum = @ + 1,
                    !.checkK1 = @ \/ m.key = "k1",
                    !.checkAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0],
           prov)
    ELSE IF ~ProvisionalCapEligible(m, prov)
    THEN (* cap overflow routes to governor trim (doc 7), i.e. defer *)
         WalkFresh(Tail(rest),
           [facc EXCEPT !.defer = Append(@, m),
                    !.checkK1 = @ \/ m.key = "k1",
                    !.checkAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0],
           prov)
    ELSE IF m.bytes > ClassBudget(m)
    THEN WalkFresh(Tail(rest),
           [facc EXCEPT !.dropNum = @ + 1,
                    !.checkK1 = @ \/ m.key = "k1",
                    !.checkAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0],
           prov)
    ELSE IF /\ IsAdvisory(m) /\ facc.adv + m.bytes > AB
    THEN WalkFresh(Tail(rest),
           [facc EXCEPT !.defer = Append(@, m),
                    !.checkK1 = @ \/ m.key = "k1",
                    !.checkAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0],
           prov)
    ELSE IF /\ IsMemory(m) /\ facc.mem + m.bytes > MB
    THEN WalkFresh(Tail(rest),
           [facc EXCEPT !.defer = Append(@, m),
                    !.checkK1 = @ \/ m.key = "k1",
                    !.checkAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0],
           prov)
    ELSE WalkFresh(Tail(rest),
           [facc EXCEPT !.adm = Append(@, m),
                    !.admK1 = @ \/ m.key = "k1",
                    !.checkK1 = @ \/ m.key = "k1",
                    !.admAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0,
                    !.checkAdv = @ + IF m.kind = "advisor" THEN 1 ELSE 0,
                    !.adv = @ + IF IsAdvisory(m) THEN m.bytes ELSE 0,
                    !.mem = @ + IF IsMemory(m) THEN m.bytes ELSE 0],
           [prov EXCEPT !.k1 = @ \/ m.key = "k1",
                    !.adv = @ + IF m.kind = "advisor" THEN 1 ELSE 0,
                    !.ever = @ \/ m.key = "k1"])

FreshAcc(back) == [adm |-> << >>, defer |-> << >>, dropNum |-> 0,
                   checkK1 |-> FALSE, admK1 |-> FALSE,
                   checkAdv |-> 0, admAdv |-> 0,
                   adv |-> back.adv, mem |-> back.mem]

BacklogHasK1(back) == \E i \in DOMAIN back.adm : back.adm[i].msg.key = "k1"

FreshProv(back) == [k1 |-> FALSE, adv |-> back.advCount,
                    ever |-> (admittedEver \/ BacklogHasK1(back))]
BacklogProv == [k1 |-> FALSE, adv |-> 0, ever |-> admittedEver]

(* Deferred entries for this gate's trimmed fresh messages.               *)
RECURSIVE DefEntries(_, _, _)
DefEntries(s, eid, n) ==
  IF s = << >> THEN << >>
  ELSE << [eid |-> eid, msg |-> Head(s), enqueuedAt |-> n] >>
         \o DefEntries(Tail(s), eid + 1, n)

(* ---- actions ------------------------------------------------------------ *)

Produce(m) ==
  /\ Len(batch) < 2
  /\ batch' = batch \o <<m>>
  /\ UNCHANGED <<gateSeq, queue, admittedEver, dedupeState, capCount,
                 truthAdmSeq, truthCapCount, truthAdmittedEver, admEids,
                 droppedEids, admCount, nextEid, lastAdmittedCount,
                 lastAdvisoryBytes, lastMemoryBytes, lastHardOver, touched>>

Gate ==
  /\ batch # << >>
  /\ gateSeq < MaxSeq
  /\ LET n == gateSeq + 1
         back == WalkBacklog(queue, BacklogAcc, BacklogProv)
         (* fresh walk newest-first; results are emitted in arrival order *)
         faccRev == WalkFresh(Rev(batch), FreshAcc(back), FreshProv(back))
         faccAdm == Rev(faccRev.adm)
         backAdmMsgs == MsgsOf(back.adm)
         allAdm == backAdmMsgs \o faccAdm
         advisoryBytes == SumAdvBytes(allAdm)
         memoryBytes == SumMemBytes(allAdm)
         enterBytes == SumB(allAdm)
         hardOver == enterBytes > EB
         newEntries == DefEntries(Rev(faccRev.defer), nextEid, n)
         badTouch == \/ \E i \in DOMAIN faccRev.defer :
                          ProtectedKind(faccRev.defer[i])
                      \/ \E j \in DOMAIN back.drop :
                          ProtectedKind(back.drop[j].msg)
         real == Enforce \/ ObserveMutates
     IN
       /\ IF real
          THEN ( /\ lastAdmittedCount' = Len(allAdm)
                 /\ lastAdvisoryBytes' = advisoryBytes
                 /\ lastMemoryBytes' = memoryBytes
                 /\ lastHardOver' = hardOver
                 /\ batch' = << >>
                 /\ queue' = back.keep \o newEntries
                 /\ admEids' = admEids \union Eids(back.adm)
                 /\ droppedEids' = droppedEids \union Eids(back.drop)
                 /\ admCount' = BumpCounts(admCount, Eids(back.adm), 1)
                 /\ nextEid' = nextEid + Len(faccRev.defer)
                 /\ touched' = (touched \/ badTouch)
                 /\ admittedEver' = (admittedEver \/ faccRev.admK1 \/ BacklogHasK1(back))
                 /\ dedupeState' =
                      IF CommitAtCheck /\ faccRev.checkK1
                      THEN n
                      ELSE IF faccRev.admK1 \/ BacklogHasK1(back) THEN n
                      ELSE dedupeState
                 /\ capCount' =
                      capCount
                      + IF CommitAtCheck THEN faccRev.checkAdv
                        ELSE faccRev.admAdv + back.advCount )
          ELSE ( /\ lastAdmittedCount' = 0
                 /\ batch' = batch
                 /\ queue' = queue
                 /\ UNCHANGED <<admEids, droppedEids, admCount, dedupeState,
                                capCount, admittedEver, nextEid, touched,
                                lastAdvisoryBytes, lastMemoryBytes,
                                lastHardOver>> )
       /\ truthAdmSeq' =
            IF real /\ (faccRev.admK1 \/ BacklogHasK1(back)) THEN n ELSE truthAdmSeq
       /\ truthCapCount' =
            truthCapCount
              + IF real THEN faccRev.admAdv + back.advCount ELSE 0
       /\ truthAdmittedEver' =
            (truthAdmittedEver
              \/ IF real
                 THEN (faccRev.admK1 \/ BacklogHasK1(back)) ELSE FALSE)
       /\ gateSeq' = n

(* ---- keep-alive and next ---------------------------------------------- *)

Idle == UNCHANGED vars

Next == \/ \E m \in MS : Produce(m)
         \/ Gate
         \/ Idle

Spec == Init /\ [][Next]_vars

(* ---- invariants -------------------------------------------------------- *)

NeverTouched == touched = FALSE

DedupeCommitted == dedupeState = truthAdmSeq
CapCommitted == capCount = truthCapCount
AdmittedEverCommitted == admittedEver = truthAdmittedEver

AdvisoryBudgetHeld == lastAdvisoryBytes <= AB \/ lastHardOver
MemoryBudgetHeld == lastMemoryBytes <= MB \/ lastHardOver

(* Disposition partition: every queue entry is pending, or was admitted, *)
(* or was dropped - never two of those.                                  *)
DispositionPartition ==
  \A i \in DOMAIN queue :
    ~(queue[i].eid \in admEids) \/ ~(queue[i].eid \in droppedEids)

(* Exactly once: no entry id was ever admitted more than once.           *)
AdmittedAtMostOnce == \A i \in 1..10 : admCount[i] <= 1

ObserveClean == Enforce \/ lastAdmittedCount = 0

=============================================================================
