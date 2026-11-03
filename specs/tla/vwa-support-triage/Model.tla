---- MODULE Model ----
(***************************************************************************)
(* VWA support-relation triage scheduling (S1-07).                        *)
(* Behavioral source:                                                     *)
(* docs/plans/2026-11-02-systemone-07-vwa-support-triage.md -- reuse      *)
(* before triage, triage after the reuse filter, the frozen ordering,     *)
(* late results billed but not reordering a dispatched batch, and the     *)
(* DecisionScope identity re-evaluation across cycle/resume.              *)
(*                                                                        *)
(* The quota protocol itself (reserve/settle/torn) is covered by          *)
(* specs/tla/decision-runtime-quota; this model owns only the triage      *)
(* scheduling semantics that ride on it.                                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MaxBatches,
          ReorderOnLate,     (* probe: a late result reorders a dispatched *)
                             (* batch                                     *)
          TriageReused,      (* probe: triage covers an already reused      *)
                             (* task                                      *)
          ReuseAcrossScope,  (* probe: hints reused across a scope change   *)
          AdoptLateAsOrder   (* probe: a past-deadline result changes order *)

\* Fixed small task domain: three planned tasks.
Tasks == {1, 2, 3}

VARIABLES phase, pending, frozen, reused, batch, hint, scopeGen, lateSeen,
          faults

vars == <<phase, pending, frozen, reused, batch, hint, scopeGen, lateSeen,
          faults>>

TypeOK ==
  /\ phase \in {"planned", "reuse-filtered", "triage-pending", "triage-frozen"}
  /\ pending \subseteq Tasks
  /\ frozen \subseteq Tasks
  /\ reused \subseteq Tasks
  /\ batch \in [Tasks -> 0..MaxBatches]
  /\ hint \in [Tasks -> 0..2]
  /\ scopeGen \in 0..2
  /\ lateSeen \subseteq Tasks
  /\ faults \subseteq {"late-reorder", "triage-reused", "cross-scope-reuse",
                       "late-adopted"}

Init ==
  /\ phase = "planned"
  /\ pending = {}
  /\ frozen = {}
  /\ reused = {}
  /\ batch = [t \in Tasks |-> 0]
  /\ hint = [t \in Tasks |-> 0]
  /\ scopeGen = 0
  /\ lateSeen = {}
  /\ faults = {}

(************************************** planning + reuse *******************)

(* Reuse runs BEFORE triage: an already completed task never pays for a  *)
(* decision a second time.                                                *)
Reuse(t) ==
  /\ phase = "planned"
  /\ t \notin reused
  /\ reused' = reused \union {t}
  /\ pending' = pending \ {t}
  /\ UNCHANGED <<phase, frozen, batch, hint, scopeGen, lateSeen, faults>>

ReuseFilter ==
  /\ phase = "planned"
  /\ phase' = "reuse-filtered"
  /\ pending' = Tasks \ reused
  /\ UNCHANGED <<frozen, reused, batch, hint, scopeGen, lateSeen, faults>>

(* Triage acts only on the pending set, never on reused records.         *)
TriageStart ==
  /\ phase = "reuse-filtered"
  /\ phase' = "triage-pending"
  /\ UNCHANGED <<pending, frozen, reused, batch, hint, scopeGen, lateSeen,
                  faults>>

(* Probe: triage covers an already reused task (it enters the frozen     *)
(* set, so that record would be rewritten and paid for twice).            *)
TriageTouchesReused(t) ==
  /\ TriageReused
  /\ phase = "reuse-filtered"
  /\ t \in reused
  /\ phase' = "triage-pending"
  /\ frozen' = frozen \union {t}
  /\ faults' = faults \union {"triage-reused"}
  /\ UNCHANGED <<pending, reused, batch, hint, scopeGen, lateSeen>>

(************************************** ordering + batch ******************)

(* Hints order the pending set; the frozen order is the deliverable.     *)
Hint(t, h) ==
  /\ phase = "triage-pending"
  /\ t \in pending
  /\ hint' = [hint EXCEPT ![t] = h]
  /\ UNCHANGED <<phase, pending, frozen, reused, batch, scopeGen, lateSeen,
                  faults>>

(* Freezing assigns the batch order once; afterwards it is immutable.    *)
Freeze(b) ==
  /\ phase = "triage-pending"
  /\ frozen = {}
  /\ phase' = "triage-frozen"
  /\ frozen' = pending
  /\ batch' = [t \in Tasks |->
                IF t \in pending THEN b ELSE batch[t]]
  /\ UNCHANGED <<pending, reused, hint, scopeGen, lateSeen, faults>>

ReorderLate(t, b) ==
  /\ ReorderOnLate \/ AdoptLateAsOrder
  /\ phase = "triage-frozen"
  /\ t \in frozen
  /\ batch' = [batch EXCEPT ![t] = b]
  /\ lateSeen' = lateSeen \union {t}
  /\ faults' = faults \union {"late-reorder"}
  /\ UNCHANGED <<phase, pending, frozen, reused, hint, scopeGen>>

(* A result past the deadline is billed only; it never changes the order. *)
LateIgnored(t) ==
  /\ phase = "triage-frozen"
  /\ t \in frozen
  /\ lateSeen' = lateSeen \union {t}
  /\ UNCHANGED <<phase, pending, frozen, reused, batch, hint, scopeGen,
                  faults>>

(************************************** identity **************************)

(* A scope/cycle change re-evaluates: hints from the old scope are not   *)
(* reusable (a resume with an identical scope reuses them).              *)
ScopeChange ==
  /\ scopeGen < 2
  /\ scopeGen' = scopeGen + 1
  /\ IF ReuseAcrossScope
       THEN /\ faults' = faults \union {"cross-scope-reuse"}
            /\ UNCHANGED <<phase, pending, frozen, reused, batch, hint,
                            lateSeen>>
       ELSE /\ hint' = [t \in Tasks |-> 0]
            /\ UNCHANGED <<phase, pending, frozen, reused, batch, lateSeen,
                            faults>>

Idle == UNCHANGED vars

Next == \/ \E t \in Tasks : Reuse(t) \/ TriageTouchesReused(t) \/
                             LateIgnored(t)
        \/ ReuseFilter \/ TriageStart
        \/ \E t \in Tasks, h \in 0..2 : Hint(t, h)
        \/ \E b \in 1..MaxBatches : Freeze(b)
        \/ \E t \in Tasks, b \in 1..MaxBatches : ReorderLate(t, b)
        \/ ScopeChange \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

NoFaults == faults = {}

(* Reuse and triage are disjoint: triage never covers an already reused  *)
(* task, so no decision is paid twice and no record is rewritten.        *)
ReuseTriageDisjoint == reused \cap frozen = {}

(* A past-deadline result never changes the delivered order.             *)
LateNeverReorders == ~"late-reorder" \in faults

(* Hints never cross a scope change.                                     *)
NoCrossScopeReuse == ~"cross-scope-reuse" \in faults

(* Reused tasks are exactly the ones excluded from triage.               *)
ReuseExcluded == phase = "reuse-filtered" => pending = Tasks \ reused

=============================================================================
