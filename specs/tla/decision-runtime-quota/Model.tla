---- MODULE Model ----
(***************************************************************************)
(* SystemOne decision runtime quota ledger (S1-02): reserve/dispatch/settle *)
(* durability, the short transaction lock, crash recovery, 429 retries and *)
(* the no-free-quota contract. Behavioral source:                           *)
(* docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md.         *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MAX_IN, MAX_OUT, MAX_ATTEMPTS, MAX_RETRIES,
          StealLock,      (* probe: acquire ignores mutual exclusion        *)
          AdoptTorn,      (* probe: recovery keeps using a torn ledger      *)
          RefundUnpaired, (* probe: recovery deletes unpaired reserve rows *)
          ConflictingSettle, (* probe: a second, different terminal settle  *)
          FreezeRowLost,  (* probe: the freeze row is not persisted and the *)
                         (* lock file is not kept                           *)
          ClearWithoutFreeze (* probe: the human clears the lock without   *)
                            (* durably establishing the freeze            *)

PROCS == {"p1", "p2"}
DID == 1..4
ATT == 1..2
UnivK == {k \in {<<d,a>> : d \in DID, a \in ATT} : TRUE}

PHASE == {"idle", "want-lock", "locked", "checked", "rejected",
          "dispatching", "awaiting", "retrywait", "settling", "done"}

VARIABLES led, seqN, didN, torn, lock, lockFile, frozen, freezeSeq,
          runs, alive, plannedTerm, settleFailed

vars == <<led, seqN, didN, torn, lock, lockFile, frozen, freezeSeq,
          runs, alive, plannedTerm, settleFailed>>

EmptyRun == [phase |-> "idle", did |-> 0, att |-> 0, rin |-> 0, rout |-> 0,
             ain |-> 0, aout |-> 0, outcome |-> "none", last |-> "none"]

Init == /\ led = {}
        /\ seqN = 1
        /\ didN = 0
        /\ torn = FALSE
        /\ lock = "none"
        /\ lockFile = FALSE
        /\ frozen = FALSE
        /\ freezeSeq = 0
        /\ runs = [p \in PROCS |-> EmptyRun]
        /\ alive = TRUE
        /\ plannedTerm = [p \in PROCS |-> "none"]
        /\ settleFailed = FALSE

(************************************** ledger projections *****************)

RowsOf(kind, k) == {r \in led :
                     r.kind = kind /\ r.did = k[1] /\ r.att = k[2]}

HasReserve(k) == RowsOf("reserve", k) # {}
HasDispatch(k) == RowsOf("dispatch", k) # {}
HasSettled(k) == RowsOf("settled", k) # {}

ReserveRow(k) == CHOOSE r \in RowsOf("reserve", k) : TRUE
SettledRow(k) == CHOOSE r \in RowsOf("settled", k) : TRUE

AttemptKeys == {<<r.did, r.att>> : r \in {x \in led : x.kind = "reserve"}}

RetInK[k \in UnivK] ==
  IF ~HasReserve(k) THEN 0
  ELSE IF ~HasSettled(k) THEN ReserveRow(k).rin
  ELSE IF SettledRow(k).term = "actual" THEN SettledRow(k).ain
  ELSE IF SettledRow(k).term = "unknown" THEN ReserveRow(k).rin
  ELSE 0

RetOutK[k \in UnivK] ==
  IF ~HasReserve(k) THEN 0
  ELSE IF ~HasSettled(k) THEN ReserveRow(k).rout
  ELSE IF SettledRow(k).term = "actual" THEN SettledRow(k).aout
  ELSE IF SettledRow(k).term = "unknown" THEN ReserveRow(k).rout
  ELSE 0

RECURSIVE RecSumIn(_), RecSumOut(_)

RecSumIn(T) == IF T = {} THEN 0
               ELSE LET e == CHOOSE x \in T : TRUE
                IN RetInK[e] + RecSumIn(T \ {e})

RecSumOut(T) == IF T = {} THEN 0
                ELSE LET e == CHOOSE x \in T : TRUE
                 IN RetOutK[e] + RecSumOut(T \ {e})

RetainedIn == RecSumIn(AttemptKeys)
RetainedOut == RecSumOut(AttemptKeys)
RefundedAttempt(d, a) ==
  \E r \in led : r.kind = "settled" /\ r.did = d /\ r.att = a /\
                  r.term = "not-dispatched"

(* Only attempts that entered fetch count (429 included); a not-dispatched  *)
(* refund released before dispatch does not count as a call.               *)
AttemptsUsed ==
  Cardinality({r \in led : r.kind = "reserve" /\
                ~RefundedAttempt(r.did, r.att)})

(************************************** actions ****************************)

AddRow(row) == led' = led \union {row}

Request(p) ==
  /\ alive
  /\ runs[p].phase = "idle"
  /\ didN < 4
  /\ didN' = didN + 1
  /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
         !.phase = "want-lock", !.did = didN + 1, !.att = 1,
         !.rin = 2, !.rout = 1, !.outcome = "none", !.last = "none"]]
  /\ UNCHANGED <<led, seqN, torn, lock, lockFile, frozen, freezeSeq,
                  alive, plannedTerm, settleFailed>>

Acquire(p) ==
  /\ alive
  /\ runs[p].phase = "want-lock"
  /\ (lock = "none" \/ StealLock)
  /\ (~lockFile \/ StealLock)
  /\ lock' = p
  /\ lockFile' = TRUE
  /\ runs' = [runs EXCEPT ![p].phase = "locked"]
  /\ UNCHANGED <<led, seqN, didN, torn, frozen, freezeSeq, alive,
                  plannedTerm, settleFailed>>

(* Check limits while holding the lock. The plan is in-memory only until   *)
(* AppendReserve; mutual exclusion is what makes check-then-append safe.  *)
CheckReserve(p) ==
  /\ alive
  /\ runs[p].phase = "locked"
  /\ lock = p
  /\ IF frozen \/ torn
       THEN /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "rejected", !.outcome = "budget"]]
            /\ lock' = "none"
            /\ lockFile' = FALSE
            /\ UNCHANGED <<led, seqN, didN, frozen, freezeSeq, alive,
                            plannedTerm, torn, settleFailed>>
     ELSE IF RetainedIn + runs[p].rin > MAX_IN
       \/ RetainedOut + runs[p].rout > MAX_OUT
       \/ AttemptsUsed >= MAX_ATTEMPTS
       THEN /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "rejected", !.outcome = "budget"]]
            /\ lock' = "none"
            /\ lockFile' = FALSE
            /\ UNCHANGED <<led, seqN, didN, frozen, freezeSeq, alive,
                            plannedTerm, torn, settleFailed>>
     ELSE /\ runs' = [runs EXCEPT ![p].phase = "checked"]
          /\ UNCHANGED <<led, seqN, didN, torn, lock, lockFile, frozen,
                          freezeSeq, alive, plannedTerm, settleFailed>>

AppendReserve(p) ==
  /\ alive
  /\ runs[p].phase = "checked"
  /\ (lock = p \/ StealLock)
  /\ AddRow([seq |-> seqN, kind |-> "reserve", did |-> runs[p].did,
             att |-> runs[p].att, rin |-> runs[p].rin,
             rout |-> runs[p].rout, term |-> "none",
             ain |-> 0, aout |-> 0])
  /\ seqN' = seqN + 1
  /\ lock' = "none"
  /\ lockFile' = FALSE
  /\ runs' = [runs EXCEPT ![p].phase = "dispatching"]
  /\ UNCHANGED <<didN, torn, frozen, freezeSeq, alive, plannedTerm, settleFailed>>

(* The dispatch-record persist is its own short transaction: acquire,   *)
(* append, release — the lock covers the append.                          *)
DispatchAcquire(p) ==
  /\ alive
  /\ runs[p].phase = "dispatching"
  /\ lock = "none"
  /\ ~lockFile
  /\ lock' = p
  /\ lockFile' = TRUE
  /\ UNCHANGED <<led, seqN, didN, torn, frozen, freezeSeq, runs, alive,
                  plannedTerm, settleFailed>>

WriteDispatchFail(p) ==
  /\ alive
  /\ lock = p
  /\ runs[p].phase = "dispatching"
  /\ AddRow([seq |-> seqN, kind |-> "settled", did |-> runs[p].did,
             att |-> runs[p].att, rin |-> runs[p].rin,
             rout |-> runs[p].rout, term |-> "not-dispatched",
             ain |-> 0, aout |-> 0])
  /\ seqN' = seqN + 1
  /\ lock' = "none"
  /\ lockFile' = FALSE
  /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
         !.phase = "done", !.outcome = "error"]]
  /\ UNCHANGED <<didN, torn, frozen, freezeSeq,
                  alive, plannedTerm, settleFailed>>

WriteDispatchOk(p) ==
  /\ alive
  /\ lock = p
  /\ ~frozen
  /\ runs[p].phase = "dispatching"
  /\ AddRow([seq |-> seqN, kind |-> "dispatch", did |-> runs[p].did,
             att |-> runs[p].att, rin |-> runs[p].rin,
             rout |-> runs[p].rout, term |-> "none",
             ain |-> 0, aout |-> 0])
  /\ seqN' = seqN + 1
  /\ lock' = "none"
  /\ lockFile' = FALSE
  /\ runs' = [runs EXCEPT ![p].phase = "awaiting"]
  /\ UNCHANGED <<didN, torn, frozen, freezeSeq,
                  alive, plannedTerm, settleFailed>>

(* Fetch outcome: valid usage with an ok or malformed answer, a 429, a    *)
(* timeout, or another HTTP error. Only 429 may retry.                    *)
Fetch(p) ==
  /\ alive
  /\ runs[p].phase = "awaiting"
  /\ \/ /\ plannedTerm' = [plannedTerm EXCEPT ![p] = "actual"]
        /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "settling", !.ain = 2, !.aout = 1]]
     \/ /\ plannedTerm' = [plannedTerm EXCEPT ![p] = "unknown"]
        /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "settling", !.last = "timeout"]]
     \/ /\ plannedTerm' = [plannedTerm EXCEPT ![p] = "unknown"]
        /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "settling", !.last = "four29"]]
  /\ UNCHANGED <<led, seqN, didN, torn, lock, lockFile, frozen, freezeSeq,
                  alive, settleFailed>>

Retry(p) ==
  /\ alive
  /\ runs[p].phase = "done"
  /\ runs[p].last = "four29"
  /\ runs[p].att + 1 <= 1 + MAX_RETRIES
  /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
         !.phase = "want-lock", !.att = runs[p].att + 1, !.last = "none"]]
  /\ UNCHANGED <<led, seqN, didN, torn, lock, lockFile, frozen, freezeSeq,
                  alive, plannedTerm, settleFailed>>

(* The settle callback also runs inside its own short transaction.       *)
SettleAcquire(p) ==
  /\ alive
  /\ runs[p].phase = "settling"
  /\ lock = "none"
  /\ ~lockFile
  /\ lock' = p
  /\ lockFile' = TRUE
  /\ UNCHANGED <<led, seqN, didN, torn, frozen, freezeSeq, runs, alive,
                  plannedTerm, settleFailed>>

SettleWrite(p) ==
  /\ alive
  /\ lock = p
  /\ runs[p].phase = "settling"
  /\ \/ /\ plannedTerm[p] = "actual"
        /\ AddRow([seq |-> seqN, kind |-> "settled", did |-> runs[p].did,
                   att |-> runs[p].att, rin |-> runs[p].rin,
                   rout |-> runs[p].rout, term |-> "actual",
                   ain |-> runs[p].ain, aout |-> runs[p].aout])
        /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "done", !.outcome = "answered"]]
     \/ /\ plannedTerm[p] = "unknown"
        /\ AddRow([seq |-> seqN, kind |-> "settled", did |-> runs[p].did,
                   att |-> runs[p].att, rin |-> runs[p].rin,
                   rout |-> runs[p].rout, term |-> "unknown",
                   ain |-> 0, aout |-> 0])
        /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
                !.phase = "done", !.outcome = "unavailable"]]
  /\ seqN' = seqN + 1
  /\ lock' = "none"
  /\ lockFile' = FALSE
  /\ plannedTerm' = [plannedTerm EXCEPT ![p] = "none"]
  /\ UNCHANGED <<didN, torn, frozen, freezeSeq, alive, settleFailed>>

(* Probe-only: a second, conflicting terminal settle for an already        *)
(* settled attempt (violates the single-settlement rule; convention runs    *)
(* never take it).                                                         *)
ConflictingWrite(p, k) ==
  /\ alive
  /\ lock = "none"
  /\ ~lockFile
  /\ ConflictingSettle
  /\ runs[p].phase = "settling"
  /\ HasSettled(k)
  /\ SettledRow(k).term # plannedTerm[p]
  /\ AddRow([seq |-> seqN, kind |-> "settled", did |-> k[1], att |-> k[2],
             rin |-> ReserveRow(k).rin, rout |-> ReserveRow(k).rout,
             term |-> plannedTerm[p], ain |-> runs[p].ain,
             aout |-> runs[p].aout])
  /\ seqN' = seqN + 1
  /\ UNCHANGED <<didN, torn, lock, lockFile, frozen, freezeSeq, runs,
                  alive, plannedTerm, settleFailed>>

(* The settle callback throws: the permit keeps its durable reserve, the  *)
(* quota freezes, and the run ends in error.                              *)
SettleFail(p) ==
  /\ alive
  /\ lock = p
  /\ runs[p].phase = "settling"
  /\ plannedTerm[p] # "none"
  /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
         !.phase = "done", !.outcome = "error"]]
  /\ IF FreezeRowLost
       THEN /\ frozen' = FALSE
            /\ lockFile' = TRUE
       ELSE /\ frozen' = TRUE
            /\ lockFile' = FALSE
  /\ freezeSeq' = seqN - 1
  /\ lock' = "none"
  /\ settleFailed' = TRUE
  /\ UNCHANGED <<led, seqN, didN, torn, alive, plannedTerm>>

(* Caller abort before dispatch: refund (not-dispatched).                 *)
AbortBefore(p) ==
  /\ alive
  /\ lock = p
  /\ runs[p].phase = "dispatching"
  /\ AddRow([seq |-> seqN, kind |-> "settled", did |-> runs[p].did,
             att |-> runs[p].att, rin |-> runs[p].rin,
             rout |-> runs[p].rout, term |-> "not-dispatched",
             ain |-> 0, aout |-> 0])
  /\ seqN' = seqN + 1
  /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
         !.phase = "done", !.outcome = "cancelled"]]
  /\ lock' = "none"
  /\ lockFile' = FALSE
  /\ UNCHANGED <<didN, torn, frozen, freezeSeq, alive, plannedTerm, settleFailed>>

(* Caller abort after dispatch: no refund; the finally supplements an     *)
(* unknown settle.                                                        *)
AbortAfter(p) ==
  /\ alive
  /\ runs[p].phase = "awaiting"
  /\ plannedTerm' = [plannedTerm EXCEPT ![p] = "unknown"]
  /\ runs' = [runs EXCEPT ![p] = [runs[p] EXCEPT
         !.phase = "settling", !.outcome = "cancelled"]]
  /\ UNCHANGED <<led, seqN, didN, torn, lock, lockFile, frozen, freezeSeq,
                  alive, settleFailed>>

(* Crash: in-memory state is lost; a crash while holding the lock leaves  *)
(* the lock file behind; a crash mid settle-append can tear the line.     *)
Crash ==
  /\ alive
  /\ alive' = FALSE
  /\ lock' = "none"
  /\ torn' = (torn \/ (\E p \in PROCS : runs[p].phase = "settling"))
  /\ runs' = [p \in PROCS |-> EmptyRun]
  /\ plannedTerm' = [p \in PROCS |-> "none"]
  /\ lockFile' = (lockFile \/ (lock # "none"))
  /\ UNCHANGED <<led, seqN, didN, frozen, freezeSeq, settleFailed>>

(* Restart: read the ledger. A torn tail freezes (unless the probe adopts *)
(* it); unpaired reserves keep their full amount (unless the probe        *)
(* refunds them). The lock file is never deleted automatically.          *)
Recover ==
  /\ ~alive
  /\ alive' = TRUE
  /\ IF torn /\ ~AdoptTorn /\ ~frozen
       THEN /\ frozen' = TRUE
            /\ freezeSeq' = seqN - 1
       ELSE /\ frozen' = frozen
            /\ freezeSeq' = freezeSeq
  /\ led' = IF RefundUnpaired
              THEN {r \in led :
                     r.kind # "reserve"
                     \/ HasSettled(<<r.did, r.att>>)}
              ELSE led
  /\ UNCHANGED <<seqN, didN, torn, runs, lock, lockFile, plannedTerm, settleFailed>>

(* Clearing the lock after a settle failure must durably establish the    *)
(* freeze first (append the freeze row) - a bare removal would leave the   *)
(* ledger indistinguishable from an ordinary unpaired reservation.         *)
HumanClearLock ==
  /\ lock = "none"
  /\ lockFile
  /\ lockFile' = FALSE
  /\ frozen' = IF ClearWithoutFreeze THEN frozen ELSE (frozen \/ settleFailed)
  /\ UNCHANGED <<led, seqN, didN, torn, lock, freezeSeq, runs,
                  alive, plannedTerm, settleFailed>>

(* Quiescent stutter after a crash, so CHECK_DEADLOCK stays meaningful.   *)
Idle == /\ ~alive
        /\ UNCHANGED <<led, seqN, didN, torn, lock, lockFile, frozen,
                       freezeSeq, runs, alive, plannedTerm, settleFailed>>

Next == \/ \E p \in PROCS :
            Request(p) \/ Acquire(p) \/ CheckReserve(p) \/
            AppendReserve(p) \/ DispatchAcquire(p) \/
            WriteDispatchOk(p) \/ WriteDispatchFail(p) \/ Fetch(p) \/
            Retry(p) \/ SettleAcquire(p) \/
            SettleWrite(p) \/ SettleFail(p) \/
            AbortBefore(p) \/ AbortAfter(p)
        \/ \E p \in PROCS, k \in AttemptKeys : ConflictingWrite(p, k)
        \/ Crash \/ Recover \/ HumanClearLock \/ Idle

Spec == Init /\ [][Next]_vars

(************************************** invariants *************************)

TypeOK ==
  /\ settleFailed \in BOOLEAN
  /\ IsFiniteSet(led)
  /\ seqN \in Nat
  /\ didN \in 0..4
  /\ torn \in BOOLEAN
  /\ lock \in PROCS \union {"none"}
  /\ lockFile \in BOOLEAN
  /\ frozen \in BOOLEAN
  /\ freezeSeq \in Nat
  /\ alive \in BOOLEAN
  /\ \A p \in PROCS : runs[p].phase \in PHASE

(* Attempts never exceed the configured quota.                             *)
QuotaAttempts == AttemptsUsed <= MAX_ATTEMPTS

(* A settle failure always leaves a durable blocking mechanism: either the *)
(* persisted freeze row or the kept lock file (quota-lock-unavailable).     *)
FreezeSurvivesSettleFailure == settleFailed => (frozen \/ lockFile)

QuotaIn == RetainedIn <= MAX_IN
QuotaOut == RetainedOut <= MAX_OUT

(* Each attempt is settled at most once (single-invocation settlement).   *)
SettleAtMostOnce ==
  \A k \in UnivK : Cardinality(RowsOf("settled", k)) <= 1

(* A dispatch row always follows a durable reserve row for the same       *)
(* attempt.                                                                *)
DispatchAfterReserve ==
  \A r \in {x \in led : x.kind = "dispatch"} :
    \E s \in {y \in led : y.kind = "reserve"} :
      s.did = r.did /\ s.att = r.att /\ s.seq < r.seq

(* A not-dispatched terminal never coexists with a dispatch row: a        *)
(* dispatched attempt can never be refunded as not-dispatched.           *)
NotDispNoDispatch ==
  \A r \in {x \in led : x.kind = "settled" /\ x.term = "not-dispatched"} :
    ~HasDispatch(<<r.did, r.att>>)

(* Unsettled attempts retain their full reservation: no recovery path     *)
(* frees quota that a possibly-dispatched attempt still owes.            *)
UnsettledKeepsFull ==
  \A k \in AttemptKeys :
    ~HasSettled(k) =>
      RetInK[k] = ReserveRow(k).rin /\ RetOutK[k] = ReserveRow(k).rout

(* An attempt with a durable dispatch row and no terminal keeps the full  *)
(* reservation even after crash+recovery (no free quota).                  *)
NoFreeDispatched ==
  \A k \in AttemptKeys :
    (HasDispatch(k) /\ ~HasSettled(k)) =>
      RetInK[k] = ReserveRow(k).rin /\ RetOutK[k] = ReserveRow(k).rout

(* A torn tail freezes the quota once the process is running again: the  *)
(* freeze is a recovery-time decision, not a crash-time one.             *)
TornImpliesFrozen == (alive /\ torn) => frozen

(* Once frozen, no new spend (reserve or dispatch row) is appended;      *)
(* settling already-reserved attempts remains legitimate bookkeeping.    *)
FrozenStopsAppends ==
  frozen => \A r \in {x \in led :
                       x.kind = "reserve" \/ x.kind = "dispatch"} :
             r.seq <= freezeSeq

(* Retries are bounded and contiguous per decision.                       *)
AttemptsBound ==
  \A d \in DID : Cardinality({r \in led :
                                r.kind = "reserve" /\ r.did = d})
                  <= 1 + MAX_RETRIES

(* The in-memory lock owner exists only while the owning process lives;   *)
(* a crash clears the owner but never the on-disk lock file.              *)
LockOwnerAlive == (lock # "none") => alive
 ============================================================================
