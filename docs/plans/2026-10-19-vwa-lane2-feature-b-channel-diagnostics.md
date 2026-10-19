# VWA lane-2 Hardening — Feature B: Review Channel Diagnostics and Retry Hardening

## Status: Implemented — PR #266 (open, pending merge). Three-lane blind review converged (critic + two external lanes, seven rounds, final round GO on all lanes); user sign-off given to implement.

This document is one of six feature designs split from the combined
lane-2 reliability hardening design. It addresses Problems 2, 3 and 4 from the tui-40b4 session.
Dependencies: None.

The twelve session problems were each verified against current code at
HEAD 7960c4ff before design work began; all anchors below cite that tree.

## Feature B: Channel Diagnostics and Retry Hardening

### B.1 Problem

Three related reliability gaps:

1. **Error detail lost** (problem 2): `errorRecord` writes only `errorCode`.
   Transport errors become `Error('review dispatch failed: error')`
   (review-adapter.ts:166-168) — provider HTTP status, stream error message,
   and model raw text are all lost. REVIEW_UNAVAILABLE is the fallback for
   every unrecognized error.
2. **Static timeout** (problem 3): `review-call-timeout-ms` defaults to 45s,
   max 120s, independent of input size (settings.ts:56, review-call.ts:60-63).
   A 20k-token input on a slow route times out.
3. **Insufficient retry** (problem 4): exactly one repair retry for
   REVIEW_INVALID (review-call.ts:37 `attempt < 2`), no backoff. Models with
   30–40% invalid-JSON rates fail after one retry 9–16% of the time. Transient
   errors also get only one bare retry.

### B.2 Design

**B.2.1 Structured error detail in review records.**

Extend `ReviewRecord` (types.ts) with an optional `errorDetail` field:

```ts
interface ReviewRecord {
  // ... existing fields ...
  errorDetail?: {
    message: string           // error.message, truncated to 500 chars
    httpStatus?: number       // from finish.failure.status, when available
    providerCode?: string     // from finish.failure.code
    providerRetryAfterMs?: number  // from finish.failure.providerRetryAfterMs
    rawResponseTail?: string  // last 2000 chars of model raw output (when
                              // parse or schema validation failed; absent
                              // for dispatch-level errors)
    retryAttempts: number     // how many attempts were made (1 = no retry)
  }
}
```

**B.2.2 Error enrichment at the adapter dispatch site.**

The `BlockAssembler.finish` getter returns a `FinishReason` that, for
`kind: 'error' | 'aborted'`, carries a `failure: LlmFailure` object with
`status?: number`, `code: string`, `message: string`, and
`providerRetryAfterMs?: number` (dsh-llm types.ts:41-58, FinishReasonMap
at :156-165). The adapter currently discards all of this
(review-adapter.ts:166-168).

Change the dispatch error path to attach the failure object:

```ts
// review-adapter.ts, in dispatch():
const finish = assembler.finish
if (finish.kind === 'error' || finish.kind === 'aborted') {
  const err = new Error(`review dispatch failed: ${finish.failure.message}`)
  ;(err as any).detail = {
    httpStatus: finish.failure.status,      // optional in LlmFailure
    providerCode: finish.failure.code,
    providerRetryAfterMs: finish.failure.providerRetryAfterMs,
  }
  throw err
}
```

For `ReviewInvalidError` thrown by `parseReviewResponse` (JSON parse failure),
attach the raw response tail:

```ts
// review-adapter.ts, in parseReviewResponse():
catch {
  const err = new ReviewInvalidError('response is not valid JSON')
  err.rawResponse = raw.slice(-2000)  // last 2000 chars
  throw err
}
```

For schema-mismatch failures (`validateReviewResponse` fails), also attach
the raw response tail — this is the "valid JSON but wrong shape" case that
is the most diagnostic:

```ts
// review-adapter.ts, in parseReviewResponse():
if (!validateReviewResponse(parsed)) {
  const err = new ReviewInvalidError(`response schema mismatch: ${ajvErrors(validateReviewResponse)}`)
  err.rawResponse = raw.slice(-2000)
  throw err
}
```

For `validateTaskResponse` failures (called from the runner's parse callback,
review-runner.ts:312), the raw response is not available at that call site —
the response has already been parsed. `rawResponseTail` is absent for these
failures. This is acceptable: the error message names the specific rule
violation (e.g., "fabricated target id"), which is more diagnostic than the
raw JSON.

Note: `ReviewInvalidError` thrown by the dispatch path ("expected exactly one
respond tool call") has no raw response to attach; `rawResponseTail` is
absent in that case.

`ReviewCaller.call` reads `error.detail` (transport) and `error.rawResponse`
(parse/schema) when constructing the error record.

**B.2.3 Dynamic timeout.**

Replace the fixed `callTimeoutMs` with a computed timeout that scales with
input size:

```ts
const computedTimeoutMs = Math.max(
  budget.callTimeoutMs,  // floor: the configured setting
  Math.min(
    budget.callTimeoutMs * 4,  // ceiling: 4x the setting
    budget.callTimeoutMs + counted.tokens * 2,  // +2ms per input token
  ),
)
```

When the tokenizer is unavailable, `counted.tokens` is a byte count
(bytes-upper-bound method). The formula is still correct: 2ms per byte is
more conservative than 2ms per token, so byte-counted inputs get a larger
timeout — safe direction.

The existing `Math.min(timeout, remainingMs())` guard is retained. With the
default 45s floor and 180s wall, the ceiling is 180s — tight but acceptable.
A call that consumes the full wall leaves no room for a retry; the retry
loop checks `remainingMs()` before each attempt and skips the retry if
insufficient time remains.

**B.2.4 Retry policy with backoff and classification.**

Classify errors into four retry classes:

| Class | Errors | Retry policy | Backoff |
|---|---|---|---|
| `invalid` | ReviewInvalidError from parse/schema/validation | Up to 3 attempts (2 retries) | Exponential: 1s, 4s |
| `transient` | Timeout, transport error (finish.kind = error), 429, 5xx | Up to 2 attempts (1 retry) | Fixed: 5s, or `providerRetryAfterMs` when available |
| `truncation` | finish.kind = max-tokens (output cap hit) | No retry — permanent | — |
| `permanent` | Budget exhausted, cancelled, config change, CONTEXT_TOO_LARGE | No retry | — |

**Truncation is permanent, not invalid.** A response that hits
`maxOutputTokensPerCall` is truncated mid-JSON → parse failure →
REVIEW_INVALID. Retrying with the same output cap cannot succeed. The
adapter detects truncation by checking `finish.kind === 'max-tokens'` before
attempting to parse; it throws a `ReviewTruncatedError` (new, code
`REVIEW_TRUNCATED`) classified as permanent.

**Config drift is permanent.** `ReviewInvalidError('reviewer configuration
changed during the run')` (review-adapter.ts:102-103) is currently thrown as
REVIEW_INVALID. Change to a new `ReviewConfigDriftError` (code
`REVIEW_CONFIG_DRIFT`) classified as permanent.

**Backoff respects wall clock.** Before each backoff sleep, check
`remainingMs()`. If the remaining wall is less than the backoff duration,
skip the sleep and proceed immediately (or skip the retry if no time
remains). The sleep itself is abortable via `signal`.

**Budget-aware retry limits.** Each attempt reserves `maxOutputTokensPerCall`
from the budget. With the default 24K output budget and 3K per-call cap,
a run has ~8 reservations. Three invalid attempts on one task cost 9K.
The runner must stop retrying when the budget is exhausted (existing
`ReviewBudgetError` behavior) and report the actual attempts made in
`errorDetail.retryAttempts`.

**Usage ledger.** Each attempt appends its own `reserved`/`actual`/`error`
row. The `seq` field is the global call number (existing semantics, not
task-local). A new `retryOf?: string` field on UsageRow links a retry row to
the original attempt's `taskId:seq`, making dedup queries possible.

### B.3 Implementation

1. `types.ts`: add `errorDetail` to ReviewRecord; add `ReviewTruncatedError`
   and `ReviewConfigDriftError` classes.
2. `review-adapter.ts`: enrich dispatch errors with `finish.failure` fields;
   add `rawResponse` to parse-failure and schema-mismatch ReviewInvalidError;
   detect truncation before parse; distinguish config drift.
3. `review-call.ts`: dynamic timeout computation; class-aware retry loop with
   backoff; pass `retryAttempts` and `detail` to error records; honor
   `providerRetryAfterMs` for 429 backoff.
4. `review-runner.ts`: `errorRecord` reads `error.detail` and
   `error.rawResponse`; populates `errorDetail`.
5. `review-run-store.ts`: add `retryOf` to UsageRow.

### B.4 Tests

- review-call.spec.ts: dynamic timeout formula (0 tokens → base; 20k tokens →
  base+40s; 100k tokens → ceiling 4x).
- review-call.spec.ts: invalid class retries 3 times with exponential backoff;
  transient retries 2 times with fixed backoff; truncation and permanent
  retry 0 times.
- review-call.spec.ts: backoff respects abort signal and remaining wall.
- review-call.spec.ts: 429 with providerRetryAfterMs uses that delay.
- review-runner.spec.ts: error record includes errorDetail with message,
  httpStatus (when available), retryAttempts.
- review-adapter.spec.ts: dispatch error carries finish.failure.status;
  parse error carries rawResponseTail; schema mismatch carries
  rawResponseTail; truncation detected as permanent; config drift detected
  as permanent.
- review-run-store.spec.ts: retryOf linkage in usage rows.

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
