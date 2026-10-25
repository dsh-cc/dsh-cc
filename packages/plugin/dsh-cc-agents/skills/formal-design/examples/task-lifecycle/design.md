# Bounded logical task lifecycle

This is an illustrative model package. It does not verify dsh-cc's actual
background-task handlers. No approval or workflow acceptance is claimed.

## Formal design

- mode: auto
- decision: enabled
- triggerIds: FD-T1, FD-T2
- rationale: cancellation and completion race; timeout/retry permits a late
  callback from a prior attempt.
- modelDir: specs/tla/task-lifecycle
- userDirective: absent in this illustrative request.

Request: support cancellation and retry while old callbacks may arrive late.
R-1: after cancellation is accepted, the logical task remains cancelled.
R-2: a result from an earlier attempt cannot complete the active attempt.
R-3: states and attempt counters remain within the declared finite domain.
Cancellation is accepted only before terminal completion. If completion wins,
cancellation is not accepted. This contract does not promise rollback of an
external effect already initiated by a worker.

## State, actions and atomicity

State: status, attempt, cancelAccepted and acceptedAttempt. acceptedAttempt
retains the accepted result's tag so S-2 is meaningful, rather than comparing
an attempt counter to itself. Start enters attempt 1. Timeout enters waiting
below MaxAttempts and failed at the bound. Retry increments attempt and runs.
Cancel accepts logical cancellation. CompleteCurrent accepts a current result.
CompleteStale stutters. TerminalStutter keeps terminal states total.

All modeled actions are atomic logical updates. Planned cancelTask(taskId)
and applyCompletion(taskId, attempt) must implement the status/attempt guard
and update in one transaction or compare-and-swap. A read followed by a
separate unguarded write is not this action. These are planned symbols, not
claims about existing production code. The main dialog must obtain an actual
mechanism and review its mapping before implementation.

## Properties, assumptions and faults

- S-0 / TypeOK: status, counters and cancellation history have valid types.
- S-1 / CancelledStable: cancelAccepted implies cancelled status.
- S-2 / StaleCannotComplete: success records the active attempt's tag.
- L-0: unconditional liveness is excluded. A worker need not respond and a
  scheduler need not choose completion. The safety model adds no fairness.
  Separate test fixtures demonstrate explicit weak-fairness liveness checks.
- A-1: MaxAttempts is a positive natural, checked by ASSUME; small sets it to 2.
- A-2: guard/update is atomic; the implementation owes a real CAS or transaction.
- A-3: the package concerns an in-memory logical task; no crash recovery,
  persistence ordering, lease validity or external-effect deduplication claim.
- F-1: completion and cancellation may arrive in either order.
- F-2: timeout, retry and a completion from the previous attempt may interleave.

Two attempts expose the old/new attempt race. This is finite exploration,
not a proof for arbitrary attempt counts or a deployed implementation.

## Planned coverage and correspondence

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | Accepted cancellation remains terminal | S-1 | CancelledStable | small (core), MaxAttempts=2 | Start → Cancel → late completion; Start → completion → Cancel | A-1, A-2, A-3 | Cancel → cancelTask(taskId); atomic guarded status/CAS update; CompleteCurrent → applyCompletion(taskId, attempt), same guard/update boundary | Accept cancellation then deliver callback: cancelled; complete first then cancel: succeeded with cancellation unaccepted | External effects excluded by R-1's logical-state scope; never inferred to roll back |
| R-2 | Old result cannot complete a newer attempt | S-2 | StaleCannotComplete | small (core), MaxAttempts=2 | Start(1) → Timeout → Retry(2) → CompleteStale(1) | A-1, A-2, A-3 | Start/Timeout/Retry → planned startTask/timeoutTask/retryTask; atomic status/attempt update; CompleteStale → applyCompletion with tag check in same CAS | Old callback after retry leaves attempt 2 running, acceptedAttempt unchanged | Minimal stale action is a stutter abstraction; explicit delivered-tag companion and adverse traces must challenge its sufficiency |
| R-3 | State remains bounded and well typed | S-0 | TypeOK | small (core), MaxAttempts=2 | Retry through bound; timeout at bound → failed; TerminalStutter | A-1, A-2, A-3 | All actions → guarded state transition; TerminalStutter → no mutation | Counters never exceed 2; terminal update cannot create a new attempt | No persistence or restart property; those require a new model |

## Critical abstraction challenges

1. Stale deliveries stutter in this minimal model. Challenge: attempt 1 times
   out, attempt 2 starts, completion tagged 1 is delivered. If real code
   checks a tag and then separately writes without a guard, this abstraction
   fails. Use late-event-correct/late-event-buggy test companions to model
   pending delivered tags and atomic removal plus conditional task update.
2. Logical cancellation does not undo worker effects. Challenge: worker sends
   payment → cancellation accepted → payment commits. S-1 observes only the
   task state, so cannot establish absence of a charge. A requirement for
   rollback or at-most-once charging must add an enforceable effect protocol,
   property and implementation mechanism, or obtain the project's scoped
   exclusion approval; it cannot be silently dropped.
3. Pending-tag companion excludes duplicate deliveries (one queued event per
   started attempt), external effects and persistence. Challenge: duplicate
   callback after first delivery may repeat an external effect even when
   logical state stays terminal. If relevant to the task, extend the model;
   this fixture establishes no duplicate-side-effect guarantee.

## Counterexample disposition and acceptance

The separate buggy-callback fixture replaces only CompleteStale, accepting
attempt-1 while running attempt 2. Expected disposition: modeling an actual
missing receiver guard is a design/code defect; restore the atomic tag and
state guard, never delete S-2. Keep its failing evidence separate from this
must-pass package. Inspect actual traces rather than assuming the expected
trace order. Preserve both cancellation/completion orders in code tests.

Keep run IDs, review opinions, tool-upgrade records and observed code/test
locations in implementation.md outside the digested inputs. Semantic,
atomicity or assumption changes update this design/model and require a new
check and review. A completed coverage table alone does not establish model
sufficiency. See workflow.md for the illustrative handoff and acceptance.
