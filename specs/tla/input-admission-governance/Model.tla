---- MODULE Model ----
(***************************************************************************)
(* Input admission governance (input-governance docs 1+7).                *)
(* Behavioral source:                                                      *)
(* docs/plans/2026-11-12-per-step-input-budget-governor.md and             *)
(* docs/plans/2026-11-12-injection-dedupe-notice-governance.md --         *)
(* classes, commit-on-admission dedupe/caps, budgets, defer/TTL,           *)
(* observe isolation.                                                      *)
(*                                                                       *)
(* Scope: one gate invocation over an enter batch: age the defer backlog, *)
(* re-offer it FIFO against own-class budgets, then walk the fresh batch  *)
(* in arrival order with in-batch provisional dedupe/cap allocation:      *)
(* check-eligible messages are admitted while their class budget has      *)
(* room, deferred when the room is exhausted, and dropped when            *)
(* individually oversize; check-failed messages are dropped. Dedupe and   *)
(* cap state advances only for messages that survive into the admitted     *)
(* batch (commit-on-admission). Unknown kinds are passthrough.            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS CommitAtCheck,      (* probe: dedupe/cap state advances at     *)
                                 (* check time, not admission              *)
          UnknownAsAdvisory,  (* probe: unknown kinds classified          *)
                                 (* advisory (the r1 inversion)           *)
          ObserveMutates,     (* probe: observe mode writes the real      *)
                                 (* pipeline outcome                       *)
          Enforce             (* FALSE = observe mode                     *)

MaxSeq == 5
AB == 4                      (* advisory budget (bytes)                  *)
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
mU == [id |-> 6, kind |-> "unknown",    bytes |-> 2, key |-> "none"]

MS == {mG, mT, mM, mA, mB, mU}

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

VARIABLES gateSeq,       (* monotonic gate invocation counter           *)
          batch,        (* pending producer arrivals (sequence)         *)
          queue,        (* deferred entries [eid, msg, enqueuedAt]     *)
          dedupeState,  (* plugin: k1 -> last committed admission seq  *)
          capCount,     (* plugin: committed advisor admissions         *)
          truthAdmSeq,  (* oracle: k1 -> last true admission seq        *)
          truthCapCount,(* oracle: true advisor admissions             *)
          admEids,      (* entry ids ever admitted from the backlog     *)
          droppedEids,  (* entry ids ever dropped from the backlog       *)
          nextEid,      (* deferred-entry id allocator                   *)
          lastAdmittedCount, (* messages the last gate really admitted *)
          lastAdvisoryBytes, (* that batch's advisory bytes              *)
          lastHardOver, (* that batch's hardOver flag                   *)
          touched       (* a protected/unknown message was deferred or  *)
                         (* dropped (a violation marker)                 *)

vars == <<gateSeq, batch, queue, dedupeState, capCount, truthAdmSeq,
          truthCapCount, admEids, droppedEids, nextEid,
          lastAdmittedCount, lastAdvisoryBytes, lastHardOver, touched>>

TypeOK ==
  /\ gateSeq \in 0..MaxSeq
  /\ \A i \in DOMAIN batch : batch[i] \in MS
  /\ Len(batch) \in 0..3
  /\ \A i \in DOMAIN queue :
       /\ queue[i].eid \in 1..18
       /\ queue[i].msg \in MS
       /\ queue[i].enqueuedAt \in 0..MaxSeq
  /\ Len(queue) \in 0..6
  /\ dedupeState \in 0..MaxSeq
  /\ capCount \in 0..12
  /\ truthAdmSeq \in 0..MaxSeq
  /\ truthCapCount \in 0..12
  /\ admEids \subseteq 1..18
  /\ droppedEids \subseteq 1..18
  /\ nextEid \in 1..19
  /\ lastAdmittedCount \in 0..6
  /\ lastAdvisoryBytes \in 0..18
  /\ lastHardOver \in BOOLEAN
  /\ touched \in BOOLEAN

Init ==
  /\ gateSeq = 0
  /\ batch = <<>>
  /\ queue = <<>>
  /\ dedupeState = 0
  /\ capCount = 0
  /\ truthAdmSeq = 0
  /\ truthCapCount = 0
  /\ admEids = {}
  /\ droppedEids = {}
  /\ nextEid = 1
  /\ lastAdmittedCount = 0
  /\ lastAdvisoryBytes = 0
  /\ lastHardOver = FALSE
  /\ touched = FALSE

(* ---- sequence helpers -------------------------------------------------- *)

RECURSIVE SumB(_)
SumB(s) == IF s = << >> THEN 0 ELSE Head(s).bytes + SumB(Tail(s))

Range(s) == {s[i] : i \in DOMAIN s}

Eids(s) == {s[i].eid : i \in DOMAIN s}

(* ---- eligibility (checked against committed state) -------------------- *)

DedupeEligible(m) ==
  \/ ~IsAdvisory(m)
  \/ m.key = "none"
  \/ gateSeq + 1 - dedupeState >= W

CapEligible(m) == m.kind # "advisor" \/ capCount < CapAdvisor

ProvisionalDedupeEligible(m, provK1) ==
  \/ ~IsAdvisory(m)
  \/ m.key = "none"
  \/ gateSeq + 1 - (IF provK1 THEN gateSeq + 1 ELSE dedupeState) >= W

ProvisionalCapEligible(m, provAdv) ==
  m.kind # "advisor" \/ capCount + provAdv < CapAdvisor

(* ---- backlog walk (FIFO, own-class budgets, in-batch provisional) ----- *)
(* acc: [adm | entries, keep | entries, drop | entries,                  *)
(*       adv | bytes, mem | bytes, k1 | bool, advCount | count]          *)
(* The k1/advCount fields count ADMISSIONS from the backlog. The         *)
(* provisional dedupe/cap allocation is threaded so that two same-key     *)
(* backlog entries cannot both be admitted in one gate.                  *)

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
            /\ ProvisionalDedupeEligible(e.msg, prov.k1)
            /\ ProvisionalCapEligible(e.msg, prov.adv)
    THEN WalkBacklog(Tail(rest),
          [acc EXCEPT !.adm = Append(@, e),
                   !.adv = @ + e.msg.bytes,
                   !.k1 = @ \/ e.msg.key = "k1",
                   !.advCount = @ + IF e.msg.kind = "advisor" THEN 1 ELSE 0],
          [prov EXCEPT !.k1 = @ \/ e.msg.key = "k1",
                   !.adv = @ + IF e.msg.kind = "advisor" THEN 1 ELSE 0])
    ELSE IF /\ IsMemory(e.msg)
            /\ acc.mem + e.msg.bytes <= MB
    THEN WalkBacklog(Tail(rest),
          [acc EXCEPT !.adm = Append(@, e),
                   !.mem = @ + e.msg.bytes], prov)
    ELSE WalkBacklog(Tail(rest), [acc EXCEPT !.keep = Append(@, e)], prov)

BacklogAcc == [adm |-> << >>, keep |-> << >>, drop |-> << >>,
                adv |-> 0, mem |-> 0, k1 |-> FALSE, advCount |-> 0]
ProvZero == [k1 |-> FALSE, adv |-> 0]

(* ---- fresh walk (arrival order, in-batch provisional allocation) ------ *)
(* prov: the in-batch provisional dedupe/cap usage seeded by the         *)
(* backlog's admissions at this gate.                                    *)
(* facc: [adm | msgs, defer | msgs, checkK1 | bool, admK1 | bool,        *)
(*        checkAdv | count, admAdv | count, adv | bytes, mem | bytes]    *)

RECURSIVE WalkFresh(_, _, _)
WalkFresh(rest, facc, prov) ==
  IF rest = << >> THEN facc
  ELSE LET m == Head(rest) IN
    IF ~ProvisionalDedupeEligible(m, prov.k1)
       \/ ~ProvisionalCapEligible(m, prov.adv)
    THEN WalkFresh(Tail(rest), facc, prov)
    ELSE IF m.bytes > ClassBudget(m)
    THEN WalkFresh(Tail(rest),
           [facc EXCEPT !.checkK1 = @ \/ m.key = "k1",
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
                    !.adv = @ + IF m.kind = "advisor" THEN 1 ELSE 0])

FreshAcc == [adm |-> << >>, defer |-> << >>, checkK1 |-> FALSE,
              admK1 |-> FALSE, checkAdv |-> 0, admAdv |-> 0,
              adv |-> 0, mem |-> 0]
ProvInit(back) == [k1 |-> back.k1, adv |-> back.advCount]

RECURSIVE MsgsOf(_)
MsgsOf(s) == IF s = << >> THEN << >> ELSE <<Head(s).msg>> \o MsgsOf(Tail(s))

(* Deferred entries for this gate's trimmed messages (fresh eids).        *)
RECURSIVE DefEntries(_, _, _)
DefEntries(s, eid, n) ==
  IF s = << >> THEN << >>
  ELSE << [eid |-> eid, msg |-> Head(s), enqueuedAt |-> n] >>
         \o DefEntries(Tail(s), eid + 1, n)

(* ---- actions ------------------------------------------------------------ *)

Produce(m) ==
  /\ Len(batch) < 3
  /\ batch' = batch \o <<m>>
  /\ UNCHANGED <<gateSeq, queue, dedupeState, capCount, truthAdmSeq,
                 truthCapCount, admEids, droppedEids, nextEid,
                 lastAdmittedCount, lastAdvisoryBytes, lastHardOver,
                 touched>>

Gate ==
  /\ batch # << >>
  /\ gateSeq < MaxSeq
  /\ LET n == gateSeq + 1
         back == WalkBacklog(queue, BacklogAcc, ProvZero)
         facc == WalkFresh(batch, FreshAcc, ProvInit(back))
         backAdmMsgs == MsgsOf(back.adm)
         allAdm == backAdmMsgs \o facc.adm
         advisoryBytes == SumB(SelectSeq(allAdm, IsAdvisory))
         enterBytes == SumB(allAdm)
         hardOver == enterBytes > EB
         newEntries == DefEntries(facc.defer, nextEid, n)
         badTouch == \/ \E i \in DOMAIN facc.defer : ProtectedKind(facc.defer[i])
                      \/ \E j \in DOMAIN back.drop : ProtectedKind(back.drop[j].msg)
         real == Enforce \/ ObserveMutates
     IN
       /\ IF real
          THEN ( /\ lastAdmittedCount' = Len(allAdm)
                 /\ lastAdvisoryBytes' = advisoryBytes
                 /\ lastHardOver' = hardOver
                 /\ batch' = << >>
                 /\ queue' = back.keep \o newEntries
                 /\ admEids' = admEids \union Eids(back.adm)
                 /\ droppedEids' = droppedEids \union Eids(back.drop)
                 /\ nextEid' = nextEid + Len(facc.defer)
                 /\ touched' = (touched \/ badTouch)
                 /\ dedupeState' =
                      IF CommitAtCheck /\ facc.checkK1
                      THEN n
                      ELSE IF facc.admK1 \/ back.k1 THEN n ELSE dedupeState
                 /\ capCount' =
                      capCount
                      + IF CommitAtCheck THEN facc.checkAdv
                         ELSE facc.admAdv + back.advCount )
          ELSE ( /\ lastAdmittedCount' = 0
                 /\ batch' = batch
                 /\ queue' = queue
                 /\ UNCHANGED <<admEids, droppedEids, dedupeState,
                                capCount, nextEid, touched,
                                lastAdvisoryBytes, lastHardOver>> )
       /\ truthAdmSeq' =
            IF real /\ (facc.admK1 \/ back.k1) THEN n ELSE truthAdmSeq
       /\ truthCapCount' =
            truthCapCount + IF real THEN facc.admAdv + back.advCount ELSE 0
       /\ gateSeq' = n

(* ---- keep-alive and next ----------------------------------------------- *)

(* Terminal states (gateSeq exhausted) self-loop: named stuttering so    *)
(* TLC's deadlock check sees a successor. No liveness is claimed.        *)
Idle == UNCHANGED vars

Next == \/ \E m \in MS : Produce(m)
         \/ Gate
         \/ Idle

Spec == Init /\ [][Next]_vars

(* ---- invariants -------------------------------------------------------- *)

(* Protected (governance/task) and unknown-kind messages are never        *)
(* deferred or dropped.                                                    *)
NeverTouched == touched = FALSE

(* Plugin dedupe/cap state equals the oracle that advances only at true   *)
(* admissions (the commit-on-admission discipline).                        *)
DedupeCommitted == dedupeState = truthAdmSeq
CapCommitted == capCount = truthCapCount

(* Advisory budget held on every real admitted batch.                     *)
AdvisoryBudgetHeld == lastAdvisoryBytes <= AB \/ lastHardOver

(* A queue entry is never admitted twice; admitted entries leave the      *)
(* queue exactly once.                                                      *)
DeferredExactlyOnce ==
  /\ \A i \in DOMAIN queue : queue[i].eid \notin admEids
  /\ \A i, j \in DOMAIN queue : i # j => queue[i].eid # queue[j].eid

(* In observe mode the real admitted batch stays empty and the real      *)
(* state is untouched.                                                     *)
ObserveClean == Enforce \/ lastAdmittedCount = 0

=============================================================================
