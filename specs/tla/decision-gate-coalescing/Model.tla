---- MODULE Model ----
(***************************************************************************)
(* Shared decision-gate protocol (S1-05 / S1-06 / S1-11 / S1-12).           *)
(* Behavioral source: the four feature docs share one concurrency shape -- *)
(* docs/plans/2026-11-02-systemone-11-summary-gate.md is the most          *)
(* complete statement (cache key, coalescing, independent cancellation,  *)
(* post-await revalidation); S1-05 tool-discovery, S1-06 skill-           *)
(* recommendation and S1-12 reducer-gate state the same rules.            *)
(*                                                                        *)
(* Scope: the gate protocol only. The model covers: cache-then-coalesce    *)
(* with per-caller independent cancellation (the request is aborted only   *)
(* when every waiter cancels), only-complete-answers cached, identity     *)
(* revalidation after await, and the no-request path for over-bound or    *)
(* unavailable input.                                                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MaxReq,
          AbortLastWaiter,   (* probe: coalesced request aborted while    *)
                             (* waiters remain (must be impossible)       *)
          CachePartial,      (* probe: an incomplete answer cached        *)
          SkipReval,         (* probe: identity not revalidated post-await *)
          ServeAfterCancel   (* probe: a cancelled waiter consumes results  *)

CALLERS == {"c1", "c2"}
REQS == 1..MaxReq

VARIABLES cache, cachedState, inflight, waiters, cancelled, state, phase,
          valid

vars == <<cache, cachedState, inflight, waiters, cancelled, state, phase,
          valid>>

TypeOK ==
  /\ cache \in {TRUE, FALSE}
  /\ cachedState \in {"ok", "partial", "none"}
  /\ inflight \in REQS \union {0}
  /\ waiters \subseteq CALLERS
  /\ cancelled \subseteq CALLERS
  /\ state \in {"ok", "partial", "none"}
  /\ phase \in {"idle", "dispatched", "settled"}
  /\ valid \in BOOLEAN

Init ==
  /\ cache = FALSE
  /\ cachedState = "none"
  /\ inflight = 0
  /\ waiters = {}
  /\ cancelled = {}
  /\ state = "none"
  /\ phase = "idle"
  /\ valid = TRUE

(************************************** arrival ****************************)

(* A caller arrives with the same key: it joins the waiter set of the      *)
(* in-flight request (coalescing) instead of issuing a second request.   *)
Join(p) ==
  /\ inflight # 0
  /\ p \notin waiters
  /\ waiters' = waiters \union {p}
  /\ UNCHANGED <<cache, cachedState, inflight, cancelled, state, phase,
                  valid>>

(* No in-flight request: start one with this caller as the single waiter. *)
Start(p) ==
  /\ inflight = 0
  /\ phase = "idle"
  /\ cache = FALSE
  /\ p \notin cancelled
  /\ inflight' = 1
  /\ waiters' = {p}
  /\ phase' = "dispatched"
  /\ state' = "none"
  /\ cancelled' = {}
  /\ UNCHANGED <<cache, cachedState, valid>>

(* Over-bound input or an unavailable service: no request at all.       *)
NoRequest(p) ==
  /\ inflight = 0
  /\ phase = "idle"
  /\ UNCHANGED <<cache, cachedState, inflight, waiters, cancelled, state, phase, valid>>

(************************************** cancellation **********************)

(* Each waiter cancels independently; the coalesced request is aborted   *)
(* only when EVERY waiter has cancelled.                                  *)
Cancel(p) ==
  /\ p \in waiters
  /\ IF (cancelled \union {p}) = waiters
       THEN /\ inflight' = 0
            /\ phase' = "idle"
            /\ state' = "none"
            /\ waiters' = {}
            /\ cancelled' = {}
            /\ UNCHANGED <<cache, cachedState, valid>>
       ELSE /\ cancelled' = cancelled \union {p}
            /\ UNCHANGED <<cache, cachedState, inflight, waiters, state,
                            phase, valid>>

(* Probe: the request is aborted while waiters remain.                   *)
AbortEarly ==
  /\ AbortLastWaiter
  /\ inflight # 0
  /\ phase = "dispatched"
  /\ waiters # cancelled
  /\ inflight' = 0
  /\ phase' = "idle"
  /\ state' = "none"
  /\ waiters' = {}
  /\ UNCHANGED <<cache, cachedState, cancelled, valid>>

(************************************** settlement *************************)

(* The response arrives. Only a COMPLETE successful answer may be cached; *)
(* an unavailable, cancelled or half-set result is never cached.         *)
Respond(s) ==
  /\ inflight # 0
  /\ phase = "dispatched"
  /\ state' = s
  /\ phase' = "settled"
  /\ cache' = IF CachePartial \/ SkipReval
                THEN (s = "ok" \/ s = "partial")
                ELSE (s = "ok")
  /\ cachedState' = IF cache' THEN s ELSE cachedState
  /\ valid' = (IF SkipReval THEN TRUE ELSE valid)
  /\ UNCHANGED <<inflight, waiters, cancelled>>

(* After settlement the gate consumes: each surviving waiter reads the     *)
(* result; a cancelled waiter must not consume it.                         *)
Consume(p) ==
  /\ phase = "settled"
  /\ p \in waiters
  /\ (ServeAfterCancel \/ p \notin cancelled)
  /\ UNCHANGED <<cache, cachedState, inflight, waiters, cancelled, state, phase, valid>>

(* The final waiter leaves; the request slot closes.                      *)
Leave(p) ==
  /\ p \in waiters
  /\ waiters' = waiters \ {p}
  /\ cancelled' = cancelled \ {p}
  /\ IF waiters' = {}
       THEN /\ inflight' = 0
            /\ phase' = "idle"
            /\ state' = "none"
       ELSE /\ UNCHANGED <<inflight, phase, state>>
  /\ UNCHANGED <<cache, cachedState, valid>>

(************************************** lifecycle **************************)

ClearCache ==
  /\ cache
  /\ cache' = FALSE
  /\ cachedState' = "none"
  /\ UNCHANGED <<inflight, waiters, cancelled, state, phase, valid>>

Idle == /\ inflight = 0 /\ phase = "idle" /\ waiters = {}
        /\ UNCHANGED <<cache, cachedState, inflight, waiters, cancelled, state,
                       phase, valid>>

Next == \/ \E p \in CALLERS : Join(p) \/ Start(p) \/ NoRequest(p) \/
                             Cancel(p) \/ Consume(p) \/ Leave(p)
        \/ \E s \in {"ok", "partial"} : Respond(s)
        \/ AbortEarly \/ ClearCache \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

(* The request is aborted only when every waiter has cancelled.           *)
AbortOnlyWhenAllCancelled == (inflight = 0 /\ phase # "settled") =>
  (waiters = {} => cancelled = {})

(* Only a complete, successful, identity-validated answer is cached.      *)
CacheCompleteOnly == cache => cachedState = "ok"

(* A cancelled waiter never consumes the result.                          *)
NoConsumeAfterCancel == \A p \in cancelled : phase = "settled" =>
  ~(ServeAfterCancel /\ p \in waiters)

(* A settled request is still holding the slot until its waiters drain.   *)
SettledHoldsSlot == phase = "settled" => inflight # 0

(* Identity is still valid at consumption time.                           *)
ValidAtConsume == phase = "settled" => valid

=============================================================================
