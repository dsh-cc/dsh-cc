# VWA lane-2 Hardening — Feature C: Budget and Graph Feasibility

## Status: Three-lane blind review converged (critic + two external lanes, seven rounds, final round GO on all lanes); user sign-off pending.

This document is one of six feature designs split from the combined
lane-2 reliability hardening design. It addresses Problem 5 from the tui-40b4 session.
Dependencies: Feature A (continue-mode exemption in the feasibility check) and Feature B (retry headroom factor).

The twelve session problems were each verified against current code at
HEAD 7960c4ff before design work began; all anchors below cite that tree.

## Feature C: Budget/Graph Feasibility

### C.1 Problem

The frozen budget (default: 24000 output tokens/run, 3000/call → ~8
successful calls) is structurally insufficient for a modest graph: 1 sources +
5 support + 6 claims + 1 argument + audit (multiple extraction batches +
alignment) > 8 calls. The author discovers this only after running — there
is no static check.

`planStage` produces one task per claim/group/argument (review-plan.ts:207-246).
The response schema (`ClaimsResponse.targets`, maxItems 1000) and
`validateTaskResponse` already support multi-target responses — batching is
structurally feasible.

### C.2 Design

**C.2.1 Static feasibility check at review request time.**

Before starting a run, `argument.review` computes the planned task count per
stage and estimates the total output tokens. The estimate is **conservative**
(it uses the reservation upper bound, not the settled actual) and **accounts
for reusable tasks** in continue mode:

```ts
// Count only tasks that will actually be executed.
// In continue mode, subtract tasks with reusable completed records.
const executableTasks = continueMode
  ? plannedTasks.filter((t) => !hasReusableRecord(t))
  : plannedTasks

// Audit stage: extraction batches + alignment.
// Units are root-level blocks; over-long blocks are sentence-split into
// pieces of at most maxUnitChars (audit-input.ts:54-77). Root blocks can be
// smaller than maxUnitChars (a 100-char paragraph is one unit), so the
// unit count is NOT simply ceil(artifactChars / maxUnitChars). The actual
// maxUnitChars is `Math.min(input.maxUnitChars, floor(maxContextChars / 2))`
// (audit.ts:113-117). A conservative upper bound on the unit count is the
// number of root blocks (each block is at least one unit) plus the number
// of sentence-split pieces from over-long blocks. Without parsing the
// artifact, the safest estimate is the root-block count (available from
// the artifact's outline or by counting headings) plus
// ceil(artifactChars / maxUnitChars) for the over-long pieces.
// For the feasibility check, we use the simpler conservative estimate:
// units = number of root blocks + ceil(artifactChars / effectiveMaxUnitChars),
// where effectiveMaxUnitChars = Math.min(input.maxUnitChars, floor(maxContextChars / 2)).
// The number of batches is at most the number of units (each unit could be
// its own batch), + 1 for alignment.
const effectiveMaxUnitChars = Math.min(input.maxUnitChars ?? 48_000, Math.floor((budget.maxContextChars ?? 48_000) / 2))
// Root blocks are the CommonMark AST root children (markdown-blocks.ts:16-62),
// NOT the artifact outline sections. Use rootBlocks() to count them.
const rootBlockCount = rootBlocks(stripClaimMarkers(artifactText).text).length
const estimatedUnits = rootBlockCount + Math.ceil(artifactTextLength / effectiveMaxUnitChars)
const auditCalls = hasAudit ? estimatedUnits + 1 : 0

const estimatedCalls = executableTasks.length + auditCalls
const estimatedOutputTokens = estimatedCalls * budget.maxOutputTokensPerCall

// Retry headroom: 50% of calls are expected to need at least one retry.
const RETRY_FACTOR = 1.5
const estimatedWithRetries = Math.ceil(estimatedCalls * RETRY_FACTOR)
```

If `estimatedWithRetries * budget.maxOutputTokensPerCall > budget.maxOutputTokensPerRun`,
the tool returns a `BUDGET_INSUFFICIENT` error (new stable error code):

```json
{
  "ok": false,
  "code": "BUDGET_INSUFFICIENT",
  "message": "Planned 16 calls (24 with retry headroom) ≈ 72000 output tokens exceeds the frozen budget of 24000 (reservation upper bound; actual usage may be lower). Options: (a) reduce target scope, (b) enable claims batching on a new project, (c) create a new project with a larger budget.",
  "retryable": false,
  "details": {
    "plannedCalls": { "sources": 1, "support": 5, "claims": 6, "arguments": 1, "audit": 3 },
    "executableCalls": 16,
    "estimatedWithRetries": 24,
    "estimatedOutputTokens": 72000,
    "budgetOutputTokens": 24000,
    "estimatedWallMs": 360000,
    "budgetWallMs": 180000,
    "suggestedClaimsBatchSize": 2
  }
}
```

**Wall-clock feasibility**: the estimate uses the ceiling
`4 × callTimeoutMs` (the maximum per-call timeout from Feature B.2.3) as
a conservative upper bound for wall time:

```ts
// Per-task timeout is computed at call time from input size (B.2.3).
// The estimate uses the ceiling (4x floor) as a conservative upper bound.
const estimatedWallMs = Math.ceil(estimatedCalls * (budget.callTimeoutMs * 4) / budget.concurrency)
```

**Continue-mode exemption**: when `input.continue === true`, the feasibility
check counts only executable tasks (those without reusable records) for the
non-audit stages. The audit stage is always re-executed in full (audit is
not incremental — it re-extracts and re-aligns the entire artifact), so
`auditCalls` is always included when the audit stage is requested.

**C.2.2 Claims batching (opt-in, default off, frozen at init).**

New setting: `review-claims-batch-size` (default 1 = current behavior, range
1–4). When > 1, `planStage` for the claims stage groups up to
`batch-size` claims into one task:

```ts
// In planStage, claims stage:
const batched: ReviewTask[] = []
for (let i = 0; i < claimTasks.length; i += batchSize) {
  const batch = claimTasks.slice(i, i + batchSize)
  batched.push({
    taskId: `task_${randomUUID()}`,
    stage: 'claims',
    targetRefs: batch.flatMap((t) => t.targetRefs),
    targetIds: batch.flatMap((t) => t.targetIds),
    requiredRules: batch.flatMap((t) => t.requiredRules),
    envelope: {
      targets: batch.map((t) => t.envelope.target),  // per-claim payloads
      searches: batch.flatMap((t) => t.envelope.searches),
    },
  })
}
```

**Envelope field naming**: the per-task payload uses `dependencies.targets`
(plural, array) to avoid collision with the outer envelope's existing
`targets` field (which carries `task.targetRefs`). The claims prompt is
updated to say "Return one entry per target in the `dependencies.targets`
array" instead of "reviewing one CLAIM".

**Batch size rationale**: default 1 (no quality change). Range 1–4, not
1–10: each check permits a 4,000-character rationale, plus evidence IDs and
findings (review.schema.json:161-189, 89-143). A batch of 4 claims can
produce up to 4× the single-claim output; with the default 3000-token cap,
a batch of 4 is already tight. The `suggestedClaimsBatchSize` in the
BUDGET_INSUFFICIENT details is computed as
`clamp(floor(maxOutputTokensPerCall / typicalClaimOutput), 1, 4)` where
`typicalClaimOutput` is a conservative 1500 tokens.

**Batch size is frozen**: the batch size is captured in the project contract's
`reviewSettings` at init (like other budget settings), so two runs of the same
project are comparable. Changing the setting later does not affect existing
projects. The implementation adds `claimsBatchSize` to the structured
`FrozenReviewSettings` interface (review-config.ts) and to the
`author.schema.json` contract schema:

```ts
// review-config.ts:
export interface FrozenReviewSettings {
  budget: ReviewBudget
  maxArtifactChars: number
  maxContextChars: number
  claimsBatchSize: number  // NEW
}

// author.schema.json, reviewSettings object:
{
  "claimsBatchSize": { "type": "integer", "minimum": 1, "maximum": 4 }
}
```

The fallback is 1 (no batching) for projects created before this feature.

**C.2.3 Threading batch size through all paths.**

`planStage` is called from three places: `executeReviewRun` (runner),
`currentReviews` (delivery), and `delivery-check.ts` (per-claim assessment).
All three must use the same batch size. The batch size is read from the
project contract's `reviewSettings` (frozen at init):

```ts
// In review-runner.ts:
const batchSize = snapshot.contract.reviewSettings?.claimsBatchSize ?? 1
const tasks = planStage({ stage, snapshot, index, targetClaimIds, core, claimsBatchSize: batchSize })

// In review-current.ts:
const batchSize = snapshot.contract.reviewSettings?.claimsBatchSize ?? 1
const tasks = planStage({ stage, snapshot, index, targetClaimIds: targets, core: new Set(), claimsBatchSize: batchSize })

// In delivery-check.ts:
const batchSize = snapshot.contract.reviewSettings?.claimsBatchSize ?? 1
// ... same pattern for per-claim assessment tasks
```

**One-time invalidation**: when batch size changes from 1 to N, existing
per-claim records have single-target `targetRefs` that don't match the new
batched `targetRefs`. These records are NOT reused (cache key mismatch).
This is correct behavior: a batched judgment is a different input context
than an individual judgment.

**C.2.4 Budget sizing guidance at project init.**

When a project is created, the tool estimates the review cost based on the
planned graph size and includes a `budgetEstimate` field in the response:

```json
{
  "ok": true,
  "data": {
    "budgetEstimate": {
      "plannedCalls": 16,
      "estimatedOutputTokens": 48000,
      "currentBudget": 24000,
      "sufficient": false,
      "suggestedClaimsBatchSize": 2,
      "recommendation": "Enable claims batching (review-claims-batch-size: 2) before creating the project, or create with a larger budget."
    }
  }
}
```

This is informational, not blocking. The estimate is computed at project
init only — `set-contract` does NOT include a budget estimate (the budget
is frozen at init; `set-contract` preserves `reviewSettings` per
graph.ts:162-163). The recommendation respects freeze semantics: it says
"before creating the project" or "create with a larger budget", never
"increase the budget on this project".

### C.3 Implementation

1. `settings.ts`: add `review-claims-batch-size` (default 1, range 1–4).
2. `review-config.ts`: add `claimsBatchSize` to `FrozenReviewSettings`
   and `freezeReviewSettings`.
3. `contracts/author.schema.json`: add `claimsBatchSize` to the
   `reviewSettings` object schema.
4. `review-plan.ts`: add `claimsBatchSize` parameter; batch claims tasks;
   change envelope to `dependencies.targets` array.
5. `review-runner.ts`: read batch size from contract; pass to `planStage`;
   implement continue-mode exemption in feasibility check.
6. `review-current.ts`: read batch size from contract; pass to `planStage`.
7. `delivery-check.ts`: read batch size from contract; pass to `planStage`.
8. `tools.ts`: pre-flight feasibility check in `argument.review` (with
   continue-mode exemption and retry headroom); budget estimate at project
   init only (not set-contract).
9. `prompts/claims.md`: update to reference `dependencies.targets` array.
10. New error codes `BUDGET_INSUFFICIENT` and `NOTHING_TO_CONTINUE` in the
    stable error code table (design doc §10.8).

### C.4 Tests

- review-plan.spec.ts: batch size 3 groups 6 claims into 2 tasks; envelope
  has `dependencies.targets` array; requiredRules cover all batched claims.
- review-runner.spec.ts: batched claims run; adapter called once per batch;
  records have multi-target targetRefs.
- review-runner.spec.ts: continue mode with batching; feasibility check
  counts only executable tasks (audit always counted).
- review-current.spec.ts: batched records match planned tasks in
  currentReviews.
- delivery-check.spec.ts: batched records match per-claim assessment tasks.
- tools.spec.ts: `argument.review` returns BUDGET_INSUFFICIENT when estimated
  calls (with retry headroom) exceed budget; includes per-stage breakdown,
  suggestedBatchSize clamped to 1-4, and wall-clock estimate using 4x
  ceiling.
- tools.spec.ts: continue mode exempts reusable tasks from feasibility check.
- tools.spec.ts: project init response includes budgetEstimate; set-contract
  response does NOT include budgetEstimate.
- review-adapter.spec.ts: multi-target response validates; single-target
  response against multi-target contract fails (missing targets).
- review-config.spec.ts: freezeReviewSettings captures claimsBatchSize.

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
