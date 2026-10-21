# VWA lane-2 Hardening — Feature D: Report Observability and Authoring UX

## Status: Implemented — PR #272 (open, pending merge). Three-lane blind review converged (critic + two external lanes, seven rounds, final round GO on all lanes).

This document is one of six feature designs split from the combined
lane-2 reliability hardening design. It addresses Problems 7, 8, 10 and 11 from the tui-40b4 session.
Dependencies: Feature B (the failures array surfaces `errorDetail`) and Feature C (batch-size-aware stage totals).

The twelve session problems were each verified against current code at
HEAD 7960c4ff before design work began; all anchors below cite that tree.

## Feature D: Observability and Authoring UX

### D.1 Problem 7: Misleading TypeError on missing op

`guard` (tool-input.ts:50-67) validates `input` is an object but not
`input.op`. `applyMutation` (graph.ts:181) falls through to `bind-artifact`
for any unrecognized op, and `applyBindArtifact` (artifact.ts:74) calls
`path.endsWith` on undefined → TypeError with no mention of the missing field.

**Fix**: validate the op enum at the mutation entrance, before dispatch:

```ts
// In graph.ts applyMutation, before the if/else chain:
const VALID_OPS = new Set(['set-contract', 'upsert', 'bind-artifact'])
if (typeof mutation.op !== 'string' || !VALID_OPS.has(mutation.op)) {
  reject('SCHEMA_INVALID', `missing or unknown op: got ${JSON.stringify(mutation.op)}; expected one of set-contract, upsert, bind-artifact`)
}
```

Also validate that `upsert` mutations have the required fields:

```ts
if (mutation.op === 'upsert') {
  if (!Array.isArray(mutation.creates) || !Array.isArray(mutation.updates) || !Array.isArray(mutation.deletes)) {
    reject('SCHEMA_INVALID', 'upsert requires creates, updates, and deletes arrays')
  }
}
```

This closes the class of "missing field → TypeError" failures, not just the
named symptom.

### D.2 Problem 8: Report stage-level progress

The report conflates "never reviewed" with "reviewed and failed" in the
`draft` status. Failed runs are invisible (filtered out of currentReviews by
`status === 'completed'`).

**Fix**: add a per-stage progress summary and per-task failure detail to the
report.

**D.2.1 Stage progress computation.**

New computed field in the report input (delivery-check.ts):

```ts
stageProgress: Record<ReviewStage, {
  total: number           // planned task count (accounts for batching)
  completed: number       // tasks with a completed record
  failed: number          // tasks whose latest record has status error/budget-exhausted
  notRun: number          // total - completed - failed
  lastRunStatus?: string  // most recently ended task status (legacy JSON field name)
  channelErrors: number   // error records with errorCode in channel set
  schemaErrors: number    // error records with errorCode REVIEW_INVALID
  budgetErrors: number    // error records with errorCode BUDGET_EXHAUSTED
}>
```

`total` is the planned task count from `planStage` with the same batch size
as the runner (Feature C.2.3) — a batched claims stage with 6 claims and
batch size 3 has `total: 2`, not `total: 6`.

Current task counts use the same task identity as delivery freshness:
entity versions, dependency digest, contract, policy, prompts, reviewer
configuration, and scope-dependent rules must match. Historical failures
remain in the failure list and error buckets, but cannot complete or fail a
current task. New semantic failure records persist the task input hash;
legacy unsigned failures remain available as history.

For a bound artifact, `audit.total` is one. Completion requires a completed
`extract` and `align` pair from the same run and input hash, with current
artifact, dependency, contract, policy, prompt, and reviewer inputs. Aggregate
`audit` errors carry artifact references, content hash, and dependency digest;
they appear in the failure list and count as failed only for matching inputs.
An extraction record alone does not complete the audit.

Error classification:
- **Channel**: REVIEW_UNAVAILABLE, REVIEW_TRUNCATED, REVIEW_CONFIG_DRIFT,
  timeout
- **Schema**: REVIEW_INVALID (model output failure, not transport)
- **Budget**: BUDGET_EXHAUSTED, CONTEXT_TOO_LARGE

`lastRunStatus` retains its original JSON field name for compatibility, but
reports the most recently ended task, not the aggregate run status. The
markdown column is labeled "last task". Records are ordered by `endedAt`,
then `startedAt`; equal timestamps prefer error, budget-exhausted,
cancelled, then completed, with `runId` as a final deterministic tie-breaker.
This applies to semantic stages and the audit extract/align/error records.
A cancelled run without a task record does not change this field.

`stageProgress` is computed from the **full run store** (allRecords), not
from `currentReviews` — failed records are invisible to currentReviews.

**D.2.2 Per-task failure detail.**

New report field:

```ts
failures: Array<{
  stage: ReviewStage
  targetIds: Id[]
  errorCode: string
  errorDetail?: ReviewRecord['errorDetail']  // from Feature B
  runId: Id
  endedAt: string
}>
```

This surfaces the Feature B error detail in the report so the author can
diagnose "which tasks failed and why" without reading raw record files.

**D.2.3 Report rendering.**

Report rendering (report-render.ts) adds a "Review progress" section between
the checks table and the findings list:

```
## Review progress
| stage | completed | failed | not run | last task |
|-------|-----------|--------|---------|----------|
| sources | 3/3 | 0 | 0 | completed |
| support | 4/5 | 1 (channel) | 0 | error |
| claims | 0/6 | 0 | 6 | — |

### Failures
| stage | targets | error | detail |
|-------|---------|-------|--------|
| support | grp_abc | REVIEW_UNAVAILABLE | HTTP 502 (attempt 2/2) |
```

The JSON report variant includes `stageProgress` and `failures` verbatim.

**D.2.4 Draft status disambiguation.**

The top-level `statusOf` gains a fourth value: `'review-in-progress'` when
any stage has `completed > 0` but the overall delivery is not eligible. This
distinguishes "never started" (draft) from "partially reviewed"
(review-in-progress) from "reviewed candidate".

### D.3 Problem 10: Disk-hash drift warning

Re-registering an edited file silently creates a NEW source (dedup key
includes new hash, sources.ts:302-305). No warning that the original file
changed since a prior registration.

**Fix**: at register time, compare the disk file's hash against the stored
snapshot hash of any existing source with the same original path/locator.

Mechanism: `registerSource` already reads the file and computes its hash.
Before creating a new source, check if any existing source has the same
`originalLocator` (or `path` field). If found and `diskHash !== existing.snapshotHash`,
include a `driftWarning` in the response only when registration creates a
new source. A dedup hit emits no warning, including repeat registration of
the edited content or a reversion to an already registered snapshot:

```json
{
  "ok": true,
  "data": {
    "sourceId": "src_new...",
    "driftWarning": "File content has changed since source src_old... was registered (hash ... → ...). The old source's snapshot is unchanged; reviews referencing it used the old content. Register created a new source. To update in place, delete the old source and re-register."
  }
}
```

This is a warning, not an error — the register succeeds (creating a new
source is the correct behavior; the user just needs to know).

### D.4 Problem 11: Deletion reference diagnostics and cascade

`findReferences` (graph.ts:339-373) lists all referencing categories but only
as labels ("group target", "search log") without specific entity IDs. No
cascade delete option.

**Fix**: two changes.

**D.4.1 Enriched reference diagnostics.**

`findReferences` returns `{kind, id, role}[]` instead of `string[]`:

```ts
export interface ReferenceInfo {
  kind: 'source' | 'evidence' | 'claim' | 'group' | 'argument' | 'issue' | 'search' | 'artifact'
  id: Id
  role: string  // e.g., 'target', 'evidenceIds', 'targetIds', 'occurrence', 'scope.corpus'
}
```

The `kind` field includes `'claim'` to represent `claim.scope.corpus`
references (currently omitted from findReferences).

The `REFERENCE_IN_USE` error message includes specific IDs:

```
cl_foo is still referenced by: group grp_bar (target), search srch_baz (targetIds), artifact art_qux (occurrence)
```

The `details` field carries the full reference list:

```json
{
  "code": "REFERENCE_IN_USE",
  "details": {
    "references": [
      {"kind": "group", "id": "grp_bar", "role": "target"},
      {"kind": "search", "id": "srch_baz", "role": "targetIds"},
      {"kind": "artifact", "id": "art_qux", "role": "occurrence"}
    ]
  }
}
```

**D.4.2 Cascade delete with closure computation.**

`argument.update` gains an optional `input.cascade: true` flag on the upsert
op. When set, deleting an entity also deletes all entities that reference it,
recursively.

**Closure computation**: before any deletion, compute the full deletion
closure:

```ts
function computeDeletionClosure(graph: GraphContext, rootIds: Id[]): Id[] {
  const closure = new Set<Id>(rootIds)
  const queue = [...rootIds]
  const order: Id[] = []
  while (queue.length > 0) {
    const id = queue.pop()!
    order.push(id)
    for (const ref of findReferencesDetailed(graph, id)) {
      if (!closure.has(ref.id)) {
        closure.add(ref.id)
        queue.push(ref.id)
      }
    }
  }
  return order  // BFS order: roots first, leaves last
}
```

This handles cycles (e.g., source authenticity referencing evidence that
references the source) because `closure` is a Set — each entity is visited
at most once. The returned `order` array is in BFS order (roots first,
leaves last); deletion proceeds in reverse order (leaves first).

**Atomic delete**: all entities in the closure are deleted in a single
transaction. `postValidate` runs after ALL deletes (not between them), so
intermediate states are never validated. If validation fails, the entire
transaction rolls back (existing store.ts:438-451 behavior).

**Response**: the response includes `cascadeDeleted: Id[]` listing every
entity that was cascade-deleted, in deletion order (leaves first). Without
the flag, the current REFERENCE_IN_USE error is returned with the enriched
details.

**Skill documentation**: the skill doc gains one sentence: "Cascade delete
removes all entities that reference the target, including arguments whose
premise list references a deleted claim. This is destructive — the response
lists every cascade-deleted entity for verification."

### D.5 Implementation

1. `graph.ts`: op enum validation in applyMutation; upsert field validation;
   enriched findReferences returning ReferenceInfo[] (including
   claim.scope.corpus); computeDeletionClosure; cascade delete in
   deleteEntity.
2. `tool-input.ts`: no changes (guard stays coarse; op validation is in
   applyMutation where the Mutation type is available).
3. `delivery-check.ts`: compute stageProgress from full run store (with
   batch-size-aware total); compute failures array.
4. `report-render.ts`: render stage progress section and failures table; add
   'review-in-progress' status.
5. `sources.ts`: drift detection in registerSource.
6. `types.ts`: stageProgress, failures, ReferenceInfo types; cascadeDeleted
   in MutationOutcome.
7. `tools.ts`: pass `cascade` flag through; include cascadeDeleted in response.
8. `SKILL.md`: add cascade delete warning.

### D.6 Tests

- graph.spec.ts: missing op → SCHEMA_INVALID with clear message; unknown op
  → SCHEMA_INVALID; upsert missing creates/updates/deletes → SCHEMA_INVALID;
  valid ops still work.
- graph.spec.ts: REFERENCE_IN_USE includes entity IDs in message and details;
  claim.scope.corpus references are detected (kind: 'claim').
- graph.spec.ts: cascade delete removes referencing entities; closure handles
  cycles; response lists cascadeDeleted in leaf-first order; without cascade
  flag, REFERENCE_IN_USE as before.
- delivery-check.spec.ts / report.spec.ts: stageProgress computed correctly
  for mixed completed/failed/not-run stages; total accounts for batching;
  failures array includes errorDetail; report renders progress table and
  failures; 'review-in-progress' status when partially reviewed.
- sources.spec.ts: re-register edited file → driftWarning in response; same
  file unchanged → no warning; new file → no warning.

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
