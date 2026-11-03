# Implementation record: vwa-audit-split

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T072143Z-f5f806a1-58df-4fc5-b4ba-3ab3510ab9f3` (freshness re-run after the restart-mid-run limitation note; identical statistics per case) (r3 fold rerun) (review-fold rerun)
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 12,165 states generated, 1,523 distinct, 0 left on queue; all 7 invariants hold.
- Probes (expansion, expected counterexample; each hit exactly its intended
  invariant):
  - `strict-later-overwrites` → `WorstSticky`: a later pass overwrites an
    earlier, more severe verdict (the worst-verdict merge violated).
  - `strict-body-per-chunk` → `OneBodyTask`: a second logical full-text task
    without a lost-body restart.
  - `strict-adopt-fragments` → `NoFragmentAdoption`: fragments aggregated
    into a completed full-text audit.
  - `strict-drop-low-prob` → `NoCandidateDropped`: a low-probability
    candidate dropped instead of merely ordered lower.
  - `strict-no-reserve` → `ReservedBeforeDispatch`: a body task dispatched
    without taking a budget permit.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development failures were **modeling defects**, never design defects:

1. `Worst` was used before its definition (TLA+ has no forward references);
   moved above the state variables.
2. The action `AdoptFragments` collided with the CONSTANT of the same name;
   the action became `AdoptFragmentsAct`.
3. `Spec == Init /\\ [][Next]_vars` was written with a doubled backslash from
   a shell heredoc; unescaped.
4. `lostBody' = lostBody \\/ (...)` hit the `=`-binds-tighter-than-`\\/`
   precedence trap (third occurrence in this program): the assignment became
   a plain disjunction and TLC reported the variable unassigned. Parenthesised.
5. Reservation/dispatch counters were inverted (`res <= runs`); reservations
   precede dispatches, so the invariant is `runs <= res`, and an alignment
   pass takes both a permit and a dispatch.
6. `OneBodyTask` (`bodyCount <= 1`) was over-strong: the design explicitly
   requires a re-run when a body completed but its pair is not durable. A
   `lostBody` witness variable distinguishes the legitimate recovery re-run
   from the illegal per-chunk duplication.
7. Two state-space blowups (unbounded `runs`/`res`, and a re-fireable
   `Escalate`/`BodyStart`) were fixed by bounding the counters
   (`MaxRuns`) and requiring the recovery witness before a second body task.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-08-vwa-audit-split.md` —
  the mergeAlignChunks worst-verdict rule, the "Once" paragraph for the
  full-text task, the fragments exclusion, the "dropping low-probability
  candidates is rejected" exclusion, the budget-permit sharing with S1-07,
  and the recovery test rows (restart with the body on disk does not increase
  the body call count; a durable body part whose final commit was interrupted
  is only re-assembled, and a crash before the body part's durable save
  re-runs and re-bills it). The model's `lostBody` freedom is exactly the
  second half of that rule.
- Property → clause: `WorstSticky`/`NoFaults` ← worst-verdict merge;
  `OneBodyTask` ← exactly one logical body task per (runId, auditKey);
  `NoFragmentAdoption` ← fragments never aggregated; `NoCandidateDropped` ←
  S1 orders only; `ReservedBeforeDispatch` ← permit before dispatch;
  `DeliveryNeedsPair` ← the public pair is the delivery unit.
- Action → planned code: `Plan` ↔ `audit-split.ts` extraction/chunking;
  `AlignPass` ↔ the chunked alignment call and `audit-align.ts` merge helper;
  `BodyStart`/`BodyDone` ↔ the single body task; `SaveAlign`/`SaveBody`/
  `Restart` ↔ partial save and recovery; `Deliver` ↔ final public record
  assembly after validation.

## Not verified (explicitly out of scope)

- The AUDIT-01..05 rule bodies, prompt wording and schema validation details.
- `auditCostModel` arithmetic and the truncation/bisection bounds (only the
  "no fragment aggregation" and "one logical task" rules are modeled).
- The shortlist ranking thresholds (`priority-threshold` 0.60, batching
  limits) — S1 only orders; the model keeps the "never drop" rule.
- The Lean face (the worst-verdict merge lattice's associativity and
  idempotence) planned as a separate Lean model, not built here.
- Liveness: an audit that never completes is a legal state.

## Review fold (three-seat impl-readiness review)

- `WorstSticky` is a real monotonicity property over the per-item
  `worstSeen` ghost (a tautology before); the `strict-later-overwrites`
  probe still hits it.
- The body task now requires alignment-ready (every planned item merged)
  before it may start, pinning the doc's "no body while any alignment is
  incomplete".
- The merge/lattice semantics are labeled as the RETAINED legacy
  aggregation (`mergeChunkTargets` in audit-align.ts, kept and used when
  split=off); split-v1's no-cross-chunk-merge path is the body-task single
  execution already modeled.

## r3 fold (r2 delta review)

- `WorstSticky` is now the exact equality `merged[i] = worstSeen[i]` (the
  published verdict IS the worst ever observed); the
  `strict-later-overwrites` probe checks `WorstSticky` itself, including
  non-fail downgrades.

