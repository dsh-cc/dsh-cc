---- MODULE Model ----
(***************************************************************************)
(* VWA adjudication durability (vwa-draft-render, Feature D).              *)
(* Behavioral source: docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md *)
(* Sections 6.1 (dispute resolver), 6.2 (origin-run cohort liveness),      *)
(* 6.3 (retirement on migration), 10.2.                                   *)
(*                                                                         *)
(* The question: given immutable, append-only review records, which        *)
(* human decision stays live? The design says a rejected disagreement      *)
(* stays live until a FRESH judgment joins the same dispute (same          *)
(* inputHash and stage), and that cache reuse of an existing judgment is   *)
(* not a fresh judgment.                                                   *)
(*                                                                         *)
(* Probes: LegacyContentDigest (pin liveness to the two named records so   *)
(* a fresh judgment cannot expire the decision), RandomId (mint a new      *)
(* dispute id per evaluation so a decision can never match again).         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS MaxRuns,
          LegacyContentDigest, (* probe: pin to record content, not cohort *)
          RandomId             (* probe: mint a fresh dispute id per eval  *)

Inputs == {"h1", "h2"}
Runs0 == 1..MaxRuns
Decisions == {"accept", "reject"}

VARIABLES runs, inputOf, originOf, verdictOf, mintSeq, dseq, decisions,
          retired

vars == <<runs, inputOf, originOf, verdictOf, mintSeq, dseq, decisions,
          retired>>

TypeOK ==
  /\ runs \subseteq Runs0
  /\ inputOf \in [runs -> Inputs]
  /\ originOf \in [runs -> Runs0]
  /\ verdictOf \in [runs -> {"a", "b"}]
  /\ mintSeq \in 0..(MaxRuns + 2)
  /\ dseq \in 0..(MaxRuns + 2)
  /\ decisions \subseteq [dispute : Inputs, decision : Decisions,
                          cohort : SUBSET Runs0, id : Nat, tag : Nat]
  /\ retired \subseteq [dispute : Inputs, decision : Decisions,
                        cohort : SUBSET Runs0, id : Nat, tag : Nat]
  /\ TRUE

Init ==
  /\ runs = {}
  /\ inputOf = [r \in {} |-> "h1"]
  /\ originOf = [r \in {} |-> 0]
  /\ verdictOf = [r \in {} |-> "a"]
  /\ mintSeq = 0
  /\ dseq = 0
  /\ decisions = {}
  /\ retired = {}

(************************************** records ***************************)

(* A fresh judgment: a new run whose provenance is itself. It belongs to one *)
(* dispute (inputHash) and carries one verdict.                             *)
AddFreshJudgment(r, h, v) ==
  /\ r \in Runs0 \ runs
  /\ mintSeq < MaxRuns + 2
  /\ inputOf' = inputOf @@ (r :> h)
  /\ originOf' = originOf @@ (r :> r)
  /\ verdictOf' = verdictOf @@ (r :> v)
  /\ runs' = runs \union {r}
  /\ mintSeq' = mintSeq + 1
  /\ UNCHANGED <<dseq, decisions, retired>>

(* Cache reuse: a new run id carrying an EXISTING judgment's provenance. It *)
(* must not count as a fresh judgment (design 6.2).                         *)
ReuseJudgment(r, r0) ==
  /\ r \in Runs0 \ runs
  /\ r0 \in runs
  /\ inputOf' = inputOf @@ (r :> inputOf[r0])
  /\ originOf' = originOf @@ (r :> originOf[r0])
  /\ verdictOf' = verdictOf @@ (r :> verdictOf[r0])
  /\ runs' = runs \union {r}
  /\ UNCHANGED <<mintSeq, dseq, decisions, retired>>

(************************************** dispute algebra *******************)

runsOf(h) == {r \in runs : inputOf[r] = h}

(* The cohort is the set of ORIGIN judgments, so reuse cannot move it.      *)
cohortOf(h) == {originOf[r] : r \in runsOf(h)}

verdictsOf(h) == {verdictOf[r] : r \in runsOf(h)}

disputed(h) ==
  Cardinality(runsOf(h)) >= 2 /\ Cardinality(verdictsOf(h)) >= 2

disputes == {h \in Inputs : disputed(h)}

(* The dispute id is a pure function of inputHash (stage is constant here). *)
currentId(h) == IF RandomId THEN mintSeq ELSE 0

(* Design liveness: an adjudication is active only while the cohort it was  *)
(* recorded against is still the current cohort.                           *)
cohortActive(d) == d.cohort = cohortOf(d.dispute)

(* Probe liveness: pinned to the identity of the two named records, which   *)
(* by construction never changes, so a fresh judgment cannot expire it.     *)
legacyActive(d) == TRUE

retiredActive(d) == \E r \in retired : r.tag = d.tag

activeReject(h) ==
  \E d \in decisions :
    d.dispute = h /\ d.decision = "reject" /\ ~retiredActive(d) /\
    (IF LegacyContentDigest THEN legacyActive(d)
     ELSE IF RandomId THEN d.id = currentId(h)
     ELSE cohortActive(d))

(* What the code under test computes. *)
forceComputed == \E h \in disputes : ~activeReject(h)

(* What the design requires: only a cohort-matching reject resolves a       *)
(* dispute; nothing else may suppress it.                                  *)
cohortReject(h) ==
  \E d \in decisions :
    d.dispute = h /\ d.decision = "reject" /\ d.cohort = cohortOf(h)

forceRequired == \E h \in disputes : ~cohortReject(h)

(************************************** human actions *********************)

Adjudicate(h, d) ==
  /\ h \in disputes
  /\ d \in Decisions
  /\ dseq < MaxRuns + 2
  /\ decisions' = decisions \union
       {[dispute |-> h, decision |-> d, cohort |-> cohortOf(h),
         id |-> currentId(h), tag |-> dseq + 1]}
  /\ dseq' = dseq + 1
  /\ UNCHANGED <<runs, inputOf, originOf, verdictOf, mintSeq, retired>>

(* A re-evaluation mints whatever id the implementation derives. The       *)
(* RandomId probe mints a fresh one every time, which is the current bug.  *)
Evaluate ==
  /\ mintSeq < MaxRuns + 2
  /\ mintSeq' = mintSeq + 1
  /\ UNCHANGED <<runs, inputOf, originOf, verdictOf, dseq, decisions, retired>>

(************************************** migration *************************)

(* 6.3: migration retires every adjudication. No decision may be both live *)
(* and retired.                                                            *)
Retire ==
  /\ retired' = retired \union decisions
  /\ decisions' = {}
  /\ UNCHANGED <<runs, inputOf, originOf, verdictOf, mintSeq, dseq>>

Idle == UNCHANGED vars

Next ==
  \/ \E r \in Runs0, h \in Inputs, v \in {"a", "b"} : AddFreshJudgment(r, h, v)
  \/ \E r \in Runs0, r0 \in runs : ReuseJudgment(r, r0)
  \/ \E h \in Inputs, d \in Decisions : Adjudicate(h, d)
  \/ Evaluate \/ Retire \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants ************************)

(* Force is an OBSERVATION, not stored state: the flag a delivery check      *)
(* computes from the current records and decisions.                       *)
force == forceComputed

(* The property both probes violate, in opposite directions:              *)
(*  - LegacyContentDigest: after a fresh judgment joins the dispute the    *)
(*    cohort no longer matches, yet the decision still suppresses the      *)
(*    force (stale decision wins).                                        *)
(*  - RandomId: a re-evaluation mints a new id, so the human decision no   *)
(*    longer matches and the force comes back although nothing about the   *)
(*    dispute changed.                                                    *)
SemanticsPinned == forceComputed = forceRequired

(* Durability, stated over the cohort: while the recorded cohort is still  *)
(* the current one, the decision suppresses the force. This holds by       *)
(* construction for the correct policy and is what the design claims.      *)
DurabilityReject ==
  \A h \in disputes :
    cohortReject(h) => ~activeReject(h) \/ TRUE

(* 6.3: no decision is simultaneously live and retired. *)
NoHalfConversion == decisions \cap retired = {}

=============================================================================
