# VWA audit extract: close the `scope` prompt/schema/validation gap

Date: 2026-10-26
Status: Implemented (PR open)

## 1. Problem

The audit **extract stage** asks an independent model to extract checkable items
from an artifact, then validates the response against
`review.schema.json#/$defs/ExtractedItem`. Three surfaces disagree about the
shape of `atomicClaims[].scope`:

1. **Prompt** (`prompts/extract.md`, line 9): lists `atomicClaims` as
   "text, kind, scope, importance" — nothing about the required subfields of
   `scope`.
2. **Forced-tool schema** (`src/audit-input.ts:182`,
   `EXTRACT_RESPONSE_SCHEMA`): `scope: { type: 'object' }` — any object (or
   empty `{}`) passes.
3. **Post-hoc validation** (`validateExtractItems`, `src/audit-input.ts:223`):
   `reviewDefValidator('ExtractedItem')` resolves
   `ExtractedItem.atomicClaims.items.scope → author.schema.json#/$defs/Scope`,
   which is `additionalProperties: false` and **requires**
   `subject`, `corpus`, `time`, `geography`, `exclusions`.

A model that follows the prompt and the tool schema (sending `{}` or a partial
scope) fails step 3 with `extract response schema mismatch`, classified
`invalid` in `review-call.ts` (`maxAttempts = 3` with a repair prefix).
Because neither the prompt nor the tool schema ever names the subfields,
the repair retry is guesswork: each attempt burns an output-token reservation
(Fix 6 accounting), and after three attempts the whole audit fails.
(Live-probed by two review seats: `scope: {}` fails with all five
required-property errors.)

Documenting all five subfields IS technically possible — `corpus: []`
is a valid `SourceId[]` — but it would make the model emit
boilerplate (`'unspecified'` strings, `[]` arrays) per atomic claim,
inflating extract output tokens against the Fix 4 budget calibration
(per-call default cap 3000 output tokens, `maxExtractUnitsPerBatch`
derived from a typical-unit estimate), and it would leave the pipeline
fragile: any deviation still routes into the three-retry failure mode.

## 2. Decision

**Normalize (default-fill) `scope` at validation time, in
`validateExtractItems`, before the strict validator runs.** The prompt and
tool schema name the four prose-capturable keys (`subject`, `time`,
`geography`, `exclusions`) so the model can capture real bounds when stated,
but `corpus` is never requested and no boilerplate is demanded — the runtime
fills defaults.

Rationale:

- Requiring five explicit fields per atomic claim is token-heavy boilerplate
  that works against the Fix 4 budget calibration; default-fill is
  resilient by construction (any scope shape, including `{}` and non-objects,
  becomes a strict `Scope`).
- Default-fill keeps the persisted shape unchanged: the
  `ExtractionRecord.response.items` still contain full `Scope` objects, so
  the align envelope (`AlignEnvelope`'s `atomicClaims[].scope?: Scope`,
  passed through in `audit-align.ts:77`) and downstream
  `stronger`/`broader` judgments need zero changes.
- The alternative "relax `ExtractedItem.scope` to a loose object in
  `review.schema.json`" changes the persisted shape and churns reuse via
  `policyHash()` (the review schema participates in the policy hash), for no
  benefit.

`'unspecified'` is the canonical "no constraint" literal already declared by
`author.schema.json#/$defs/Scope`'s own description (for time/geography);
using it as the default for `subject` is a documented extension of the same
convention.

## 3. Spec

### 3.1 `normalizeExtractedScope` (new, `src/audit-input.ts`)

```ts
const SCOPE_STRING_DEFAULT = 'unspecified'
```

Input: the raw `scope` value of one atomic claim (may be anything, including
non-objects). Output: a strict `Scope`. Rules (lenient in, strict out):

- Non-object (missing, string, number, array, null) → full default:
  `{ subject: 'unspecified', corpus: [], time: 'unspecified',
  geography: 'unspecified', exclusions: [] }`.
- `subject` / `time` / `geography`: if a string, canonicalize as
  `trim().slice(0, 512).trimEnd()`; if the result is empty (or the value was
  not a string — no coercion, e.g. numeric `2024` → default), use
  `'unspecified'`. Truncation of over-long values is **intentional**: an
  over-verbose scope string should not fail the audit.
- `corpus`: **always `[]`**. The extraction model has no sources list in the
  `ExtractEnvelope` and cannot be trusted to emit legitimate `SourceId`s;
  well-formed hallucinated ids must not persist into extraction records or
  the align envelope.
- `exclusions`: if an array, keep only string entries, canonicalize each as
  above (dropping ones that become empty), then `slice(0, 1000)` (the
  schema's `maxItems`); non-array or absent → `[]`.
- Unknown keys are dropped (`additionalProperties: false` downstream).

**Freshness**: every return allocates a new object with new arrays — the
default scope constants are never shared by reference across claims
(no array aliasing between items).

**Value-level idempotence**: a canonicalized value maps to itself
(`normalize(normalize(x))` structurally equals `normalize(x)`, including
truncation boundaries), so the second `validateExtractItems` call over
collected batches (`audit.ts:250`) is safe. Already-valid but non-canonical values
(e.g. `" s "`, whitespace-only) are canonicalized rather than passed
through — the round-trip contract is "canonical values are stable", not
"any valid value is byte-identical".

### 3.2 Insertion point (`validateExtractItems`, `src/audit-input.ts`)

Per raw item, BEFORE `reviewDefValidator('ExtractedItem')` runs:

- Shallow shape guard: `raw` must be an object with `atomicClaims` an array
  (and each entry an object) before normalization is attempted; malformed
  input falls through to the strict validator unchanged, which produces the
  existing error surface.
- Each atomic claim is replaced by
  `{ ...claim, scope: normalizeExtractedScope(claim.scope) }`.
- The strict `reviewDefValidator('ExtractedItem')` then runs on the
  normalized item — the validator itself is NOT modified (defense in depth
  stays; a normalized item that still fails, e.g. `text` over 2000 chars,
  still throws `extract response schema mismatch`).

### 3.3 Prompt (`prompts/extract.md`, line 9)

Extend the `atomicClaims` parenthetical to explain `scope` semantics:

> `scope`: if the sentence states explicit temporal, geographical, subject,
> or exclusion bounds, capture them under the keys `time`, `geography`,
> `subject`, `exclusions` (strings; `exclusions` is a string array); if none
> is stated, an empty object `{}` is correct — the runtime fills defaults.
> Never invent source references.

### 3.4 Tool schema (`EXTRACT_RESPONSE_SCHEMA`, `src/audit-input.ts`)

Replace `scope: { type: 'object' }` with a keyed, lenient object so
constrained decoding knows the acceptable keys:

```ts
scope: {
  type: 'object',
  description: 'Stated bounds only; {} is correct when none is stated. Never invent source references.',
  properties: {
    subject: { type: 'string' },
    time: { type: 'string' },
    geography: { type: 'string' },
    exclusions: { type: 'array', items: { type: 'string' } },
  },
}
```

No `corpus` key (never requested); **no `additionalProperties: false`** —
partial or extra keys must pass the tool layer and be cleaned by
normalization, not rejected before it. `scope` stays in `required` (the
model must at least emit `{}`).

### 3.5 Align prompt (`prompts/align.md`)

Add one sentence to the align contract:

> An extracted claim's `scope.corpus` is always empty by construction and
> MUST NOT by itself justify a `broader` relation.

## 4. Side effects (accepted)

- `policyHash()` hashes **every** prompt (`review-contract.ts`), and every
  review record's currentness check compares `r.policyHash === policyHash()`
  (`review-current.ts`). Changing `prompts/extract.md` (and `align.md`)
  therefore one-time-invalidates **all** existing review records — the
  semantic stages (sources/support/claims/arguments) as well as the
  extract/align pair. This is accepted: the invalidation is a one-time
  recomputation, correctness is unaffected, and the alternative (dropping
  the prompt edits and keeping runtime normalization only) forfeits the
  model's capture of real time/geography bounds, which feeds the align
  stage's `stronger`/`broader` judgments. Ruled out for this reason.
- `corpus` will be `[]` in extracted claims. This is honest: source
  attribution is unknown at extract time; scope comparison for
  `stronger`/`broader` happens in align, which receives the author claims'
  real scopes, and §3.5 guards against misreading the empty corpus as
  breadth.

## 5. Test plan (TDD)

In the vwa-argument package tests (extend the existing audit spec / extraction
fixtures):

1. `scope` missing / `{}` / non-object (string, number, array, null) →
   validation passes; claim scope equals the five-field default.
2. Partial scope `{ time: '2020–2024' }` → `time` preserved, other four
   fields defaulted. Numeric `time: 2024` → defaulted (no coercion).
3. Whitespace-only strings (`'  '`) → defaulted (post-trim emptiness).
4. Unknown keys present + `corpus: ['nonsense']` + a well-formed
   hallucinated `src_<uuid v4>` → corpus is `[]`, unknown keys dropped,
   validation passes.
5. `exclusions` with >1000 entries (mixed types) → filtered then sliced to
   1000; non-array `exclusions` → `[]`; non-array `corpus` → `[]`.
6. Truncation-boundary idempotence: `normalize(normalize(x))` deep-equals
   `normalize(x)` for `"a".repeat(511) + " x"`-style inputs; full valid
   canonical `Scope` round-trips identically (existing `audit.spec.ts`
   fixtures stay green unchanged).
7. No array aliasing: two claims normalized in one response do not share
   `corpus`/`exclusions` array identity.
8. Normalization does NOT bypass the strict validator: a claim whose `text`
   exceeds `maxLength` (or `kind` outside the enum) still throws
   `extract response schema mismatch` with the pre-existing message shape.
9. End-to-end: a fake adapter returning items with empty scopes completes
   `executeAudit` (extract + align) without `REVIEW_INVALID`; the persisted
   `ExtractionRecord` items AND the captured align envelope carry the
   five-field default scope.
10. `extraction-contract.spec.ts` "rejects fabricated kinds and unknown
    fields" stays green (normalization touches the same spread path).

## 6. Verification battery

- Package tests: `pnpm --filter @dsh-cc/interaction-vwa-argument test` (full
  suite).
- `tsc -b --force`, `pnpm check:size` (audit-input.ts grows ~40 lines, far
  under cap), README hash gate if any README touched (none expected).
- Existing `audit.spec.ts` fixtures already emit full scopes — they must
  remain green without modification (canonical stability is the contract).

## Review ledger

- r1 (three seats, blind): critic GO-WITH-CHANGES (8 findings), codex
  GO-WITH-CHANGES (6), grok GO-WITH-CHANGES (13). 16 folds applied (A–P);
  adjudication ledger at `.scratch/scope-defaults-adjudication.md` (kept out
  of the PR). No BLOCKER findings. Cross-seat same-point hits: corpus
  hard-drop (3 seats), identity blast radius (3 seats), collection caps /
  non-array handling (2 seats), canonicalization idempotence (2 seats).
