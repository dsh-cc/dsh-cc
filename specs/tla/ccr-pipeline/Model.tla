--------------------------- MODULE Model ---------------------------
(***************************************************************************)
(* Bounded model of the dsh-cc context-crusher (CCR) post-execute          *)
(* pipeline: deterministic route fast path, reducer (receipt) path, defer   *)
(* residency with the paired prune/replace swap, ledger applied/hash       *)
(* bookkeeping, dry-run, and the swap crash window.                        *)
(*                                                                         *)
(* Abstracted from packages/context/context-crusher (index.ts,            *)
(* reducer.ts, defer/{pass,swap,residents}.ts, ledger.ts, store.ts).      *)
(* See code-anchors.md for verbatim source excerpts.                       *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS DeferRequests, DRY, CrashWindow, HostDoubleFire

Tags == {"apply", "prune", "replace"}

VARIABLES phase, routeHit, verdictOk, surface, store,
          resident, sentCount, log, appliedLedger, hashLedger,
          swapPending, crashed

vars == <<phase, routeHit, verdictOk, surface, store,
          resident, sentCount, log, appliedLedger, hashLedger,
          swapPending, crashed>>

TypeOK ==
  /\ phase \in {"idle", "arrived", "done"}
  /\ routeHit \in BOOLEAN
  /\ verdictOk \in BOOLEAN
  /\ surface \in {"full", "compressed", "stub", "mutated"}
  /\ store \in BOOLEAN
  /\ resident \in BOOLEAN
  /\ sentCount \in 0..3
  /\ log \in Seq(Tags)
  /\ appliedLedger \in BOOLEAN
  /\ hashLedger \in BOOLEAN
  /\ swapPending \in BOOLEAN
  /\ crashed \in BOOLEAN

MarkerPositions ==
  {i \in 1..Len(log) : log[i] \in {"apply", "replace"}}

MarkerCount == Cardinality(MarkerPositions)

(* ----------------------------------------------------------------------- *)
(* Init                                                                     *)
(* ----------------------------------------------------------------------- *)

Init ==
  /\ phase = "idle"
  /\ routeHit = TRUE
  /\ verdictOk = TRUE
  /\ surface = "full"
  /\ store = FALSE
  /\ resident = FALSE
  /\ sentCount = 0
  /\ log = <<>>
  /\ appliedLedger = FALSE
  /\ hashLedger = FALSE
  /\ swapPending = FALSE
  /\ crashed = FALSE

(* ----------------------------------------------------------------------- *)
(* A tool result arrives (post-execute, composition after next(); the      *)
(* guards - enabled, protected tools, retrieve recursion, value-only,     *)
(* non-text blocks, size gate - are assumed passed). The deterministic     *)
(* router either finds a candidate (routeHit) or escalates to the          *)
(* reducer, whose verdict is nondeterministic.                            *)
(* ----------------------------------------------------------------------- *)

Arrive ==
  /\ ~crashed
  /\ phase = "idle"
  /\ phase' = "arrived"
  /\ surface' = "full"
  /\ \E hit \in BOOLEAN : routeHit' = hit
  /\ \E ok \in BOOLEAN : verdictOk' = ok
  /\ store' = store
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ log' = log
  /\ appliedLedger' = appliedLedger
  /\ hashLedger' = hashLedger
  /\ swapPending' = swapPending
  /\ crashed' = crashed

(* ----------------------------------------------------------------------- *)
(* Deterministic route fast path (no deferral): a below-threshold saving   *)
(* escalates to the reducer in the code; that escalation is folded into    *)
(* routeHit = FALSE here.                                                  *)
(* Dry-run: ledger applied:false, no hash, no session change.               *)
(* Apply: store.put BEFORE the ledger row; marker is the last line of the   *)
(* replacement.                                                            *)
(* ----------------------------------------------------------------------- *)

ApplyDeterministic ==
  /\ ~crashed
  /\ phase = "arrived"
  /\ routeHit
  /\ DeferRequests = 0
  /\ phase' = "done"
  /\ IF DRY
       THEN /\ appliedLedger' = FALSE
            /\ hashLedger' = FALSE
            /\ log' = log
            /\ surface' = surface
            /\ store' = store
       ELSE /\ store' = TRUE
            /\ log' = Append(log, "apply")
            /\ surface' = "compressed"
            /\ appliedLedger' = TRUE
            /\ hashLedger' = TRUE
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ swapPending' = swapPending
  /\ crashed' = crashed

(* ----------------------------------------------------------------------- *)
(* Defer fast path: the original is persisted to the store and the          *)
(* resident is recorded; the session keeps the full text for now.          *)
(* The ledger row carries applied:false WITH a hash (the documented         *)
(* anomaly).                                                               *)
(* ----------------------------------------------------------------------- *)

DeferRecord ==
  /\ ~crashed
  /\ phase = "arrived"
  /\ routeHit
  /\ DeferRequests > 0
  /\ phase' = "done"
  /\ store' = TRUE
  /\ resident' = TRUE
  /\ appliedLedger' = FALSE
  /\ hashLedger' = TRUE
  /\ surface' = surface
  /\ log' = log
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ sentCount' = sentCount
  /\ swapPending' = swapPending
  /\ crashed' = crashed

(* ----------------------------------------------------------------------- *)
(* Reducer (receipt) path: exactly one side-query attempt.                 *)
(* Rejection (lane failure, malformed, verify) => passthrough: the         *)
(* original bytes are preserved, nothing is stored, no marker.            *)
(* Verified receipt + mode on => store.put, receipt + marker, applied:true. *)
(* ----------------------------------------------------------------------- *)

ReducePath ==
  /\ ~crashed
  /\ phase = "arrived"
  /\ ~routeHit
  /\ phase' = "done"
  /\ IF verdictOk /\ ~DRY
       THEN /\ store' = TRUE
            /\ log' = Append(log, "apply")
            /\ surface' = "compressed"
            /\ appliedLedger' = TRUE
            /\ hashLedger' = TRUE
     ELSE IF verdictOk /\ DRY
            THEN /\ store' = store
                 /\ log' = log
                 /\ surface' = surface
                 /\ appliedLedger' = FALSE
                 /\ hashLedger' = hashLedger
            ELSE /\ store' = store
                 /\ log' = log
                 /\ surface' = surface
                 /\ appliedLedger' = appliedLedger
                 /\ hashLedger' = hashLedger
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ swapPending' = swapPending
  /\ crashed' = crashed

(* ----------------------------------------------------------------------- *)
(* Sends: each LLM request that includes the surface message counts once   *)
(* (first-chunk counting in the code).                                    *)
(* ----------------------------------------------------------------------- *)

Send ==
  /\ ~crashed
  /\ resident
  /\ surface = "full"
  /\ sentCount < 3
  /\ sentCount' = sentCount + 1
  /\ phase' = phase
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ surface' = surface
  /\ store' = store
  /\ resident' = resident
  /\ log' = log
  /\ appliedLedger' = appliedLedger
  /\ hashLedger' = hashLedger
  /\ swapPending' = swapPending
  /\ crashed' = crashed

(* The surface body is mutated (user edit / another tool touching the      *)
(* message) - the byte-equality staleness trigger for the swap.            *)

SurfaceMutate ==
  /\ ~crashed
  /\ surface = "full"
  /\ surface' = "mutated"
  /\ phase' = phase
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ store' = store
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ log' = log
  /\ appliedLedger' = appliedLedger
  /\ hashLedger' = hashLedger
  /\ swapPending' = swapPending
  /\ crashed' = crashed

(* ----------------------------------------------------------------------- *)
(* The pre-step swap (convention: the two session appends - prune then     *)
(* tool/result replace - are one atomic critical section with the          *)
(* staleness re-check).                                                    *)
(* Stale (surface no longer byte-equals): the resident is dropped          *)
(* WITHOUT appending.                                                      *)
(* Dry-run: evaluates but appends nothing; the resident stays.             *)
(* ----------------------------------------------------------------------- *)

SwapAttempt ==
  /\ ~crashed
  /\ ~CrashWindow
  /\ resident
  /\ phase = "done"
  /\ sentCount >= DeferRequests
  /\ IF surface # "full"
       THEN /\ resident' = FALSE
            /\ log' = log
            /\ surface' = surface
            /\ appliedLedger' = appliedLedger
            /\ swapPending' = swapPending
       ELSE IF DRY
            THEN /\ resident' = resident
                 /\ log' = log
                 /\ surface' = surface
                 /\ appliedLedger' = appliedLedger
                 /\ swapPending' = swapPending
            ELSE /\ log' = Append(Append(log, "prune"), "replace")
                 /\ surface' = "stub"
                 /\ resident' = FALSE
                 /\ appliedLedger' = TRUE
                 /\ swapPending' = swapPending
  /\ store' = store
  /\ phase' = phase
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ hashLedger' = hashLedger
  /\ sentCount' = sentCount
  /\ crashed' = crashed

(* ----------------------------------------------------------------------- *)
(* Strict probe (CrashWindow = TRUE): the two session appends are separate *)
(* steps with a crash possible between them - the orphan-prune window.     *)
(* ----------------------------------------------------------------------- *)

SwapPrune ==
  /\ ~crashed
  /\ CrashWindow
  /\ resident
  /\ phase = "done"
  /\ sentCount >= DeferRequests
  /\ ~DRY
  /\ surface = "full"
  /\ log' = Append(log, "prune")
  /\ swapPending' = TRUE
  /\ phase' = phase
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ surface' = surface
  /\ store' = store
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ appliedLedger' = appliedLedger
  /\ hashLedger' = hashLedger
  /\ crashed' = crashed

SwapReplace ==
  /\ ~crashed
  /\ swapPending
  /\ log' = Append(log, "replace")
  /\ surface' = "stub"
  /\ resident' = FALSE
  /\ appliedLedger' = TRUE
  /\ swapPending' = FALSE
  /\ phase' = phase
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ store' = store
  /\ sentCount' = sentCount
  /\ hashLedger' = hashLedger
  /\ crashed' = crashed

(* The process dies between the prune append and the replace append.       *)
(* Nothing compensates or replays the pair; the token meter has been        *)
(* debited for a node still present on the surface.                        *)

CrashBetween ==
  /\ CrashWindow
  /\ swapPending
  /\ crashed' = TRUE
  /\ swapPending' = FALSE
  /\ phase' = phase
  /\ routeHit' = routeHit
  /\ verdictOk' = verdictOk
  /\ surface' = surface
  /\ store' = store
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ log' = log
  /\ appliedLedger' = appliedLedger
  /\ hashLedger' = hashLedger

(* ----------------------------------------------------------------------- *)
(* Strict probe (HostDoubleFire = TRUE): the host re-fires                 *)
(* tools/post-execute for an already-crushed result. There is no            *)
(* already-has-a-marker check in crush(); reprocessing appends a second    *)
(* marker for the same result.                                            *)
(* ----------------------------------------------------------------------- *)

Refire ==
  /\ ~crashed
  /\ HostDoubleFire
  /\ phase = "done"
  /\ MarkerCount >= 1
  /\ phase' = "arrived"
  /\ surface' = surface
  /\ \E hit \in BOOLEAN : routeHit' = hit
  /\ \E ok \in BOOLEAN : verdictOk' = ok
  /\ store' = store
  /\ resident' = resident
  /\ sentCount' = sentCount
  /\ log' = log
  /\ appliedLedger' = appliedLedger
  /\ hashLedger' = hashLedger
  /\ swapPending' = swapPending
  /\ crashed' = crashed

Idle == UNCHANGED vars

Next ==
  \/ Arrive
  \/ ApplyDeterministic
  \/ DeferRecord
  \/ ReducePath
  \/ Send
  \/ SurfaceMutate
  \/ SwapAttempt
  \/ SwapPrune
  \/ SwapReplace
  \/ CrashBetween
  \/ Refire
  \/ Idle

Spec == Init /\ [][Next]_vars

(* ----------------------------------------------------------------------- *)
(* Invariants                                                               *)
(* ----------------------------------------------------------------------- *)

(* S-1: every prune append is immediately followed by its replace append   *)
(* (the paired swap contract; swap.ts appends adjacently with no await).   *)
PrunePositions == {i \in 1..Len(log) : log[i] = "prune"}

PrunePaired ==
  \A i \in PrunePositions : i < Len(log) /\ log[i+1] = "replace"

(* S-2: any marker (compressed/stub surface or an apply/replace log tag)   *)
(* implies the original was persisted to the store first.                  *)
StoreBeforeReference ==
  (MarkerCount > 0 \/ surface \in {"compressed", "stub"}) => store

(* S-3: an applied:true ledger row always corresponds to a session         *)
(* append that carries a marker.                                           *)
AppliedImpliesMarker ==
  appliedLedger => (MarkerCount >= 1 \/ surface \in {"compressed", "stub"})

(* S-4: dry-run never appends to the session and never stubs the surface.  *)
DryRunNoAppend ==
  DRY => (MarkerCount = 0 /\ surface \notin {"compressed", "stub"}
          /\ PrunePositions = {})

(* S-5: one tool result carries at most one marker (foldCounters ground     *)
(* truth; violated by the double-fire probe).                              *)
SingleMarkerPerResult == MarkerCount <= 1

=============================================================================
