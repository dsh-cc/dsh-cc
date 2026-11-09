# @dsh-cc/systemone

English | [中文](README.zh.md)

The **shared System One client + token-budget helpers**: a native, never-throws transport client for the System One decision-model endpoint (`{baseURL}/v1/systemone`) with bounded HTTP 429 retry, plus a script-aware token-budget estimator used to pre-truncate lane payloads. Extracted from `@dsh-cc/permission-rules` (design: docs/plans/2026-10-09-moa-tiered-cascade-routing.md §3.6) so any harness feature that wires a System One lane — permission-rules today, `@dsh-cc/moa` next — consumes one implementation. Pure modules: no runtime dependencies beyond node stdlib.

## API

```ts
// client.ts — never throws; every failure maps to a tagged SystemOneResult
export function systemoneDecide(opts: {
  baseURL: string
  model: string
  state: unknown
  questions: Record<string, SystemOneQuestion>
  timeoutMs: number
  signal?: AbortSignal
  // ... fetch/clock/sleep/jitter injected for tests
}): Promise<SystemOneResult>

export const SYSTEMONE_429_MAX_RETRIES: number
export const SYSTEMONE_429_RETRY_BUDGET_MS: number
export const SYSTEMONE_429_RETRY_AFTER_CAP_MS: number
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined

// validation.ts — strict two-sided contract (S1-01, dependency-free)
export type ValidationCode =
  | 'invalid-request' | 'invalid-envelope' | 'invalid-model'
  | 'question-set-mismatch' | 'answer-type-mismatch' | 'invalid-choice'
  | 'invalid-probabilities' | 'invalid-score' | 'invalid-noul'
  | 'invalid-confidence' | 'invalid-usage'
export interface ValidatedResponse { model: string; answers: Record<string, SystemOneAnswer>; usage: SystemOneUsage }
export function validateSystemOneRequest(opts: {
  model: string; state: unknown; questions: Record<string, SystemOneQuestion>; timeoutMs: number
}): { ok: true } | { ok: false; code: ValidationCode }
export function validateSystemOneResponse(
  questions: Record<string, SystemOneQuestion>, raw: unknown,
): { ok: true; value: ValidatedResponse } | { ok: false; code: ValidationCode }

// budget.ts — pure token-budget helpers (lower-bound heuristic)
export function estimateSystemOneTokens(text: string): number
export function capMiddleToTokenBudget(text: string, budgetTokens: number, marker: string, headRatio?: number): string
export const S1_ENVELOPE_TOKENS: number
export const S1_MARGIN_TOKENS: number
export const MIN_STATE_TOKENS: number
```

## Contract validation

`systemoneDecide` enforces a strict two-sided contract (design:
docs/plans/2026-11-02-systemone-01-contract-validation.md). Requests are
pre-checked before any network work — question IDs, option counts, criteria
shapes, JSON-serializable state (cycles, BigInt, non-finite numbers and
undefined/function/symbol values are rejected), model and timeout bounds —
and a failed pre-check returns `malformed` with zero fetch calls. Responses
must answer exactly the requested question set with type-matching answers:
choice probabilities cover the criteria exactly, each finite in `[0,1]`,
sum within `1e-4` of 1, and the chosen option not more than `1e-4` below
the maximum; score answers carry the full `"0".."n-1"` distribution with
`score` within `1e-4` of its expected value; usage reports both token
counts as non-negative safe integers (a missing value is never coerced to
zero). Any violation rejects the whole response — partial consumption is
forbidden — with the fixed reason `systemone validation: <code>`. The
server model is kept verbatim; the request alias is never backfilled. On
top of the shared validator, the permission gauge's allow branch
independently fails closed: a missing or out-of-range `P(allow)` yields
`ask` (`gauge allow probability missing or invalid`) instead of `allow`.

## Usage

```ts
import { systemoneDecide, estimateSystemOneTokens, capMiddleToTokenBudget } from '@dsh-cc/systemone'

const state = capMiddleToTokenBudget(JSON.stringify(bigState), 2048)
const result = await systemoneDecide({ baseURL, model: 'systemone-model', state, questions, timeoutMs: 5000 })
if (!result.ok) return /* degrade: 'timeout' | 'error' */
```
