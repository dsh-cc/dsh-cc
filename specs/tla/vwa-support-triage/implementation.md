# Implementation record: vwa-support-triage

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T040133Z-4029afc9-ce14-4903-b0de-41c735f14e07`
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 10,882 states generated, 2,295 distinct,
  0 left on queue; all invariants hold.
- Probes (expansion, expected counterexample; each hit exactly its intended
  invariant):
  - `strict-late-reorder` → `LateNeverReorders`: a late result reorders a
    dispatched batch.
  - `strict-adopt-late` → `LateNeverReorders`: a past-deadline result adopted
    as order.
  - `strict-triage-reused` → `ReuseTriageDisjoint`: triage covers an already
    reused record (it would be paid for twice and rewritten).
  - `strict-cross-scope-reuse` → `NoCrossScopeReuse`: hints reused across a
    DecisionScope change.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development failures were **modeling defects**, never design defects:

1. `Tasks` was declared a CONSTANT set, which `checks.json` cannot assign
   (constants accept integer atoms and identifiers only) — the domain moved
   into the model as a fixed set.
2. `reused /\ frozen = {}` parsed as a set intersection because both sides
   are set-shaped; rewritten as `reused \cap frozen = {}`.
3. A vacuous `OrderFrozen` invariant (a tautology over a boolean test) was
   deleted rather than kept as decoration.
4. The `strict-triage-reused` probe was vacuous: it recorded a fault but
   never put the reused task into the frozen set, so the disjointness
   invariant could not fire. The probe now actually models the fault.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-07-vwa-support-triage.md`
  — "this proposal must operate after reuse, so that an already completed
  task does not incur decision cost a second time"; "completed records are
  first reused by the existing semantic key, and the remaining tasks form
  `pending` in original plan index order"; "triage must not touch already
  reused records"; the frozen-order stages; "a batch already dispatched is
  not reordered on late results; results past the triage deadline are billed
  only"; and the cycle/DecisionScope reuse restriction.
- Property → clause: `ReuseTriageDisjoint` ← reuse before triage;
  `ReuseExcluded` ← pending is exactly the post-reuse set;
  `LateNeverReorders` ← late results are billed, not applied;
  `NoCrossScopeReuse` ← identity-scoped reuse.
- Action → planned code: `Reuse`/`ReuseFilter` ↔ the reuse branch in
  `review-runner.ts` before the model call; `Hint`/`Freeze` ↔
  `support-triage.ts` prompt and ordering; `LateIgnored` ↔ the deadline
  settlement path; `ScopeChange` ↔ the DecisionScope re-validation on
  resume.

## Not verified (explicitly out of scope)

- The S1-02 reserve/settle protocol and the permit adapter's accounting
  (`specs/tla/decision-runtime-quota` owns those invariants).
- The triage question text, probability thresholds and the G1/G2/G3 example
  ordering (pinned by the design's test matrix).
- Batch window arithmetic, `max-items-per-run` and the group cap.
- The "assist results are never written as a formal pass" rule, which is
  enforced by the delivery tests rather than by an invariant here.
- Liveness: a review that never freezes its order is a legal state.
