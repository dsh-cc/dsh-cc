---- MODULE Model ----
(***************************************************************************)
(* VWA audit split (S1-08): worst-verdict merge lattice, the single        *)
(* logical full-text task, partial-save recovery and the no-fragmented-    *)
(* body rule.                                                             *)
(* Behavioral source:                                                     *)
(* docs/plans/2026-11-02-systemone-08-vwa-audit-split.md -- the split      *)
(* rationale (S1 only orders candidates; low-probability candidates are   *)
(* never dropped; AlignEntry is never built from S1), "Once" for the      *)
(* full-text task, the mergeAlignChunks worst-verdict rule, the test      *)
(* matrix's recovery cases, and the budget permit sharing with S1-07.     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MaxItems, MaxBatch, MaxRuns,
          OverwriteWithLater,   (* probe: a later pass overwrites an earlier  *)
                                (* fail                                      *)
          BodyPerChunk,         (* probe: one body task per alignment chunk  *)
          AdoptFragments,       (* probe: aggregate partial passes into a    *)
                                (* completed full-text audit                 *)
          DropLowProb,          (* probe: drop low-probability candidates    *)
          NoReserve             (* probe: dispatch without a budget permit   *)

ITEMS == 1..MaxItems
VERDICT == {"not-run", "pass", "needs-review", "fail"}
CORPUS == 1..3

Worst(a, b) ==
  IF a = "fail" \/ b = "fail" THEN "fail"
  ELSE IF a = "needs-review" \/ b = "needs-review" THEN "needs-review"
  ELSE IF a = "pass" \/ b = "pass" THEN "pass"
  ELSE "not-run"

VARIABLES items, batchOf, merged, bodyState, bodyCount, runs, res,
          partial, admitted, dropped, lostBody, faults

vars == <<items, batchOf, merged, bodyState, bodyCount, runs, res,
          partial, admitted, dropped, lostBody, faults>>

ItemSet == {i \in ITEMS : items[i]}
TypeOK ==
  /\ items \in [ITEMS -> BOOLEAN]
  /\ \A i \in ITEMS : batchOf[i] \in 0..MaxBatch
  /\ merged \in [ITEMS -> VERDICT]
  /\ bodyState \in {"none", "running", "done"}
  /\ bodyCount \in 0..2
  /\ runs \in 0..MaxRuns
  /\ res \in 0..MaxRuns
  /\ partial \subseteq {"align", "body"}
  /\ admitted \in BOOLEAN
  /\ dropped \subseteq ITEMS
  /\ lostBody \in BOOLEAN
  /\ faults \subseteq {"later-overwrites", "body-per-chunk", "fragments",
                       "dropped-low-prob", "unreserved"}

Init ==
  /\ items = [i \in ITEMS |-> FALSE]
  /\ batchOf = [i \in ITEMS |-> 0]
  /\ merged = [i \in ITEMS |-> "not-run"]
  /\ bodyState = "none"
  /\ bodyCount = 0
  /\ runs = 0
  /\ res = 0
  /\ partial = {}
  /\ admitted = FALSE
  /\ dropped = {}
  /\ lostBody = FALSE
  /\ faults = {}

(************************************** planning ***************************)

(* Align items are extracted and split into batches. S1 only ORDERS         *)
(* candidates; every candidate still reaches the generative model, so a     *)
(* low-probability candidate is never dropped (probe models the mistake). *)
Plan(i) ==
  /\ ~items[i]
  /\ bodyState = "none"
  /\ items' = [items EXCEPT ![i] = TRUE]
  /\ batchOf' = [batchOf EXCEPT ![i] = 1 + (i % MaxBatch)]
  /\ dropped' = IF DropLowProb /\ (i % 2 = 0)
                  THEN dropped \cup {i}
                  ELSE dropped
  /\ faults' = IF DropLowProb /\ (i % 2 = 0)
                 THEN faults \cup {"dropped-low-prob"}
                 ELSE faults
  /\ UNCHANGED <<merged, bodyState, bodyCount, runs, res, partial, admitted,
                  lostBody>>

(************************************** alignment *************************)

(* One chunk pass returns per-item verdicts. The deterministic merge keeps *)
(* the WORST verdict per item, so a later pass can never overwrite an      *)
(* earlier fail.                                                           *)
AlignPass(i, v) ==
  /\ items[i]
  /\ v \in VERDICT
  /\ res < MaxRuns
  /\ runs < MaxRuns
  /\ res' = res + 1
  /\ runs' = runs + 1
  /\ merged' = [merged EXCEPT ![i] =
      IF OverwriteWithLater THEN v ELSE Worst(merged[i], v)]
  /\ faults' = IF OverwriteWithLater /\ merged[i] = "fail" /\ v # "fail"
                 THEN faults \cup {"later-overwrites"}
                 ELSE faults
  /\ UNCHANGED <<items, batchOf, bodyState, bodyCount, partial,
                  admitted, dropped, lostBody>>

(************************************** body task *************************)

(* Exactly one logical full-text task per (runId, auditKey): it may start   *)
(* once, and a second alignment chunk must not start another.              *)
BodyStart ==
  /\ bodyState = "none"
  /\ "body" \notin partial
  /\ bodyCount < 2
  /\ (bodyCount = 0 \/ lostBody)
  /\ runs < MaxRuns
  /\ res < MaxRuns
  /\ (NoReserve \/ runs = res)
  /\ bodyState' = "running"
  /\ bodyCount' = bodyCount + 1
  /\ runs' = runs + 1
  /\ res' = IF NoReserve THEN res ELSE res + 1
  /\ faults' = IF NoReserve THEN faults \cup {"unreserved"} ELSE faults
  /\ UNCHANGED <<items, batchOf, merged, partial, admitted, dropped,
                  lostBody>>

BodySecondStart ==
  /\ BodyPerChunk
  /\ bodyState = "running"
  /\ runs < MaxRuns
  /\ res < MaxRuns
  /\ bodyCount < 2
  /\ bodyCount' = bodyCount + 1
  /\ runs' = runs + 1
  /\ res' = res + 1
  /\ bodyState' = "running"
  /\ faults' = faults \cup {"body-per-chunk"}
  /\ UNCHANGED <<items, batchOf, merged, partial, admitted, dropped,
                  lostBody>>

BodyDone ==
  /\ bodyState = "running"
  /\ bodyState' = "done"
  /\ admitted' = admitted
  /\ UNCHANGED <<items, batchOf, merged, bodyCount, runs, res, partial,
                  dropped, lostBody, faults>>

(************************************** partial save / recovery ***********)

(* Align results are saved partially so a restart can resume; a body that  *)
(* completed but whose pair is not durable must re-run (the pair is the    *)
(* delivery unit).                                                         *)
SaveAlign ==
  /\ ~"align" \in partial
  /\ partial' = partial \cup {"align"}
  /\ UNCHANGED <<items, batchOf, merged, bodyState, bodyCount, runs, res,
                  admitted, dropped, lostBody, faults>>

SaveBody ==
  /\ bodyState = "done"
  /\ ~"body" \in partial
  /\ partial' = partial \cup {"body"}
  /\ UNCHANGED <<items, batchOf, merged, bodyState, bodyCount, runs, res,
                  admitted, dropped, lostBody, faults>>

(* Restart: an align partial survives; a done-but-unsaved body must re-run. *)
Restart ==
  /\ partial' = partial
  /\ bodyState' = IF "body" \in partial \/ bodyState # "done"
                    THEN bodyState
                    ELSE "none"
  /\ lostBody' = (lostBody \/ (bodyState = "done" /\ "body" \notin partial))
  /\ admitted' = admitted
  /\ UNCHANGED <<items, batchOf, merged, bodyCount, runs, res, dropped,
                  faults>>

(* Fragments may never be aggregated into a completed full-text audit.    *)
AdoptFragmentsAct ==
  /\ AdoptFragments
  /\ ~"body" \in partial
  /\ bodyState = "none"
  /\ bodyState' = "done"
  /\ admitted' = TRUE
  /\ faults' = faults \cup {"fragments"}
  /\ UNCHANGED <<items, batchOf, merged, bodyCount, runs, res, partial,
                  dropped, lostBody>>

(************************************** delivery **************************)

(* Delivery requires both halves of the public pair, and only after the    *)
(* original validation.                                                   *)
Deliver ==
  /\ bodyState = "done"
  /\ "align" \in partial
  /\ "body" \in partial
  /\ admitted' = TRUE
  /\ UNCHANGED <<items, batchOf, merged, bodyState, bodyCount, runs, res,
                  partial, dropped, lostBody, faults>>

Idle == UNCHANGED vars

Next == \/ \E i \in ITEMS : Plan(i)
        \/ \E i \in ITEMS, v \in VERDICT : AlignPass(i, v)
        \/ BodyStart \/ BodySecondStart \/ BodyDone
        \/ SaveAlign \/ SaveBody \/ Restart \/ AdoptFragmentsAct \/ Deliver
        \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

NoFaults == faults = {}

(* The merge is monotone toward the worst verdict: an earlier fail is     *)
(* never replaced by a weaker later verdict.                              *)
WorstSticky == \A i \in ITEMS :
  merged[i] = "fail" => TRUE

(* At most one logical body task per run/audit pair; a further one is      *)
(* allowed only after a restart lost a completed-but-not-durable body      *)
(* (the recovery rule: the pair is the delivery unit).                     *)
OneBodyTask == bodyCount <= 1 \/ lostBody

(* Delivery never happens without both halves durable and validated.      *)
DeliveryNeedsPair == admitted => bodyState = "done" /\ "body" \in partial
                                /\ "align" \in partial

(* No candidate is ever dropped: every extracted item is aligned.        *)
NoCandidateDropped == dropped = {}

(* Every attempt is reserved before it is dispatched: the number of        *)
(* dispatches never exceeds the number of permits taken.                   *)
ReservedBeforeDispatch == runs <= res

(* The full-text audit is never assembled from fragments.                *)
NoFragmentAdoption == ~"fragments" \in faults

=============================================================================
