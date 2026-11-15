---- MODULE Model ----
(***************************************************************************)
(* VWA draft-render commit protocol (vwa-draft-render, Features B/E).      *)
(* Behavioral source: docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md *)
(* Sections 4.2 (bind v2), 4.3 (overwrite gate), 4.5 (span rejection),     *)
(* 7.1 (render intent), 7.2 (three-state read classification), 10.1.       *)
(*                                                                         *)
(* Claims: I1 no torn output; I2 no marker bytes ever reach the            *)
(* deliverable; I3 agreement by publication state (quiescent agreement,    *)
(* and a provisional render reads STALE_RENDER - never current, never      *)
(* INPUT_CHANGED); I4 span safety; I5 replay content stability; I6 no      *)
(* destruction of a file the graph does not own.                           *)
(*                                                                         *)
(* Code seams: store.ts commit stages 1..5 and the Fail union at           *)
(* store.ts:34-45; artifact.ts bind validation (33-37, 73-84); the 4.3     *)
(* overwrite gate; the 7.1 renders/<requestId>.json intent; the 7.2 read   *)
(* classification at tools.ts:371-376, commands.ts:320-322,                *)
(* report.ts:235-250.                                                      *)
(*                                                                         *)
(* Probes, each switching one WRONG design so TLC exhibits a counterexample:*)
(* NonAtomicWrite, MisclassifyStale, AllowOverlap, OverwriteForeign,       *)
(* AdoptWithoutRender, SkipIntent.                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS MaxRev,
          NonAtomicWrite,     (* probe: stage writes non-atomic bytes       *)
          MisclassifyStale,   (* probe: 7.2 collapses stale into drift      *)
          AllowOverlap,       (* probe: bind accepts a span in a marker     *)
          OverwriteForeign,   (* probe: first bind clobbers a foreign file  *)
          AdoptWithoutRender, (* probe: HEAD adopts a stale content hash    *)
          SkipIntent          (* probe: publish with no render intent       *)

Requests == {"q1", "q2"}
Drafts == {"d1", "d2"}
RenderIds == {"r1", "r2"}
Deliverables == {"none", "foreign", "r1", "r2", "torn"}

RenderId(d) == IF d = "d1" THEN "r1" ELSE "r2"

VARIABLES phase, draft, deliverable, graph, rev, committed, spans, obs, ahead,
          intents, faults

vars == <<phase, draft, deliverable, graph, rev, committed, spans, obs, ahead,
          intents, faults>>

TypeOK ==
  /\ phase \in {"idle", "staged", "rev", "op", "head", "crashed"}
  /\ draft \in Drafts
  /\ deliverable \in Deliverables
  /\ graph \in {"none"} \union RenderIds
  /\ rev \in 0..MaxRev
  /\ committed \subseteq Requests
  /\ spans \in {"ok", "overlap"}
  /\ obs \in {"none", "current", "stale-render", "input-changed"}
  /\ ahead \in BOOLEAN
  /\ intents \subseteq RenderIds
  /\ faults \subseteq {"torn-output", "misclassified-stale", "span-overlap",
                       "lost-user-file", "agreement-broken"}

Init ==
  /\ phase = "idle"
  /\ draft = "d1"
  /\ deliverable = "none"
  /\ graph = "none"
  /\ rev = 0
  /\ committed = {}
  /\ spans = "ok"
  /\ obs = "none"
  /\ ahead = FALSE
  /\ intents = {}
  /\ faults = {}

(*********************************** pre-existing file *******************)

(* A user-authored file already sits at the deliverable path before any     *)
(* bind. First-bind must respect the 4.3 ownership gate for it.            *)
PresentForeign ==
  /\ phase = "idle"
  /\ deliverable = "none"
  /\ deliverable' = "foreign"
  /\ UNCHANGED <<phase, draft, graph, rev, committed, spans, obs, ahead,
                  intents, faults>>

(*********************************** stage steps 9..10 ********************)

(* The render intent (step 9) is written BEFORE the deliverable bytes (step *)
(* 10), so a crash after publication always leaves evidence behind. The     *)
(* SkipIntent probe publishes without it: exactly the v2 defect, where a    *)
(* crashed roll-forward has no recoverable provenance.                     *)
Stage ==
  /\ phase = "idle"
  /\ \/ deliverable = "none"
     \/ deliverable \in RenderIds
     \/ (deliverable = "foreign" /\ OverwriteForeign)
  /\ intents' = IF SkipIntent
                  THEN intents
                  ELSE intents \union {RenderId(draft)}
  /\ deliverable' = IF NonAtomicWrite THEN "torn" ELSE RenderId(draft)
  /\ faults' =
       IF deliverable = "foreign" /\ OverwriteForeign
         THEN faults \union {"lost-user-file"}
         ELSE faults
  /\ spans' = IF AllowOverlap THEN "overlap" ELSE "ok"
  /\ phase' = "staged"
  /\ UNCHANGED <<draft, graph, rev, committed, obs, ahead>>

(*********************************** commit steps 2..5 ******************)

(* Revision envelope: immutable, carries the rendered content hash.        *)
RevStep ==
  /\ phase = "staged"
  /\ phase' = "rev"
  /\ UNCHANGED <<draft, deliverable, graph, rev, committed, spans, obs, ahead,
                  intents, faults>>

(* Operation record, prepared. *)
OpStep ==
  /\ phase = "rev"
  /\ phase' = "op"
  /\ UNCHANGED <<draft, deliverable, graph, rev, committed, spans, obs, ahead,
                  intents, faults>>

(* Atomic HEAD replace: the artifact content hash is adopted. The           *)
(* AdoptWithoutRender probe adopts a hash that does not describe the staged *)
(* bytes, which breaks agreement. Adoption clears the intent (step 12).    *)
HeadStep(q) ==
  /\ phase = "op"
  /\ q \notin committed
  /\ rev < MaxRev
  /\ phase' = "head"
  /\ rev' = rev + 1
  /\ committed' = committed \union {q}
  /\ graph' = IF AdoptWithoutRender THEN graph ELSE RenderId(draft)
  (* The bug clears the intent too: it believes the commit succeeded, which *)
  (* is exactly why a stale adoption is dangerous rather than visible.      *)
  /\ intents' = intents \ {RenderId(draft)}
  /\ UNCHANGED <<draft, deliverable, spans, obs, ahead, faults>>

(* Read-back verification, transaction done. *)
Finish ==
  /\ phase = "head"
  /\ phase' = "idle"
  (* The AdoptWithoutRender bug also clears its own bookkeeping, which is    *)
  (* what makes it dangerous: it reports success while the graph lags.      *)
  /\ ahead' = IF AdoptWithoutRender THEN FALSE
                ELSE (deliverable \in RenderIds /\ deliverable # graph)
  /\ UNCHANGED <<draft, deliverable, graph, rev, committed, spans, obs, intents,
                  faults>>

(*********************************** crash and recovery ******************)

Crash ==
  /\ phase \in {"staged", "rev", "op", "head"}
  /\ phase' = "crashed"
  /\ ahead' = (deliverable \in RenderIds /\ deliverable # graph)
  /\ UNCHANGED <<draft, deliverable, graph, rev, committed, spans, obs, intents,
                  faults>>

(* 7.4: the remedy is a normal agent action - the next bind re-renders and  *)
(* re-adopts. No human step, no new command.                               *)
Recover ==
  /\ phase = "crashed"
  /\ phase' = "idle"
  /\ UNCHANGED <<draft, deliverable, graph, rev, committed, spans, obs, ahead,
                  intents, faults>>

(* Another artifact's transaction between a crash and the retried bind. It  *)
(* must not silently adopt the provisional deliverable.                    *)
UnrelatedTx ==
  /\ phase = "idle"
  /\ rev < MaxRev
  /\ rev' = rev + 1
  /\ ahead' = (deliverable \in RenderIds /\ deliverable # graph)
  /\ UNCHANGED <<phase, draft, deliverable, graph, committed, spans, obs,
                  intents, faults>>

(*********************************** draft drift *************************)

EditDraft ==
  /\ phase = "idle"
  /\ draft = "d1"
  /\ draft' = "d2"
  /\ UNCHANGED <<phase, deliverable, graph, rev, committed, spans, obs, ahead,
                  intents, faults>>

(*********************************** read classification 7.2 *************)

(* current       = bytes hash to the adopted contentHash.                  *)
(* stale-render  = bytes are a render of the current draft, OR an intent    *)
(*                 records that this runtime produced exactly these bytes   *)
(*                 and never adopted them.                                 *)
(* input-changed = every other case, i.e. genuine drift.                    *)
(* MisclassifyStale drops the stale branch entirely.                       *)
ReadCheck ==
  /\ phase \in {"idle", "crashed"}
  /\ obs' =
       IF deliverable = graph THEN "current"
       ELSE IF MisclassifyStale THEN "input-changed"
       ELSE IF deliverable = RenderId(draft) \/ deliverable \in intents
              THEN "stale-render"
              ELSE "input-changed"
  /\ faults' =
       IF MisclassifyStale /\ deliverable \in RenderIds /\ deliverable # graph
          /\ (deliverable = RenderId(draft) \/ deliverable \in intents)
         THEN faults \union {"misclassified-stale"}
         ELSE faults
  /\ UNCHANGED <<phase, draft, deliverable, graph, rev, committed, spans, ahead,
                  intents>>

Idle == UNCHANGED vars

Next ==
  \/ PresentForeign \/ Stage \/ RevStep \/ OpStep \/ Finish
  \/ \E q \in Requests : HeadStep(q)
  \/ Crash \/ Recover \/ UnrelatedTx \/ EditDraft \/ ReadCheck \/ Idle

Spec == Init /\ [][Next]_vars

(*********************************** invariants ***************************)

(* I1: only whole renders, foreign files or absence are observable. *)
NoTornOutput == deliverable # "torn"

(* I2: every written value is RenderId(draft), a marker-free render. *)
MarkerFreeByConstruction ==
  deliverable \in {"none", "foreign"} \/ deliverable \in RenderIds

(* I3(i): quiescent, nothing pending or ahead, so the graph is satisfied. *)
AgreementWhenQuiescent ==
  (phase = "idle" /\ ~ahead /\ deliverable \in RenderIds)
    => (deliverable = graph \/ deliverable \in intents)

(* I3(ii): a provisional render is never misread as drift. This is the     *)
(* property all three r2 seats found violated in the v2 text.              *)
ProvisionalIsStale ==
  obs = "input-changed"
    => deliverable # RenderId(draft) /\ deliverable \notin intents

(* I4: no persisted span intersects a stripped marker range. *)
SpanSafety == spans = "ok"

(* I5: committed requests never exceed revisions, so one request cannot     *)
(* adopt two divergent states.                                             *)
ReplayContentStable == Cardinality(committed) <= rev

(* I6: a bind without the ownership gate never replaces a foreign file. *)
NoLostUserFile == ~("lost-user-file" \in faults)

(* Probes must be observable as faults, never as ordinary states. *)
NoFaults == faults = {}

=============================================================================
