# VWA lane-2 Hardening — Feature A: Per-Target Incremental Continuation

## Status: Three-lane blind review converged (critic + two external lanes, seven rounds, final round GO on all lanes); user sign-off pending.

This document is one of six feature designs split from the combined
lane-2 reliability hardening design. It addresses Problems 1 and 6 from the tui-40b4 session.
Dependencies: None.

The twelve session problems were each verified against current code at
HEAD 7960c4ff before design work began; all anchors below cite that tree.

## Feature A: Per-Target Incremental Continuation

### A.1 Problem

A review run that ends `incomplete` (any task failed: infra timeout,
REVIEW_INVALID, budget exhausted) forces the author to call `argument.review`
with a NEW requestId, which re-plans and re-executes ALL tasks — including
tasks that already passed in prior runs. The cache key mechanism
(`cacheKey`, review-run-store.ts:239-259) identifies per-target records by
content hash, but `executeReviewRun` restricts reuse to runs sharing the same
requestId (review-runner.ts:265-268, the `ownRuns` guard).

Consequence (tui-40b4): 18 review rounds, each re-running sources and support
stages that had already passed, burning the frozen budget on redundant calls.

### A.2 Design decision: explicit continue mode with server-side guard

The design doc §11.3 states: "Explicit re-review MUST pass a new requestId;
old conclusions are retained." This means new requestId = deliberate re-judge
(second opinion, disagreement detection). Making new requestId silently reuse
cache would break that semantic.

Resolution: add an explicit `continue` input flag to `argument.review`, with
a server-side guard that refuses continue when there is nothing to continue.

| Mode | requestId | Behavior |
|---|---|---|
| (default) | new | Fresh run: re-execute all planned tasks. Existing behavior. |
| (default) | same | Idempotent replay: return stored result. Existing behavior. |
| `input.continue: true` | new | Continuation: reuse all completed records whose cache key matches; re-execute only tasks without a reusable completed record. **Refused when every planned task already has a reusable completed record.** |

**Server-side guard**: when `input.continue === true`, the runner first plans
all tasks and checks whether any task lacks a reusable completed record. If
every planned task already has one, the tool returns a distinct error:

```json
{
  "ok": false,
  "code": "NOTHING_TO_CONTINUE",
  "message": "All planned tasks already have completed records. Use a fresh request (without continue) for an explicit second opinion.",
  "retryable": false
}
```

"Reusable" means `recordReusable` returns true: completed, schema-valid, all
required checks present. A completed record with a `fail` verdict IS reusable
— the fail stands (§11.3: "a latest pass MUST NOT silently overwrite a fail").
The guard prevents the "agent always passes continue to save budget" failure
mode identified by grok r1.

### A.3 Mechanism

**A.3.1 Cache key extension.** The cache key gains `requiredRules` (sorted,
per-target) to capture scope-dependent rule assignments. `SOURCE-03` depends
on the selected claims' sources (review-plan.ts:183-192); a different target
scope can add or remove this rule for the same source. The extended key:

```ts
cacheKey = SHA256(stableJson({
  stage,
  targetRefs,        // [{id, entityVersion}] sorted
  requiredRules,     // [{targetId, ruleId}] sorted — NEW
  dependencyDigest,
  contractHash,
  policyHash,
  reviewerConfigHash,
  promptHash,
}))
```

Existing records without `requiredRules` in their key are NOT reusable after
this change (their keys don't match). This is a one-time invalidation on
upgrade; the design doc §11.3 cache key formula is amended accordingly.
Current-result selection and disagreement detection use this same complete
key, not only the dependency digest and target references. Records from a
different required-rule scope remain historical. Same-key conflicting
judgments remain current and retain fail protection.

**A.3.2 Deterministic record selection.** When multiple completed records
share a cache key (the disagreement case), `prior.find(...)` returns the
first in `readdirSync` order — nondeterministic. Continue mode selects the
**most recent** completed record, sorted by `endedAt` descending with
`recordHash` as tie-breaker (stable across filesystems):

```ts
// Continue mode only:
const candidates = prior
  .filter((r) => recordReusable(r, requiredRuleIds))
  .sort((a, b) =>
    b.endedAt.localeCompare(a.endedAt) ||
    sha256Hex(stableJson(a)).localeCompare(sha256Hex(stableJson(b)))
  )
const reusable = candidates[0]  // undefined when empty
```

The fail-stands rule (§11.3: "a latest pass MUST NOT silently overwrite a
fail") is preserved by the record selection: if the most recent record has
a fail verdict, it IS the reusable record — the continuation reuses the fail,
not an earlier pass. Disagreement detection (detectDisagreement) runs when a
task is re-executed and produces a different verdict than a prior record for
the same key; in continue mode, re-execution only happens when NO reusable
record exists, so disagreement detection is not triggered by continuation.
This is correct: continuation is not a second opinion.

**A.3.3 Semantic digest for upstream records.** When a record is reused, it
is copied with the new runId (`save({ ...reusable, runId })`). The copy has
the same `inputHash` (cache key) but a different `runId`. Downstream tasks
compute `taskDependencyDigest` which hashes upstream records — including
`runId`, `startedAt`, `endedAt` (review-input.ts:43-45). This means a reused
record changes downstream digests, invalidating downstream cache keys.

Fix: `taskDependencyDigest` hashes only the **semantic content** of upstream
records, excluding run metadata:

```ts
// review-input.ts:
export function semanticRecordHash(r: ReviewRecord): Hash {
  return sha256Hex(stableJson({
    stage: r.stage,
    targetRefs: r.targetRefs,
    dependencyDigest: r.dependencyDigest,
    contractHash: r.contractHash,
    policyHash: r.policyHash,
    reviewerConfigHash: r.reviewerConfigHash,
    promptHash: r.promptHash,
    inputHash: r.inputHash,
    status: r.status,
    response: r.response,
  }))
}

// In taskDependencyDigest:
upstream: deduplicateBySemanticHash(upstreamRecords(index, task, records))
  .map((r) => semanticRecordHash(r))
  .sort(),
```

The excluded fields (`runId`, `startedAt`, `endedAt`, `kind`, `errorCode`,
`errorDetail`, `inputTokens`, `outputTokens`) are runtime metadata, not
semantic content. Two records with the same semantic content produce the
same digest regardless of which run produced them.

**Deduplication**: when both the original and the reused copy exist in the
record set, they have the same semantic hash. Deduplicate by semantic hash
before including in the digest:

```ts
function deduplicateBySemanticHash(records: ReviewRecord[]): ReviewRecord[] {
  const seen = new Set<Hash>()
  return records.filter((r) => {
    const hash = semanticRecordHash(r)
    if (seen.has(hash)) return false
    seen.add(hash)
    return true
  })
}
```

This ensures that a reused record does not change downstream digests: the
original and the copy are semantically identical, so deduplication collapses
them to one entry.

Model inputs follow the same semantic deduplication rule. The task context
(`context.currentReviews`) and audit alignment context
(`currentReviewRecords`) include one copy per semantic hash. Persisted reuse
copies remain intact for provenance and adjudication. Distinct judgments,
including conflicting verdicts, are not collapsed. Repeated continuations
must not grow model context solely by copying completed records.

**A.3.4 Intra-run scoping.** The `history` array is loaded once at run start
(review-runner.ts:99). Cross-request reuse in continue mode only affects which
records from prior runs are eligible; records produced within the current run
are included alongside prior records in downstream dependency digests.

**A.3.5 Usage ledger.** Reused records append a `{kind: 'reused'}` usage row
(UsageRow already supports this variant, review-run-store.ts:40) so the ledger
is complete and auditable.

**A.3.6 Run completion.** After all stages finish, a continue-mode run reports
`completed` when every planned task has either a freshly completed record from
this run or a reused completed record. If any task has neither, the status is
`incomplete`.

**A.3.7 Tool contract.** `argument.review` gains an optional boolean
`input.continue`. No other tool changes. The response envelope is unchanged.
Same requestId + `continue: true` → `IDEMPOTENCY_CONFLICT` (payloadHash
mismatch), as documented in the skill.

### A.4 Interaction with budget and repair cycles

- Reused records consume zero budget (no model call). This directly addresses
  the tui-40b4 budget exhaustion pattern.
- A continuation run is NOT a repair cycle. The skill doc's "Allow one
  repair-and-review cycle" refers to content repair (editing the body or graph
  in response to findings). Continuing after an infrastructure failure is not
  a content change and does not consume the repair-cycle budget. The skill doc
  gains explicit guidance:

  > After a run ends `incomplete`, `budget-exhausted`, or `cancelled`, call
  > `argument.review` again with a new requestId and `input.continue: true`
  > to re-execute only the failed tasks. This is not a repair cycle and does
  > not count against the repair budget. Do not pass `continue: true` when
  > you want a second opinion on completed tasks — use a fresh request
  > without `continue`.

- Review-cycle budget (post-review amendment). A continuation never grants a
  fresh budget. A review cycle is the project's latest fresh request plus the
  continue requests after it; all of them share one frozen budget for calls,
  input tokens and output tokens (wall clock stays per run). A continue run
  gets only the cycle's remainder, and is refused with `BUDGET_EXHAUSTED`
  (retryable: false) before reservation when one more call does not fit.
  Continuing after `budget-exhausted` is therefore useful only when the cycle
  still has spend left (for example a wall-clock stop). See `review-cycle.ts`.
  - Each admitted request persists `cycleId` and `cycleSequence`. A fresh
    request uses its run ID as its cycle ID and increments the project-local
    sequence. A continuation binds to the latest admitted cycle. The runner
    preserves the queued request's identity and admission timestamp, even if
    another fresh request is admitted before it starts. Clock values and
    random run IDs never determine cycle membership.
  - Admission and per-call budget reservation use the same exclusive-create
    filesystem lock, separate from the author write lock. Before every model
    attempt (including retries and audit calls), the caller reads reconciled
    cycle spend, checks the exact counted input and reserved output, and
    persists its reservation before releasing that lock. No await or model
    dispatch occurs inside the critical section. Concurrent runs and separate
    processes therefore share one allowance; a losing reservation dispatches
    no call and ends `budget-exhausted`. Pre-checks are advisory snapshots;
    the per-call reservation is authoritative.
  - Requests written before cycle IDs existed are conservatively charged to
    one legacy cycle. Their original ordering cannot be recovered reliably,
    so no legacy spend is dropped based on tied clocks or UUID ordering.
    A fresh request opens a separate identified cycle. Reconciled in-flight
    reservations still count after a crash; the lock follows the existing
    dead-holder reclaim rule and is never reclaimed merely by age.
- Audit reuse (post-review amendment). Audit records carry the full audit
  identity as `inputHash` (artifact bytes, audit dependency digest, frozen
  core set, contract, policy, extract/align prompts, reviewer config, unit
  size). A continue run whose semantic tasks and audit all have reusable
  completed records is refused with `NOTHING_TO_CONTINUE`, including
  `stage: "all"`.

### A.5 Cache key safety

Cross-request reuse is safe because the extended cache key is content-addressed:
- Reviewer model/alias change → `reviewerConfigHash` changes → no reuse.
- Prompt template change → `promptHash` changes → no reuse.
- Graph/contract change → `dependencyDigest`/`contractHash` changes → no reuse.
- Target scope change → `requiredRules` changes → no reuse.
- Same inputs, same config, same graph, same scope → same judgment by
  construction.

### A.6 Implementation

1. `review-run-store.ts`: extend `cacheKey` with `requiredRules`.
2. `review-input.ts`: add `semanticRecordHash` and `deduplicateBySemanticHash`;
   use them in `taskDependencyDigest`.
3. `review-runner.ts`: thread `continueMode` into the reuse predicate;
   implement deterministic selection; append `{kind: 'reused'}` usage rows;
   refuse continue-on-complete.
4. `tools.ts`: parse `input.continue`; pass to `executeReviewRun`.
5. `SKILL.md`: add continuation guidance to §5.

### A.7 Tests

- review-runner.spec.ts: continue mode reuses completed records, re-executes
  only failed tasks. Assert adapter call count.
- review-runner.spec.ts: continue mode on fully completed plan →
  NOTHING_TO_CONTINUE error.
- review-runner.spec.ts: continue mode with prior fail → reuses the fail
  record (fail-stands), does not re-execute.
- review-runner.spec.ts: continue mode with different target scope →
  requiredRules change → no reuse.
- review-runner.spec.ts: deterministic selection picks most recent record;
  equal timestamps → recordHash tie-breaker.
- review-runner.spec.ts: `continue: false` (default) re-executes all tasks.
- review-input.spec.ts: semanticRecordHash excludes runId/startedAt/endedAt;
  original and copy produce the same digest; deduplication collapses
  semantically identical records.
- tools.spec.ts: `input.continue: true` accepted; absent defaults to false.

---

---

## Review history for this feature

The design passed three-lane blind review (an internal critic seat plus
two external seats) over seven folding rounds. Cross-feature findings
(for example the shared cache-key and feasibility interactions between
Features A and C) were adjudicated in the combined draft; the per-round
ledger below lists the findings that touched this feature's sections.

### Round 1 (three-lane, v1 draft)
| Lane | Verdict | Key findings |
| Codex | NO-GO | A: missing requiredRules in cache key, arbitrary record selection. B: budget math wrong, config drift misclassified. C: currentReviews breaks with batching. D: cascade safety overstated. E: 30K threshold unsafe. F: coverage grep broken. |
| Grok | GO-WITH-CHANGES | A: continue-on-complete is silent skip. B: retry math respects wall-clock, truncation permanent. C: batching doesn't close gap, currentReviews breaks. D: need per-task errorDetail in report. E: structured data shouldn't be windowed. F: coverage glob wrong. |
| Critic | GO-WITH-CHANGES | A: record selection nondeterministic, disagreement skipped. B: rawResponse plumbing path wrong, use finish.failure. C: envelope targets collision, budget math false-positive. E: window evidence slices too. F: grep broken, exclude MCP/plugin. |
### Round 2 (three-lane delta, v2 draft)
| Lane | Verdict | Fold results | New issues |
### Round 3 (three-lane micro-confirmation, v3 draft)
| Lane | Verdict | Fold results | New issues |
### Round 4 (three-lane micro-confirmation, v4 draft)
| Lane | Verdict | Fold results | New issues |
### Round 5 (codex micro-confirmation, v5 draft)
| Lane | Verdict | Fold results | New issues |
### Round 6 (codex micro-confirmation, v5 updated)
| Lane | Verdict | Fold results |
### Round 7 (codex micro-confirmation, v5 final)
| Lane | Verdict | Fold results |

**Convergence**: seven rounds; the final reviewed draft carries every
folded finding. The full three-lane ledger is preserved in the session
records (`.scratch/vwa-enhancement-design-v5.md` history).
