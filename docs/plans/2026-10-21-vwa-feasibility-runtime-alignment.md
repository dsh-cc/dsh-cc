# VWA Post-lane-2 Fix Batch — Fix 1: Feasibility Estimation Aligned to Runtime Semantics

## Status: Designed — three-lane blind review converged (r1 full review: critic GO-WITH-CHANGES, grok GO-WITH-CHANGES, codex NO-GO adjudicated as severity calibration on the same finding set; r2 delta confirmation; r3 micro-confirmation — final round GO on all seats). Implementation pending; user sign-off pending.

All anchors cite tree `b64af0e8` (main after the #271/#272/#274 merge race fix),
verified by direct source reading on 2026-10-21 before this design was written.

## 1. Problem

The static budget feasibility gate (Feature C, `feasibility.ts`) is supposed to
refuse plans that cannot complete under the frozen budget BEFORE any run is
reserved. Local verification (2026-10-21) found the gate's model of the
runtime diverges from the runtime itself in four ways. Two are billing
granularity (Issue 1), one is retry headroom (Issue 3), and one is a latent
dead computation discovered during design verification.

### 1.1 Audit call estimate double-bills the artifact (Issue 1, P0)

`feasibility.ts:46-54` estimates audit calls as
`rootBlockCount + ceil(text.length / unitChars) + 1` — counting the artifact
once per root block and a second time by total length. The runtime does
neither:

- Extraction units are produced per root block, split only when a block
  exceeds `unitChars` (`extractionUnits`, audit-input.ts:54-75).
- Units are then **packed into dispatch batches** at
  `0.7 × (caller?.maxContextChars ?? Infinity)` per call (the packing loop,
  audit.ts:197-209); one batch = one model call.
- Audit total = extract batches + 1 align call.

A 19-block artifact that fits the context yields roughly 1-2 extract batches
+ 1 align at runtime, while the gate reports `19 + 1 + 1 = 21` planned audit
calls. The reported number is what the author sees in the refusal detail
(`plannedCalls.audit`), so the gate's own diagnostics overstate cost by ~10x
and drive wrong refusals.

### 1.2 Audit reuse exists at the refusal layer but not at the execution layer (Issue 1, P0)

Continue mode already exempts reusable semantic tasks from the estimate
(`feasibility.ts:71-74`, via `reusableRecord`). For audit, the gate comment
says audit is "ALWAYS counted in full" (feasibility.ts:45) — runtime-faithful
today, because the runner re-executes audit unconditionally whenever `audit`
∈ stages (review-runner.ts:269-298 has no reuse check). `hasReusableAudit`
(audit-reuse.ts:62) is consulted only by `continueHasWork`
(review-continue.ts:158-178) to decide the NOTHING_TO_CONTINUE refusal.

This wastes real money in the repair loop: a continue run that re-executes
failed semantic tasks and reproduces identical judgments leaves the audit
dependency digest (and therefore the audit input hash) unchanged — the
completed audit from the prior run is a valid fact under the exact identity
the design already defines, yet the runner re-executes it in full.

### 1.3 Retry headroom: static promise vs runtime ceiling (Issue 3, P1)

The gate reserves `RETRY_FACTOR = 1.5` (feasibility.ts:22, 79). The runtime
allows up to **3 attempts** per call for the invalid class and 2 for the
transient class (review-call.ts:161 — the per-call class ceiling).
Verification observed a claim retry twice, hit `BUDGET_EXHAUSTED` (each
attempt reserves a fresh `maxOutputTokensPerCall`), and the run finished
`budget-exhausted` — after the gate had just declared the plan feasible. The
gate's promise is soft.

### 1.4 The wall estimate is dead code and two budget dimensions are ungated (found during design verification)

`feasibility.ts:82` computes `estimatedWallMs` but line 83 compares **only
output tokens** — the wall number is reported in the refusal detail yet
never gates anything. Additionally `maxCallsPerRun` and
`maxInputTokensPerRun` are never compared by the gate at all. The wall IS a
hard runtime constraint via `BudgetTracker.deadline` (review-tasks.ts:122-128,
`wallExceeded` at 135-137) — enforced per stage (review-runner.ts:268) and
per retry (review-call.ts:165).

## 2. Design

### F1.1 Shared audit cost model (fixes 1.1)

Extract the batch-packing loop from audit.ts:197-209 into a pure helper:

```ts
// audit-cost.ts (new module; audit.ts imports it so the two cannot diverge)
export function packExtractionBatches(
  units: ExtractionUnit[], maxContextChars: number,
): ExtractionUnit[][] { /* verbatim move of audit.ts:197-209 */ }

export function auditCostModel(input: {
  artifactText: string
  maxUnitChars: number
  maxContextChars: number
}): { units: number; batches: number; calls: number } {
  const stripped = stripClaimMarkers(input.artifactText).text
  const units = extractionUnits(stripped, input.maxUnitChars)
  const batches = packExtractionBatches(units, input.maxContextChars).length
  return { units: units.length, batches, calls: batches + 1 /* align */ }
}
```

- `budgetFeasibilityRefusal` replaces its `estimatedUnits` formula
  (feasibility.ts:48-53) with `auditCostModel(...).calls`.
- The packing semantics must be preserved exactly, including
  `stableJson(unit).length` measured on units WITHOUT the `before`/`after`
  context fields (that is what audit.ts:197-209 measures).
- `auditCostModel` receives the RUNNER's effective context
  (`deps.maxContextChars ?? 48_000`), never `Infinity` — the runtime's
  `caller?.maxContextChars ?? Infinity` fallback must not leak into the
  estimate.
- The refusal detail keeps `plannedCalls.audit` (now the real dispatch count)
  and reports `units` alongside for diagnosis.

### F1.2 Runner-side audit reuse in continue mode (fixes 1.2 execution half)

In `executeReviewRun`'s audit branch (review-runner.ts:269-298), before
calling `executeAudit`, **when `input.continueMode === true`**:

1. Compute the audit input hash exactly as the branch's own current-judgment
   set defines it: `auditInputHash` over `currentReviews(snapshot,
   [...history, ...records], ...)` (the same `auditRecords` the branch
   already computes at review-runner.ts:275 — i.e. the post-semantic-stage
   judgment set, not the admission-time history-only view), the frozen core
   set, contract hash, reviewer config hash, and `effectiveAuditUnitChars`.
2. A new `findReusableAudit(history, inputHash)` (next to `hasReusableAudit`,
   audit-reuse.ts) returns the reusable extract + align record pair when one
   exists (same eligibility as `hasReusableAudit`: completed, schema-valid,
   same run, no disagreement markers). If found:
   - Save both records under this runId (`{...reusable, runId}` shape as
     semantic reuse does, review-runner.ts:328).
   - Append `{kind: 'reused', inputTokens: 0, outputTokens: 0}` usage rows
     (§A.3.5 idiom, review-runner.ts:330-339).
   - Reconstruct the outcome fields from the records via a new
     `auditOutcomeFromRecords(extract, align, frozenCore)` — the same
     derivation `executeAudit` runs after dispatch (audit.ts outcome
     construction), extracted so the executed and reused paths cannot
     diverge. As a belt-and-suspenders check, if the source run's persisted
     outcome (read via the reusable record's `runId` through the run store's
     outcome record, review-runner.ts:127) recorded `newCoreDiscovered`, the reused outcome sets
     `coreDiscovered` accordingly (the align record's `coreClaimIds` only
     unions mapped claim ids, audit.ts:377-384, so needs-review new-core must
     not be lost).
   - Skip `executeAudit`.
3. **Default (non-continue) mode never reuses audit**: a fresh request is a
   second opinion by contract (tools.ts:286-289;
   `nothingToContinue` message, review-continue.ts:224). No reuse in either
   the estimate (F1.3) or the runner.

Rationale: the §A.2 comment's claim "fresh upstream judgments change its
dependency digest" is only true when judgments CHANGE. In continue mode, when
the digest is unchanged, the completed audit is a fact under the exact
identity the design defines; re-dispatching it burns the cycle budget for a
known answer.

### F1.3 Feasibility keeps audit fully counted (fixes nothing — by design)

**Audit is always counted in full in the feasibility estimate, in both
modes.** The r1 review established that zeroing the audit estimate against
the admission-time hash is unsound: `planContinueTasks` digests over
persisted history only (review-continue.ts:117), while the runner re-hashes
after this run's semantic tasks complete (review-runner.ts:275) — remaining
semantic work can change the audit dependency digest, so an admission-time
`hasReusableAudit` match says nothing about whether the audit will execute.
Zeroing the estimate would undercount exactly when the audit runs (the
Issue-3 failure class). The estimate therefore deliberately over-reserves
audit cost; F1.2 is the actual saving, and the over-reserve direction is
intentional (estimate ≥ runtime).

Known limitation, recorded not fixed: the same history-only-digest optimism
applies to semantic-task reuse in the estimate — a support task that looks
reusable at admission may not be after a re-executed source task produces a
changed judgment. The runtime reservation and cycle ledger remain the
enforcement backstops; dependency-graph-aware estimation is future work.

### F1.4 Retry allowance contract (fixes 1.3)

The gate's estimate becomes a bounded promise by giving the runtime the same
allowance it reserved:

- Shared constant `RETRY_ALLOWANCE_FACTOR = 1.5` (feasibility.ts today).
- At admission, after `reviewBudgetRefusal` passes, `argument.review` writes
  `retryAllowance: ceil(estimatedCalls × (RETRY_ALLOWANCE_FACTOR − 1))` onto
  the request record (add `retryAllowance?: number` to the `writeRequest`
  payload type, review-run-store.ts; absent = legacy unlimited; do NOT bump
  `schemaVersion`). `estimatedCalls` comes from a refactored
  `estimateReviewCalls()` (the numbers `budgetFeasibilityRefusal` already
  computes, returned without the Fail).
- **Pool mechanics**: the pool is one integer held on `ReviewCaller`
  (per run). A retry is allowed only when BOTH the per-call class ceiling
  holds (review-call.ts:161 — unchanged) AND pool units remain; the unit is
  consumed **synchronously** — check-and-decrement in the same tick, before
  the retry dispatch, with no `await` between check and debit (the run's
  task batches run via `Promise.allSettled` at `concurrency`,
  review-runner.ts:303-305). One unit = one extra `ReviewCaller.call`
  attempt, regardless of taskId (audit extract batches and align share one
  taskId, audit.ts:118/157, but each `call()` has its own attempts counter).
- **Pool exhausted** → the task fails with a new `REVIEW_RETRY_BUDGET`
  error: add the code to the `Fail` union (store.ts:43), classify it
  'permanent' in the retry classifier (review-call.ts:30-38), and classify it
  in review-progress. The run finishes `incomplete` with the refusal
  threaded through BOTH existing failure paths — the `Promise.allSettled`
  failure branch (review-runner.ts:431-439) and the outer catch
  (review-runner.ts:493-506) — so the refusal is persisted on the run
  outcome, not only the startup-failure path.
- **Recovery advice, precise**: "retry headroom exhausted; completed records
  are kept. If the cycle still has budget, retry with `continue: true` on a
  new requestId (same cycle, completed records are reused across runs); if
  the cycle is spent, a fresh request opens a new cycle with a full budget
  but re-executes the semantic stages (a second opinion)."
- **Promise scope, honest**: the guarantee holds for a fresh cycle with
  empty spend, on the output-token and maxCallsPerRun dimensions only.
  Input tokens stay ungated by the static gate (a faithful input estimate
  would require measuring every envelope; runtime reservation remains the
  enforcement) — documented as a known gap. Continue-mode admissions gate
  against the REMAINING cycle budget (see F1.5).

Alternatives considered (r1):
- **Widen the static factor to the worst case (3×)**: rejected — refuses
  healthy plans; no default budget size fixes that without making the gate
  vacuous.
- **Reduce runtime retry ceilings (invalid 3→2)**: rejected — Feature B's
  repair loop is valuable.
- **Honest messaging only**: rejected as the sole fix — documents the
  divergence instead of removing it.

### F1.5 Gate completeness, cycle-remaining, and the wall number (fixes 1.4)

- The gate compares `estimatedWithRetries` against `budget.maxCallsPerRun`
  and `estimatedOutputTokens` against `budget.maxOutputTokensPerRun`.
- **Continue mode gates against the remaining cycle budget**: for
  continuations the comparison basis is
  `min(frozen, remaining-cycle-calls / tokens)` via `cycleUsage`
  (review-cycle.ts) — a continuation in a partially spent cycle must not
  pass the gate against the full frozen budget and then die on the cycle
  ledger.
- `estimatedWallMs` stays **report-only**, with an explicit comment that the
  wall is a runtime-only liveness limit. The estimate uses `callTimeoutMs`
  per attempt ÷ concurrency as an order-of-magnitude figure only, and the
  doc does not claim worst-case coverage: arguments and the audit
  extract/align sequence run serially (review-runner.ts:303 — arguments
  batch size 1; audit dispatches sequentially), and per-attempt timeouts
  scale up to 4× `callTimeoutMs` with input size (review-call.ts:124-136),
  so elapsed time can exceed any per-call ÷ concurrency arithmetic.

## 3. Tests

- `feasibility.spec.ts`: audit estimate equals `auditCostModel` output for
  artifacts with (a) many small blocks, (b) one over-long block, (c) a mix;
  the estimate uses the runner's effective context (never Infinity); audit
  always fully counted in continue mode even when an old audit record exists
  (the r1 blocker pin); retry allowance arithmetic; `maxCallsPerRun`
  refusal; continue-mode gating against remaining cycle budget; wall
  reported not gated.
- `review-runner.spec.ts` (or an audit-reuse spec): continue-mode audit
  reuse saves reused records + zero-token usage rows and skips dispatch
  (assert via dispatch counter); outcome fields (findings/metrics/
  coreDiscovered) identical to the executed path; needs-review new-core
  preserved through reuse; default-mode runs NEVER reuse audit (negative
  pin); disagreement-marked audits never reused.
- Retry pool: a task that retries beyond the allowance fails
  REVIEW_RETRY_BUDGET with the refusal persisted on the run outcome (both
  failure paths); concurrent-contention test (two in-flight tasks racing
  the last pool unit — exactly one gets it); runs without the field behave
  as today; per-call class ceilings unchanged.
- **`packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts` must be run
  locally** (the #270 fixture trap: budget-semantics changes that look
  green in vwa-argument alone can break the preset-side e2e).

## 4. Compatibility and rollout

- No persisted-format change except the additive `retryAllowance` request
  field (absent = legacy unlimited).
- `packExtractionBatches` is a verbatim move; audit behavior is unchanged.
- The refusal detail's `plannedCalls.audit` semantics change (real dispatch
  count) — tests asserting the old formula are updated, not deleted.
- Stacked first in the fix batch (Fix 2's defaults are sized against this
  gate's arithmetic; Fix 3's message references the same refusal shape).


## Review ledger (full cycle, honest scope notes)

- **r1 full review** (all three seats, fresh briefs): critic GO-WITH-CHANGES;
  grok GO-WITH-CHANGES ($1.01 / 14 turns); codex NO-GO (94.4k tokens — first
  run interrupted by the known codex stderr EAGAIN panic, verdict not
  fabricated; one scope-constrained retry taken as in-place flake recovery).
  Divergence adjudication: the codex NO-GO vs the other seats' GWC was
  severity calibration on the same finding set (implement-as-written test:
  the drafted audit-estimate zeroing would undercount and reintroduce the
  budget-exhaustion class); all findings folded (full ledger:
  .scratch/vwa-fix-adjudication-r1.md, session archive).
- **r2 delta confirmation** (fold map 1-10): critic all OK / GO; grok all OK
  / GO; codex folds 1-8 OK (fold 9/10 findings belonged to Fix 2/Fix 3 and
  were fixed in their documents' r3 surgery).
- **r3 micro-confirmation** (five surgical fixes A-E, scope-constrained):
  critic, grok ($0.53/13 turns), codex (23.1k tokens) — fix E OK, verdict GO.
- Scope honesty: r2 verified the folds only (not a full re-review); r3
  verified five surgical fixes only. The r1 full review is the only
  whole-document round. User sign-off pending.
