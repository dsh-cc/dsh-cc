## Status: Design — three-lane blind review converged (codex, grok and the internal
critic all GO: r1 full review, r2 delta verification, r3 micro-confirmation);
user sign-off and implementation pending. Fix 4 of the post-lane-2 batch.

All code anchors cite tree `8cf51b13` (main after #278/#279), verified by direct
source reading on 2026-10-23. Harness anchors cite `dsh` 0.2.0-rc.2
(`deepseek-harness` @ `c1b47e41fc`). Runtime evidence cites the 2026-10-22
reproduction (`run_e074af78` usage ledger, `run_a14a8039` audit record, test
project `prj_13485f41-…`).

## 1. Problem (Issue 7, P0)

The audit stages pack work into dispatch batches by INPUT size only. The
RESPONSE size is unbounded by the packing, so a call whose combined output
exceeds `maxOutputTokensPerCall` dies structurally:

- `packExtractionBatches` (audit-cost.ts:18-33) closes a batch when
  `stableJson(unit).length` would exceed `0.7 × maxContextChars`. Nothing in
  the function constrains the batch's OUTPUT.
- Measured (2026-10-22, `run_e074af78` usage.jsonl): a 19-unit single-batch
  extract produced **23,979 output tokens** against `maxOutputTokensPerCall`
  12,000 (schema ceiling 16,000, author.schema.json:292). The call ends
  `finish.kind === 'max-tokens'` → `ReviewTruncatedError`
  (review-adapter.ts:211).
- Truncation is already fail-fast (`maxAttempts = 1`, review-call.ts:194/198) —
  correct, but the failure is structural: the same batch shape can never
  succeed. No retry count and no budget raise fixes it (the cap is schema-capped).
- The align stage has the SAME exposure and no protection at all: one combined
  align call maps every extracted item (audit.ts:300-312), its schema allows
  1,000 alignment entries with 4,000-char rationales
  (review.schema.json:1036-1082), and nothing bounds its aggregated output.
  The reproduction's audit dies at extract before align is ever reached.
- The static estimate shares `packExtractionBatches` via `auditCostModel`
  (audit-cost.ts:42-51) — so it under-counts calls in the same direction.

This is the only hard blocker for a full `stage:"all"` review on the
reproduction project: all semantic stages completed and reusable, audit
structurally un-runnable.

## 2. Design

### F4.1 Dual-constraint packing, calibrated against the SHIPPED default budget

A batch closes when EITHER the input-char bound OR the unit-count bound is
reached. Both audit stages (extract and align) get bounded, each with its own
per-item output constant:

```ts
// audit-cost.ts
/** Per-unit extract response estimate. Anchors: the measured 23,979 tokens /
 * 19 units ≈ 1,262 tokens/unit is a LOWER bound (that call truncated); 1,000
 * is the conservative packing target, with bisect (F4.2) covering the miss. */
export const TYPICAL_UNIT_OUTPUT_TOKENS = 1_000
/** Per-item align response estimate (relation + claimIds + a short rationale;
 * the 4,000-char rationale cap is the worst case, not the typical). */
export const TYPICAL_ALIGNMENT_OUTPUT_TOKENS = 500
/** Headroom on the per-call output cap (same family as the 0.7 input factor). */
export const OUTPUT_BUDGET_SAFETY = 0.7

export function maxItemsPerBatch(maxOutputTokensPerCall: number, typicalOutputTokens: number): number {
  return Math.max(1, Math.floor((maxOutputTokensPerCall * OUTPUT_BUDGET_SAFETY) / typicalOutputTokens))
}
export const maxExtractUnitsPerBatch = (cap: number) => maxItemsPerBatch(cap, TYPICAL_UNIT_OUTPUT_TOKENS)
export const maxAlignItemsPerBatch = (cap: number) => maxItemsPerBatch(cap, TYPICAL_ALIGNMENT_OUTPUT_TOKENS)

export function packExtractionBatches(
  units: ExtractionUnit[],
  maxContextChars: number,
  maxItems = Number.POSITIVE_INFINITY,
): ExtractionUnit[][] { /* input-char bound OR batch.length >= maxItems closes a batch */ }
```

**Calibration is pinned to the shipped defaults, not the reproduction's
budget.** `review-max-output-tokens-per-call` defaults to **3,000**
(settings.ts:55), `review-max-output-tokens-per-run` 96,000, `maxCallsPerRun`
40 (settings.ts:52-54). With the numbers above:

| per-call cap | extract units/batch | align items/batch |
|---|---|---|
| 3,000 (shipped default) | 2 | 4 |
| 12,000 (reproduction) | 8 | 16 |
| 16,000 (schema max) | 11 | 22 |

19-unit arithmetic on the reproduction project (cap 12,000): 3 extract + 2
align = **5 audit calls** (was 2). At the shipped default (cap 3,000): 10
extract + 5 align = 15 calls → `ceil(15 × 1.5) = 23` with retry headroom →
`23 × 3,000 = 69,000 ≤ 96,000` and 23 ≤ 40 calls — the default budget still
admits a reproduction-scale artifact. **A 1-unit-per-call formula
(`floor(3000 × 0.7 / 1500) = 1`) would estimate 38 calls → 171,000 tokens and
refuse ordinary artifacts on the shipped default; the constants above exist to
prevent exactly that (r1 grok).**

Call sites (exhaustive per grep on `8cf51b13`):

1. **Runtime extract** — audit.ts:203:
   `packExtractionBatches(units, effectiveContextChars(input.caller), maxExtractUnitsPerBatch(input.maxOutputTokens))`
2. **Runtime align** — F4.3 below.
3. **Estimate** — feasibility.ts:66-71 passes `maxOutputTokensPerCall:
   budget.maxOutputTokensPerCall` into `auditCostModel`.
4. **Test helper** — tests/feasibility.spec.ts:85 (`auditEstimate`) must pass
   the new field (owned edit, see §4).

`auditCostModel` becomes:

```ts
export function auditCostModel(input: {
  artifactText: string; maxUnitChars: number; maxContextChars: number
  maxOutputTokensPerCall: number
}): { units: number; extractBatches: number; alignBatches: number; calls: number }
// calls = extractBatches + alignBatches   (replaces the old "+ 1 align")
```

### F4.2 Estimate/runtime context parity (r1 critic major)

Today the runtime packs with `?? Number.POSITIVE_INFINITY` (audit.ts:203) while
the estimate packs with `?? 48_000` (feasibility.ts:70) — in the input-bound
regime the estimate and runtime disagree, and the `Infinity` fallback is
anyway fake (ReviewCaller's context gate is 48,000 chars, review-call.ts:58/115;
an oversized packed envelope throws `CONTEXT_TOO_LARGE`). Fix:

```ts
export const DEFAULT_REVIEW_CONTEXT_CHARS = 48_000
export const effectiveContextChars = (caller?: { maxContextChars?: number }) =>
  caller?.maxContextChars ?? DEFAULT_REVIEW_CONTEXT_CHARS
```

`audit.ts` and `auditCostModel`/`feasibility.ts` both resolve through it, and a
parity test asserts identical batch counts for the same inputs (§4.5).

### F4.3 Bounded align: chunked dispatch, merged alignment

`executeAudit`'s align stage (audit.ts:300-312) splits derivations into chunks
of `maxAlignItemsPerBatch(input.maxOutputTokens)` and dispatches one align call
per chunk. Each chunk's envelope is the existing `alignEnvelope` shape with
`items` restricted to that chunk (`currentReviewRecords`, claims, searches,
artifact stay shared context). Per chunk:

- parse + `validateAlignment(response, chunkDerivations, claimIds)` on the
  chunk's own derivations;
- `validateTaskResponse` per chunk (same targetIds / requiredRules);
- append the chunk's `alignment` entries and its non-runtime-owned `findings`.

After all chunks complete, merge into ONE `AlignResponse` before the record is
written. Merge contract (exact, no ambiguity):

- `stage` / `rubricVersion`: identical across chunks (assert); take the first.
- `alignment`: concatenation of chunk arrays. Then the existing
  per-derivation reordering (audit.ts:314-316) runs over the merged array, and
  `validateAlignment(merged, derivations, claimIds)` re-runs on the whole set
  as the final coherence gate (`AlignEntry` requires exactly one entry per
  extractedId, claimIds ≤ 1000 each — review.schema.json `AlignEntry`).
- `targets`: union by `targetId` (each chunk's `validateTaskResponse` already
  checked its own set; the union is what the record persists).
- `findings`: concatenation of chunk arrays WITHOUT the runtime-owned AUDIT_*
  codes, then the runtime-derived AUDIT_NEW_CLAIM / AUDIT_STRONGER /
  AUDIT_BROADER findings (audit.ts:324-353) are derived from the MERGED
  alignment exactly as today.
- `inputTokens` / `outputTokens` on the align record: SUMS across align calls.

One align record per artifact is preserved — identity (audit-reuse.ts:34-62)
is untouched.

Accepted cost, stated for the implementer: each align chunk re-sends the shared
context (claims, artifact text, searches). At the reproduction's scale this is
2 chunks; input tokens scale with chunk count and the reservation counts each
call honestly.

### F4.4 Truncation bisect (both stages)

The packing constants are heuristics; a dense unit set can still truncate.
Re-dispatching the identical shape can never succeed, so both stage loops
split-and-continue instead:

```ts
const queue: ExtractionUnit[][] = [...extractBatches]
while (queue.length > 0) {
  const batch = queue.shift()!
  try { /* existing dispatch body */ }
  catch (error) {
    if (error instanceof ReviewTruncatedError && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2)
      queue.unshift(batch.slice(0, mid), batch.slice(mid))
      continue
    }
    throw error
  }
}
```

Align chunks use the same loop over derivation chunks.

Semantics, verified by r1 (all three seats):

- **Bisect dispatches are new calls, not retries** — own reservation and usage
  rows; the F1.4 retry pool is not charged (truncation throws at
  review-call.ts:198, before the pool debit at :204-208); `retryOf` absent.
- **Order preserved** (`unshift` with left,right); every split strictly shrinks
  a batch, so no starvation; a fully split n-unit batch costs at most `2n−1`
  extract dispatches.
- **Budget interaction** — bisect calls consume `maxCallsPerRun` /
  `maxOutputTokensPerRun`; if a bisect cannot reserve, the run fails
  `BUDGET_EXHAUSTED`. Accepted: the static packing makes bisect the rare
  escape, not the plan.
- **Single-item truncation rethrows.** Attach the guidance sentence on the
  AUDIT rethrow site only (audit.ts extract catch): "a single extraction unit
  exceeds the per-call output cap — split the artifact root block." Do NOT
  touch `ReviewTruncatedError`'s shared message (review-adapter.ts:65): every
  stage reuses it, and `errorRecord` copies `error.message` verbatim
  (review-runner.ts:190-192) (r1 grok). Raising `maxOutputTokensPerCall` is a
  valid escape only after Fix 5 lands — the Fix 4 PR must NOT recommend it
  (r1 critic cross-cutting).
- **No partial persistence.** The extract record is written only after ALL
  batches complete; if a later batch fails, a continuation repeats the earlier
  successful dispatches (known cost, unchanged from today — do not claim
  otherwise).

## 3. Migration / compatibility

- `auditInputHash` (audit-reuse.ts:34-62) is artifact-level and contains no
  batch composition → records from earlier packing shapes stay reusable across
  re-packing. **Qualification (r1 codex): until Fix 5 lands, revising
  `budget.maxOutputTokensPerCall` still changes the adapter fingerprint, so
  audit records written after Fix 4 are wiped by the Fix 5+6 identity reset —
  the Fix 4 PR body must say so, so nobody treats a just-finished audit as
  durable across the identity PR.**
- `plannedCalls.audit` grows (2 → 5 at the reproduction's 12k cap; 2 → 15 at
  the shipped default). Honest. Consequence to disclose: artifacts whose
  audit estimate previously fit `maxCallsPerRun`/`maxOutputTokensPerRun` can
  now be refused (`BUDGET_INSUFFICIENT`) with the existing dimension-aware
  guidance (feasibility.ts:143-159) — that is the correct outcome, not a
  regression to hide.
- No schema, settings, or refusal-copy change.

## 4. Tests (TDD; `packages/interaction/vwa-argument/tests/`)

1. `maxItemsPerBatch` / `maxExtractUnitsPerBatch` / `maxAlignItemsPerBatch`:
   3,000 → 2 / 4; 12,000 → 8 / 16; 16,000 → 11 / 22; 256 (schema minimum) → 1 / 1.
2. `packExtractionBatches` dual constraint: 7 small units, `maxItems = 5` →
   `[5, 2]`; odd splits; `Infinity` default keeps the input-only behavior.
3. `auditCostModel` new shape: a 19-unit synthetic artifact at cap 12,000 →
   `extractBatches = 3`, `alignBatches = 2`, `calls = 5`; at cap 3,000 →
   `10 / 5 / 15`.
4. **Default-budget feasibility pin (r1 grok #1/#11)**: a reproduction-scale
   artifact (19 units) with the SHIPPED defaults (3,000 per-call, 96,000 run,
   40 calls) is feasible — `estimatedWithRetries = 23`,
   `estimatedOutputTokens = 69,000`; assert `budgetFeasibilityRefusal` returns
   undefined. This is the test that fails if a future constant tweak collapses
   packing to one item per call.
5. **Estimate/runtime parity pin (r1 critic)**: for the same artifact and
   context, `auditCostModel(...).calls` equals the number of dispatches the
   real `executeAudit` makes with a fake adapter — including the 48k-default
   path (no caller context configured).
6. **Owned spec migrations (r1 grok #2)**: `tests/feasibility.spec.ts:84-89`
   helper gains the new field; the existing context-sensitivity pin
   (feasibility.spec.ts:109-120) is re-expressed so it tests context effects
   at a cap where packing can actually vary; `tests/audit.spec.ts`
   (fixtures `maxOutputTokens: 3000`, dispatch-order assumptions at
   :33-36/:87 and the two budget fixtures at :545-546/:579-580) is updated for
   multi-dispatch extract and chunked align — this fix intentionally changes
   dispatch counts.
7. Bisect pins: (a) truncation at >1 item → all items returned, extra
   dispatches in the ledger, zero retry-pool units consumed; (b) odd splits
   and multiple queued batches in exact dispatch order; (c) single-item
   truncation rethrows `REVIEW_TRUNCATED` with the root-block guidance; (d) a
   non-truncation error propagates unchanged; (e) `BUDGET_EXHAUSTED` raised
   from a bisect dispatch surfaces as the run's budget failure.
8. Align chunking: 19 derivations at cap 12,000 → 2 align dispatches, merged
   alignment covers every derivation in order, findings concatenated, sums on
   the align record; a chunk-level truncation bisects.
9. Full battery: `vitest vwa-argument` + `packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts`
   (budget/packing semantics change — mandatory house rule; its fixture budget
   is explicit, see preset-realboot trap).

## 5. Out of scope

- Per-batch partial-success persistence (would fragment artifact-level audit
  identity for marginal benefit).
- Modeling bisect headroom in the static estimate (bisect is the escape hatch;
  the runtime budget guards it).
- Any change to `maxOutputTokensPerCall` schema ceilings (16,000 stays), and
  no settings-default change in this PR.

## 6. Implementation order

Standalone PR, no dependency on Fix 5/6. Land BEFORE Fix 5+6 so the
reproduction's `stage:"all"` unblocks without the identity reset.

## 7. Design review ledger (r1)

| seat | verdict | majors folded |
|---|---|---|
| codex | GO-with-majors | align has no capacity strategy (→ F4.3 chunking); doc claims corrected |
| grok | GO-with-majors | shipped-default 3,000 cap collapses the formula to 1 unit (→ F4.1 recalibration + §4.4 pin); existing spec breakage owned; vacuous align-residual claim |
| critic | GO-with-majors | estimate/runtime input-context divergence (→ F4.2 parity); test-spec errors; bisect-vs-budget pin |

Codex's §F4.3 demand ("extract bisection cannot repair align") is met by
align chunking rather than a residual-risk note.

### r2 (delta verification, folds 1-7 + cross-cutting 13-14)

- codex: 14/14 OK — `VERDICT: GO` (all D1 folds verified against the code they
  name; no new findings).
- grok: 11/11 OK — `VERDICT: GO` (fold locations and the named anchors match;
  no new findings).
- critic: 10/10 OK after re-spawn (the first instance stalled) — `VERDICT: GO`
  (parity pin, spec migrations, feasibility-growth disclosure, cap-raise
  gating, align-surface work all verified in place; no new findings).

### r3 (micro-confirmation)

- codex: r2 raised one PROBLEM, which lived in Fix 6 (not this doc); it was
  folded in D3 and confirmed OK at r3. Fix 4 has no open item: three lanes,
  all GO.
