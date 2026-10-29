-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* vwa-argument review cycle pipeline: budget-lock admission, cycle         *)
(* identity, idempotent requestId replay, per-run retry pool, per-target  *)
(* continuation reuse, read-time restart coercion. Faithful abstraction   *)
(* of packages/interaction/vwa-argument/src/review-cycle.ts               *)
(* (reserveCycleRequest / reserveCycleCall / withBudgetLock),             *)
(* lock.ts (acquireLock / reclaim / release), review-run-store.ts         *)
(* (reserveRequest / loadRequest restart rule / writeAtomic),             *)
(* review-runner.ts (admission, batch, finish) and review-call.ts        *)
(* (retry pool charge/earn/refund). See design.md for the mapping.        *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT MaxCalls, RetryAllowance, MaxHeadRev, ProjectBudget, AdmissionEstimate,
         EnforcePerCall

ASSUME /\ MaxCalls \in 1..4
       /\ RetryAllowance \in 0..2
       /\ MaxHeadRev \in 0..2
       /\ ProjectBudget \in 1..4
       /\ AdmissionEstimate \in 1..2
       /\ EnforcePerCall \in BOOLEAN

(* Bounded universes. *)
Procs    == {"p1", "p2"}
Targets  == {"t1", "t2"}
Runs     == {"r1", "r2"}
Reqs     == {"q1", "q2"}
Payloads == {"h1", "h2"}

Modes    == {"fresh", "continue"}
Statuses == {"queued", "running", "completed", "incomplete",
             "cancelled", "budget-exhausted"}
Kinds    == {"none", "prep", "run", "call", "retry"}

RunType ==
  [ req:         {"none"} \cup Reqs
  , payload:     Payloads
  , status:      {"none"} \cup Statuses
  , cycle:       {"none"} \cup Runs
  , owner:       {"none"} \cup Procs
  , pool:        0..RetryAllowance
  , retryEarned: 0..RetryAllowance
  , reserved:    0..6
  , dispatched:  0..6
  , records:     SUBSET Targets
  , dis:         SUBSET Targets
  , reused:      SUBSET Targets
  , mode:        Modes ]

PendType ==
  [ kind:    Kinds
  , req:     {"none"} \cup Reqs
  , payload: Payloads
  , mode:    Modes
  , snap:    0..MaxHeadRev
  , run:     {"none"} \cup Runs
  , target:  {"none"} \cup Targets ]

VARIABLES alive, lockHolder, lockBody, headRev, runs, reqMap,
          latestCycle, pend, loadStatus

vars == <<alive, lockHolder, lockBody, headRev, runs, reqMap,
          latestCycle, pend, loadStatus>>

EmptyRun == [req |-> "none", payload |-> "h1", status |-> "none", cycle |-> "none",
             owner |-> "none", pool |-> 0, retryEarned |-> 0, reserved |-> 0,
             dispatched |-> 0, records |-> {}, dis |-> {}, reused |-> {},
             mode |-> "fresh"]

PendNone == [kind |-> "none", req |-> "none", payload |-> "h1", mode |-> "fresh",
             snap |-> 0, run |-> "none", target |-> "none"]

Init ==
  /\ alive = [p \in Procs |-> TRUE]
  /\ lockHolder = "none"
  /\ lockBody = FALSE
  /\ headRev = 0
  /\ runs = [r \in Runs |-> EmptyRun]
  /\ reqMap = [q \in Reqs |-> "none"]
  /\ latestCycle = "none"
  /\ pend = [p \in Procs |-> PendNone]
  /\ loadStatus = "none"

(***************************************************************************)
(* Helpers                                                                  *)
(***************************************************************************)

(* Durable cycle spend: reserved usage rows of every run in the cycle,     *)
(* including runs whose owner crashed (review-cycle.ts cycleUsage).        *)
CycleSpend(c) ==
  (IF runs["r1"].cycle = c THEN runs["r1"].reserved ELSE 0)
  + (IF runs["r2"].cycle = c THEN runs["r2"].reserved ELSE 0)

(* Durable project spend: every cycle's reserved usage rows, i.e. the      *)
(* whole project ledger (design §5.1 projectUsage over all review-runs,    *)
(* not filtered by cycle). Conservative across crashes: rows persist.      *)
ProjectSpend == CycleSpend("r1") + CycleSpend("r2")

(* A target has a reusable completed record: present in some admitted     *)(* run's records and not a disagreement copy (review-continue.ts           *)
(* reusableRecord). Cache-key equality is abstracted to target identity.  *)
ReusableFrom(t) ==
  \E r \in Runs :
    /\ runs[r].status \in Statuses
    /\ t \in runs[r].records
    /\ t \notin runs[r].dis

OutstandingCharge(r) ==
  IF \E p \in Procs : pend[p].kind = "retry" /\ pend[p].run = r
  THEN 1 ELSE 0

(***************************************************************************)
(* Graph-side commit that can invalidate a budget snapshot between        *)
(* readHead and reservation (store.ts commit; REVISION_CONFLICT).         *)
(***************************************************************************)
CommitHead ==
  /\ headRev < MaxHeadRev
  /\ headRev' = headRev + 1
  /\ UNCHANGED <<alive, lockHolder, lockBody, runs, reqMap, latestCycle,
                 pend, loadStatus>>

(***************************************************************************)
(* Admission: prepare (snapshot) -> lock create -> lock body -> release.   *)
(* The lock create/write window is exposed so a crash can leave a torn     *)
(* lock file (lock.ts openSync 'wx' then writeSync).                       *)
(***************************************************************************)

Prepare(p, q, h, m) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ h = "h1" \/ reqMap[q] /= "none"
  /\ pend' = [pend EXCEPT ![p] =
      [kind |-> "prep", req |-> q, payload |-> h, mode |-> m,
       snap |-> headRev, run |-> "none", target |-> "none"]]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, runs, reqMap,
                 latestCycle, loadStatus>>

(* Acquire: free, or reclaim the file of a confirmed-dead holder          *)
(* (lock.ts:79-84). A torn file is NOT reclaimable: LOCK_BUSY.            *)
LockCreate(p) ==
  /\ alive[p]
  /\ pend[p].kind = "prep"
  /\ lockHolder \in ({"none"} \cup {d \in Procs : ~alive[d]})
  /\ lockHolder' = p
  /\ lockBody' = FALSE
  /\ UNCHANGED <<alive, headRev, runs, reqMap, latestCycle, pend,
                 loadStatus>>

AdmissionBusy(p) ==
  /\ alive[p]
  /\ pend[p].kind = "prep"
  /\ lockHolder = "torn"
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, runs, reqMap,
                 latestCycle, loadStatus>>

(* Admission body under the budget lock; always releases (review-cycle.ts *)
(* reserveCycleRequest). prior.cycleId wins on replay of the same runId   *)
(* is not modeled as a separate action: no action ever rewrites the       *)
(* cycleId of an admitted run.                                            *)
AdmissionBody(p, k) ==
  /\ alive[p]
  /\ pend[p].kind = "prep"
  /\ lockHolder = p
  /\ runs[k].status = "none"
  /\ lockHolder' = "none"
  /\ lockBody' = FALSE
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<alive, headRev, loadStatus>>
  /\ IF reqMap[pend[p].req] /= "none"
     THEN (* idempotent replay: same requestId returns the existing run *)
       /\ runs' = runs
       /\ reqMap' = reqMap
       /\ latestCycle' = latestCycle
       /\ IF runs[reqMap[pend[p].req]].payload /= pend[p].payload
          THEN (* IDEMPOTENCY_CONFLICT: fail-stop, no run created *)
            UNCHANGED vars
          ELSE (* replay returns the existing run; no new run *)
            UNCHANGED vars
     ELSE IF pend[p].mode = "fresh"
       THEN IF pend[p].snap /= headRev
            THEN (* REVISION_CONFLICT: retryable, no run created *)
              /\ runs' = runs
              /\ reqMap' = reqMap
              /\ latestCycle' = latestCycle
            ELSE IF ProjectSpend + AdmissionEstimate > ProjectBudget
              THEN (* PROJECT_BUDGET_EXHAUSTED: admission refuses the fresh
                      request before any cycle reservation (design §5.1; the
                      check sits inside the same budget lock). *)
                /\ runs' = runs
                /\ reqMap' = reqMap
                /\ latestCycle' = latestCycle
            ELSE
              /\ runs' = [runs EXCEPT ![k] =
                  [EmptyRun EXCEPT !.req = pend[p].req,
                                  !.payload = pend[p].payload,
                                  !.status = "queued", !.cycle = k,
                                  !.owner = "none", !.pool = RetryAllowance,
                                  !.retryEarned = 0, !.reserved = 0,
                                  !.dispatched = 0, !.records = {},
                                  !.dis = {}, !.reused = {},
                                  !.mode = "fresh"]]
              /\ reqMap' = [reqMap EXCEPT ![pend[p].req] = k]
              /\ latestCycle' = k
       ELSE IF latestCycle = "none"
         THEN (* no admitted cycle to continue: refuse *)
           /\ runs' = runs
           /\ reqMap' = reqMap
           /\ latestCycle' = latestCycle
         ELSE IF \A t \in Targets : ReusableFrom(t)
           THEN (* NOTHING_TO_CONTINUE: every target reusable *)
             /\ runs' = runs
             /\ reqMap' = reqMap
             /\ latestCycle' = latestCycle
           ELSE
             /\ runs' = [runs EXCEPT ![k] =
                 [EmptyRun EXCEPT !.req = pend[p].req,
                                 !.payload = pend[p].payload,
                                 !.status = "queued",
                                 !.cycle = latestCycle,
                                 !.owner = "none", !.pool = RetryAllowance,
                                 !.retryEarned = 0, !.reserved = 0,
                                 !.dispatched = 0, !.records = {},
                                 !.dis = {}, !.reused = {},
                                 !.mode = "continue"]]
             /\ reqMap' = [reqMap EXCEPT ![pend[p].req] = k]
             /\ latestCycle' = latestCycle

(* The host schedules the runner; the runner re-stamps its owner and       *)
(* moves queued -> running (review-runner.ts:86-101).                      *)
StartRun(p, k) ==
  /\ alive[p]
  /\ pend[p].kind = "none"
  /\ runs[k].status = "queued"
  /\ runs[k].owner = "none"
  /\ runs' = [runs EXCEPT ![k] =
      [runs[k] EXCEPT !.status = "running", !.owner = p]]
  /\ pend' = [pend EXCEPT ![p] = [kind |-> "run", req |-> "none", payload |-> "h1", mode |-> "fresh", snap |-> 0, run |-> k, target |-> "none"]]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(***************************************************************************)
(* Model-call reservation: the budget check and the durable reserved      *)
(* usage row happen inside the same lock (review-cycle.ts:258-274,        *)
(* review-call.ts:129-147). Crash between reservation and dispatch is     *)
(* modeled by the gap between ReserveCall and DispatchOk.                  *)
(***************************************************************************)
ReserveCall(p, t) ==
  /\ alive[p]
  /\ pend[p].kind = "run"
  /\ runs[pend[p].run].status = "running"
  /\ t \notin runs[pend[p].run].records
  /\ IF (CycleSpend(runs[pend[p].run].cycle) + 1 > MaxCalls)
       \/ (EnforcePerCall /\ ProjectSpend + 1 > ProjectBudget)
     THEN (* in-run guard: budget-exhausted terminal; the second conjunct is
             the project-cumulative per-call projection check (design §5.1,
             reserveCycleCall inside the same lock). Disabled by
             EnforcePerCall=FALSE only in the documented fault probe. *)
       /\ runs' = [runs EXCEPT ![pend[p].run] =
           [runs[pend[p].run] EXCEPT !.status = "budget-exhausted"]]
       /\ pend' = [pend EXCEPT ![p] = PendNone]
     ELSE
       /\ runs' = [runs EXCEPT ![pend[p].run] =
           [runs[pend[p].run] EXCEPT
             !.reserved = runs[pend[p].run].reserved + 1]]
       /\ pend' = [pend EXCEPT ![p] = [kind |-> "call", req |-> "none", payload |-> "h1", mode |-> "fresh", snap |-> 0, run |-> pend[p].run, target |-> t]]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* A charged retry earns its unit only when it reserves and dispatches    *)
(* again (review-call.ts:201-209); budget refusal refunds it.             *)
RetryReserve(p) ==
  /\ alive[p]
  /\ pend[p].kind = "retry"
  /\ runs[pend[p].run].status = "running"
  /\ IF (CycleSpend(runs[pend[p].run].cycle) + 1 > MaxCalls)
       \/ (EnforcePerCall /\ ProjectSpend + 1 > ProjectBudget)
     THEN
       /\ runs' = [runs EXCEPT ![pend[p].run] =
           [runs[pend[p].run] EXCEPT
             !.pool = runs[pend[p].run].pool + 1,
             !.status = "budget-exhausted"]]
       /\ pend' = [pend EXCEPT ![p] = PendNone]
     ELSE
       /\ runs' = [runs EXCEPT ![pend[p].run] =
           [runs[pend[p].run] EXCEPT
             !.reserved = runs[pend[p].run].reserved + 1,
             !.retryEarned = runs[pend[p].run].retryEarned + 1]]
       /\ pend' = [pend EXCEPT ![p] = [kind |-> "call", req |-> "none", payload |-> "h1", mode |-> "fresh", snap |-> 0, run |-> pend[p].run, target |-> pend[p].target]]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* Dispatch outcome: a completed record persists immediately              *)
(* (review-runner.ts per-task save). A disagreement copy may also persist  *)
(* (review-run-store.ts:319-360); it is never reusable.                    *)
DispatchOk(p, isDis) ==
  /\ alive[p]
  /\ pend[p].kind = "call"
  /\ LET k == pend[p].run
         t == pend[p].target
         newRecs == runs[k].records \cup {t}
     IN
     /\ runs' = [runs EXCEPT ![k] =
         [runs[k] EXCEPT
           !.records = newRecs,
           !.dis = IF isDis THEN runs[k].dis \cup {t} ELSE runs[k].dis,
           !.dispatched = runs[k].dispatched + 1,
           !.status = IF newRecs = Targets THEN "completed"
                      ELSE runs[k].status]]
     /\ pend' = [pend EXCEPT ![p] =
         IF runs'[k].status = "completed" THEN PendNone
         ELSE [kind |-> "run", req |-> "none", payload |-> "h1", mode |-> "fresh", snap |-> 0, run |-> k, target |-> "none"]]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* Retryable failure: charge the shared pool unit; pool empty means        *)
(* REVIEW_RETRY_BUDGET -> incomplete (review-call.ts:204-209,              *)
(* review-runner.ts:436).                                                   *)
DispatchRetryFail(p) ==
  /\ alive[p]
  /\ pend[p].kind = "call"
  /\ LET k == pend[p].run
         retryable == runs[k].pool > 0
     IN
     /\ runs' = [runs EXCEPT ![k] =
         [runs[k] EXCEPT
           !.dispatched = runs[k].dispatched + 1,
           !.pool = IF retryable THEN runs[k].pool - 1 ELSE runs[k].pool,
           !.status = IF retryable THEN runs[k].status ELSE "incomplete"]]
     /\ pend' = [pend EXCEPT ![p] =
         IF retryable
         THEN [kind |-> "retry", req |-> "none", payload |-> "h1",
               mode |-> "fresh", snap |-> 0, run |-> k,
               target |-> pend[p].target]
         ELSE PendNone]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* Abort during backoff refunds the charged unit (review-call.ts:111,238). *)
RetryAbandon(p) ==
  /\ alive[p]
  /\ pend[p].kind = "retry"
  /\ runs' = [runs EXCEPT ![pend[p].run] =
      [runs[pend[p].run] EXCEPT
        !.pool = runs[pend[p].run].pool + 1,
        !.status = "cancelled"]]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

DispatchAbort(p) ==
  /\ alive[p]
  /\ pend[p].kind = "call"
  /\ runs' = [runs EXCEPT ![pend[p].run] =
      [runs[pend[p].run] EXCEPT
        !.status = "cancelled",
        !.dispatched = runs[pend[p].run].dispatched + 1]]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* Wall clock / post-run drift: terminal incomplete, partial results       *)
(* stay committed (review-runner.ts:251,479-485).                          *)
FinishIncomplete(p) ==
  /\ alive[p]
  /\ pend[p].kind = "run"
  /\ runs[pend[p].run].status = "running"
  /\ runs' = [runs EXCEPT ![pend[p].run] =
      [runs[pend[p].run] EXCEPT !.status = "incomplete"]]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* Continuation reuse: a reusable record for the target is copied under    *)
(* the current run without spending a call (review-runner.ts:323-336,     *)
(* continue mode only; default mode never reuses for a second opinion).   *)
ApplyReuse(p, t) ==
  /\ alive[p]
  /\ pend[p].kind = "run"
  /\ runs[pend[p].run].status = "running"
  /\ runs[pend[p].run].mode = "continue"
  /\ t \notin runs[pend[p].run].records
  /\ ReusableFrom(t)
  /\ LET newRecs == runs[pend[p].run].records \cup {t} IN
     runs' = [runs EXCEPT ![pend[p].run] =
       [runs[pend[p].run] EXCEPT
         !.records = newRecs,
         !.reused = runs[pend[p].run].reused \cup {t},
         !.status = IF newRecs = Targets THEN "completed"
                    ELSE runs[pend[p].run].status]]
  /\ pend' = [pend EXCEPT ![p] =
      IF runs'[pend[p].run].status = "completed" THEN PendNone
      ELSE [kind |-> "run", req |-> "none", payload |-> "h1", mode |-> "fresh", snap |-> 0, run |-> pend[p].run, target |-> "none"]]
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, reqMap, latestCycle,
                 loadStatus>>

(* Read-time restart rule: a persisted queued/running run whose owner is   *)
(* not alive is loaded as incomplete; nothing is written back             *)
(* (review-run-store.ts:124-157).                                          *)
LoadRequest(p, k) ==
  /\ alive[p]
  /\ runs[k].status /= "none"
  /\ LET owner == runs[k].owner
         ownerAlive == owner /= "none" /\ alive[owner]
         obs == IF runs[k].status \in {"queued", "running"}
                THEN "incomplete"
                ELSE runs[k].status
     IN
     /\ ~ownerAlive
     /\ loadStatus' = obs
  /\ UNCHANGED <<alive, lockHolder, lockBody, headRev, runs, reqMap,
                 latestCycle, pend>>

(* Crash: in-memory state is lost; every persisted file (request, records, *)
(* reserved usage rows) survives; a held lock stays held by the dead      *)
(* holder (reclaimable) -- unless the crash landed in the create window,   *)
(* which leaves a torn, unreclaimable lock file.                           *)
Crash(p) ==
  /\ alive[p]
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<lockHolder, lockBody, headRev, runs, reqMap, latestCycle,
                 loadStatus>>

CrashTorn(p) ==
  /\ alive[p]
  /\ lockHolder = p
  /\ ~lockBody
  /\ pend[p].kind = "prep"
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ lockHolder' = "torn"
  /\ pend' = [pend EXCEPT ![p] = PendNone]
  /\ UNCHANGED <<lockBody, headRev, runs, reqMap, latestCycle,
                 loadStatus>>

Idle == UNCHANGED vars

Next ==
  \/ CommitHead
  \/ \E p \in Procs :
       \/ \E q \in Reqs, h \in Payloads, m \in Modes : Prepare(p, q, h, m)
       \/ LockCreate(p)
       \/ AdmissionBusy(p)
       \/ \E k \in Runs : AdmissionBody(p, k)
       \/ \E k \in Runs : StartRun(p, k)
       \/ \E t \in Targets : ReserveCall(p, t)
       \/ \E t \in Targets : ApplyReuse(p, t)
       \/ RetryReserve(p)
       \/ \E d \in BOOLEAN : DispatchOk(p, d)
       \/ DispatchRetryFail(p)
       \/ DispatchAbort(p)
       \/ RetryAbandon(p)
       \/ FinishIncomplete(p)
       \/ \E k \in Runs : LoadRequest(p, k)
       \/ Crash(p)
       \/ CrashTorn(p)
  \/ Idle

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                               *)
(***************************************************************************)

(* S-9: the project-cumulative ledger never exceeds the project budget,   *)
(* across every cycle and including reserved rows of crashed runs         *)
(* (design §5.1 ProjectBudgetSound; enforced at fresh admission with the  *)
(* estimate and at every reservation with the per-call projection).       *)
ProjectBudgetSound ==
  ProjectSpend <= ProjectBudget

(* Probe: with the per-call project guard disabled (EnforcePerCall=FALSE)  *)
(* a run admitted under the project ceiling can still spend its whole      *)
(* cycle allowance, so the admission-time estimate alone does not bound    *)
(* the ledger -- the expected counterexample that justifies the in-lock    *)
(* per-call projection (codex r2 finding 11).                              *)

TypeOK ==
  /\ alive \in [Procs -> BOOLEAN]
  /\ lockHolder \in (({"none"} \cup Procs) \cup {"torn"})
  /\ lockBody \in BOOLEAN
  /\ headRev \in 0..MaxHeadRev
  /\ runs \in [Runs -> RunType]
  /\ reqMap \in [Reqs -> ({"none"} \cup Runs)]
  /\ latestCycle \in ({"none"} \cup Runs)
  /\ pend \in [Procs -> PendType]
  /\ loadStatus \in ({"none"} \cup Statuses)

(* S-2: the durable cycle ledger never exceeds the cycle budget.           *)
CycleBudgetSound ==
  \A r \in Runs :
    runs[r].status /= "none" => CycleSpend(runs[r].cycle) <= MaxCalls

(* S-3: charged pool units are either earned by a dispatch or still        *)
(* outstanding; refunds restore the pool (review-call.ts charge/refund).   *)
(* The pool is in-process state: a crashed owner loses its charge, so     *)
(* the ledger identity is only asserted for live owners.                    *)
RetryPoolSound ==
  \A r \in Runs :
    ( /\ runs[r].owner /= "none"
      /\ alive[runs[r].owner] ) =>
      /\ runs[r].pool >= 0
      /\ runs[r].retryEarned <= RetryAllowance
      /\ RetryAllowance - runs[r].pool
         = runs[r].retryEarned + OutstandingCharge(r)

(* S-4: one admitted run per requestId; the mapping is consistent.        *)
OneRunPerRequest ==
  /\ \A q \in Reqs :
       reqMap[q] /= "none" =>
         /\ runs[reqMap[q]].req = q
         /\ runs[reqMap[q]].status /= "none"
  /\ \A r1, r2 \in Runs :
       ( /\ runs[r1].status /= "none"
         /\ runs[r2].status /= "none"
         /\ runs[r1].req = runs[r2].req ) => r1 = r2

(* S-5: a load that observed a dead owner never reports queued/running      *)
DeadOwnerLoadIncomplete ==
  loadStatus /= "none" => loadStatus \notin {"queued", "running"}

(* S-6: reused targets only in continue mode, and a reusable record       *)
(* for the target existed at reuse time (records persist, so it still      *)
(* exists).                                                                *)
ContinuationSound ==
  \A r \in Runs : \A t \in runs[r].reused :
    /\ runs[r].mode = "continue"
    /\ \E r2 \in Runs :
         /\ runs[r2].status \in Statuses
         /\ t \in runs[r2].records
         /\ t \notin runs[r2].dis

(* S-7: default (non-continue) mode never reuses records.                  *)
DefaultModeNoReuse ==
  \A r \in Runs :
    runs[r].mode /= "continue" => runs[r].reused = {}

(* S-8: a live process only acts on a run it owns, and only while the      *)
(* run is running.                                                         *)
NoGhostDispatch ==
  \A p \in Procs :
    pend[p].kind \in {"run", "call", "retry"} =>
      /\ alive[p]
      /\ runs[pend[p].run].owner = p
      /\ runs[pend[p].run].status = "running"

(***************************************************************************)
(* Strict probes (expected counterexamples, documented behavior).          *)
(***************************************************************************)

(* Probe: a crash in the lock create window leaves a torn file that no    *)
(* acquirer reclaims (lock.ts:72-91) -- LOCK_BUSY until manual removal.   *)
LockNeverTorn == lockHolder /= "torn"

(* Probe: a crash between the durable reserved row and the settled        *)
(* attempt leaves the cycle charged for a call that never happened         *)
(* (conservative accounting, review-cycle.ts:247-256). `dispatched` counts  *)
(* settled attempts (ok / retryable failure / abort); an in-flight call   *)
(* still carried by a live process is NOT an overcount.                     *)
InFlight(r) ==
  IF \E p \in Procs : pend[p].kind = "call" /\ pend[p].run = r
  THEN 1 ELSE 0

ReservedSettledAccounting ==
  \A r \in Runs :
    runs[r].reserved = runs[r].dispatched + InFlight(r)

=============================================================================
(***************************************************************************)
(* Never used at runtime; keeps SANY quiet about unused ASSUME ranges.     *)
(***************************************************************************)
ToolchainFingerprint == <<MaxCalls, RetryAllowance, MaxHeadRev, ProjectBudget,
                         AdmissionEstimate, EnforcePerCall>>
