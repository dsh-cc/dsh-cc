---- MODULE Model ----
(***************************************************************************)
(* Memory recall dispatch-key lifecycle (S1-03).                          *)
(* Behavioral source:                                                     *)
(* docs/plans/2026-11-02-systemone-03-memory-recall.md — the dispatch-key *)
(* section, the generation/supersede rules, and the failure table.        *)
(*                                                                        *)
(* Scope: the coordinator, not the judgement. A ticket arrives, a         *)
(* generation may be superseded, a stale task's finally must never clear *)
(* a newer running slot, shown may only record paths that were actually   *)
(* injected, and a completed key must never be paid for twice.            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS AbortOnArrive,      (* probe: Arrive fails to abort the old task *)
          InjectStale,        (* probe: inject without re-checking gen    *)
          ShownBeforeInject,  (* probe: mark shown before inject succeeds *)
          OldClearsNew,       (* probe: old finally clears newer running  *)
          CompletedTooEarly,  (* probe: completed written before dispatch *)
          IgnoreCompleted     (* probe: re-dispatch an already paid key   *)

\* Fixed small domain: two origins, two manifests, two candidate paths.
ORIGINS == {"o1", "o2"}
MANIFESTS == {"m1", "m2"}
PATHS == {"a", "b"}
MaxGen == 3

Keys == {<<o, m>> : o \in ORIGINS, m \in MANIFESTS}
PHASE == {"none", "scanning", "reading", "injecting"}
NONEK == <<"none", "none">>   \* sentinel key: same shape as Keys

VARIABLES gen, pend, runGen, runKey, phase, completed, dispCount,
          shown, delivered, injected, lateDispatch, alive

vars == <<gen, pend, runGen, runKey, phase, completed, dispCount,
          shown, delivered, injected, lateDispatch, alive>>

ZeroCount == [k \in Keys |-> 0]

TypeOK ==
  /\ gen \in 0..MaxGen
  /\ pend \in Keys \union {NONEK}
  /\ runGen \in 0..MaxGen
  /\ runKey \in Keys \union {NONEK}
  /\ phase \in PHASE
  /\ completed \subseteq Keys
  /\ \A k \in Keys : dispCount[k] \in Nat
  /\ shown \subseteq PATHS
  /\ delivered \subseteq PATHS
  /\ injected \subseteq PATHS
  /\ lateDispatch \subseteq Keys
  /\ alive \in BOOLEAN

Init ==
  /\ gen = 0
  /\ pend = NONEK
  /\ runGen = 0
  /\ runKey = NONEK
  /\ phase = "none"
  /\ completed = {}
  /\ dispCount = ZeroCount
  /\ shown = {}
  /\ delivered = {}
  /\ injected = {}
  /\ lateDispatch = {}
  /\ alive = TRUE

(************************************** ticket arrival *********************)

(* A new user turn yields a ticket for (origin, current manifest). A new  *)
(* key increments the generation, replaces pending (newest wins, older    *)
(* pending dropped) and aborts the running task — the abort is expressed  *)
(* as the running slot being cleared; the old promise still settles and   *)
(* its finally runs later (OldFinally).                                  *)
Arrive(k) ==
  /\ alive
  /\ ~(pend = k)
  /\ ~(phase # "none" /\ runKey = k)
  /\ gen < MaxGen
  /\ gen' = gen + 1
  /\ pend' = k
  /\ IF AbortOnArrive
       THEN /\ runGen' = 0
            /\ runKey' = NONEK
            /\ phase' = "none"
       ELSE /\ runGen' = runGen
            /\ runKey' = runKey
            /\ phase' = phase
  /\ UNCHANGED <<completed, dispCount, shown, delivered, injected,
                  lateDispatch, alive>>

(* Taking the pending ticket: scanning starts only after the ticket is    *)
(* obtained synchronously.                                                *)
Start ==
  /\ alive
  /\ pend # NONEK
  /\ phase = "none"
  /\ runGen' = gen
  /\ runKey' = pend
  /\ phase' = "scanning"
  /\ pend' = NONEK
  /\ UNCHANGED <<gen, completed, dispCount, shown, delivered, injected,
                  lateDispatch, alive>>

(************************************** scan ******************************)

ScanOk ==
  /\ alive
  /\ phase = "scanning"
  /\ phase' = "reading"
  /\ UNCHANGED <<gen, pend, runGen, runKey, completed, dispCount, shown,
                  delivered, injected, lateDispatch, alive>>

(* A scan failure writes no shown and no completed; the key may be retried *)
(* on a later pre-step.                                                   *)
ScanFail ==
  /\ alive
  /\ phase = "scanning"
  /\ IF CompletedTooEarly
       THEN completed' = completed \union {runKey}
       ELSE completed' = completed
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, dispCount, shown, delivered, injected,
                  lateDispatch, alive>>

(************************************** dispatch **************************)

(* The dispatch key is complete only after the scan (manifest hash, sorted *)
(* recentTools, route identity); only then is completed consulted.        *)
ReadOk ==
  /\ alive
  /\ phase = "reading"
  /\ (IgnoreCompleted \/ runKey \notin completed)
  /\ dispCount' = [dispCount EXCEPT ![runKey] = dispCount[runKey] + 1]
  /\ lateDispatch' = IF runKey \in completed
                        THEN lateDispatch \union {runKey}
                        ELSE lateDispatch
  /\ phase' = "injecting"
  /\ UNCHANGED <<gen, pend, runGen, runKey, completed, shown, delivered,
                  injected, alive>>

(* A completed key never dispatches: it is simply skipped (no request).   *)
SkipCompleted ==
  /\ alive
  /\ phase = "reading"
  /\ runKey \in completed
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, completed, dispCount, shown, delivered,
                  injected, lateDispatch, alive>>

ReadFail ==
  /\ alive
  /\ phase = "reading"
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, completed, dispCount, shown, delivered,
                  injected, lateDispatch, alive>>

(************************************** inject ****************************)

(* Injection succeeds: shown is written only now, together with the        *)
(* delivered mirror, and only after the freshness re-check (generation     *)
(* still latest; cancellation/idle are the Arrive/Dispose paths).          *)
InjectOk(p) ==
  /\ alive
  /\ phase = "injecting"
  /\ (InjectStale \/ runGen = gen)
  /\ (IgnoreCompleted \/ runKey \notin completed)
  /\ p \notin delivered
  /\ shown' = shown \union {p}
  /\ delivered' = delivered \union {p}
  /\ injected' = injected \union {p}
  /\ completed' = completed \union {runKey}
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, dispCount, lateDispatch, alive>>

(* The injection throws. No path may be recorded as shown; the key is      *)
(* still completed so the same input is not paid for twice. The probe      *)
(* models the failure to wait for a successful inject before writing       *)
(* shown.                                                                 *)
InjectThrows(p) ==
  /\ alive
  /\ phase = "injecting"
  /\ p \notin delivered
  /\ shown' = IF ShownBeforeInject THEN shown \union {p} ELSE shown
  /\ completed' = completed \union {runKey}
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, dispCount, delivered, injected,
                  lateDispatch, alive>>

(* Empty selection: nothing is injected, but the key is completed so the  *)
(* same input is not paid for twice.                                      *)
InjectEmpty ==
  /\ alive
  /\ phase = "injecting"
  /\ (InjectStale \/ runGen = gen)
  /\ (IgnoreCompleted \/ runKey \notin completed)
  /\ completed' = completed \union {runKey}
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, dispCount, shown, delivered, injected,
                  lateDispatch, alive>>

(* A read failure after selection, a content-hash mismatch or a thrown    *)
(* injection marks the key terminal and marks no undelivered path shown.  *)
InjectFail ==
  /\ alive
  /\ phase = "injecting"
  /\ completed' = completed \union {runKey}
  /\ phase' = "none"
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ UNCHANGED <<gen, pend, dispCount, shown, delivered, injected,
                  lateDispatch, alive>>

(************************************** finally ***************************)

(* The old task's finally may clean up only its own generation. It clears *)
(* the slot; it must not disturb a newer task still in flight (the probe  *)
(* lets a stale finally clear an unrelated newer slot).                   *)
OldFinally(g) ==
  /\ alive
  /\ runGen # 0
  /\ (OldClearsNew \/ runGen = g)
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ phase' = IF runGen = g THEN "none" ELSE phase
  /\ UNCHANGED <<gen, pend, completed, dispCount, shown, delivered,
                  injected, lateDispatch, alive>>

Dispose ==
  /\ alive
  /\ alive' = FALSE
  /\ gen' = 0
  /\ pend' = NONEK
  /\ runGen' = 0
  /\ runKey' = NONEK
  /\ phase' = "none"
  /\ UNCHANGED <<completed, dispCount, shown, delivered, injected,
                  lateDispatch>>

Idle == /\ ~alive
        /\ UNCHANGED <<gen, pend, runGen, runKey, phase, completed,
                       dispCount, shown, delivered, injected, lateDispatch,
                       alive>>

Next == \/ \E k \in Keys : Arrive(k)
        \/ Start \/ ScanOk \/ ScanFail \/ ReadOk \/ SkipCompleted \/
           ReadFail \/ InjectEmpty \/ InjectFail
        \/ \E p \in PATHS : InjectOk(p) \/ InjectThrows(p)
        \/ \E g \in 0..MaxGen : OldFinally(g)
        \/ Dispose \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

(* shown records only paths that were actually injected successfully.     *)
ShownSubsetDelivered == shown \subseteq delivered

(* A path is injected at most once: no duplicate injection across keys,   *)
(* mode switches or generations.                                          *)
NoReinject == injected = delivered

(* Injection never happens for a superseded generation.                   *)
NoStaleInject == phase = "injecting" => runGen = gen

(* completed is only ever written for a key that actually dispatched.     *)
CompletedNeedsDispatch == completed \subseteq
  {k \in Keys : dispCount[k] > 0}

(* A dispatch key that already reached a terminal state is never paid for *)
(* again (the dedup contract). A key aborted in flight before any terminal *)
(* write may legitimately be retried by a later trigger, and pays again.   *)
NoLateDispatch == lateDispatch = {}

(* The running slot never names a generation ahead of the counter.        *)
RunningBound == runGen <= gen

(* A superseded generation cannot be running: the slot is either empty or *)
(* the current generation.                                                *)
GenCurrent == runGen = 0 \/ runGen = gen

(* An in-flight task is always the one the running slot names: a stale     *)
(* finally that clears the slot of a newer task leaves an unowned task.    *)
SlotNamesInFlight == (phase # "none") => (runGen = gen)

=============================================================================
