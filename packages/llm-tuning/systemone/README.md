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
  questions: SystemOneQuestion[]
  timeoutMs?: number
  signal?: AbortSignal
  // ... fetch/clock/sleep/jitter injected for tests
}): Promise<SystemOneResult>

export const SYSTEMONE_429_MAX_RETRIES: number
export const SYSTEMONE_429_RETRY_BUDGET_MS: number
export const SYSTEMONE_429_RETRY_AFTER_CAP_MS: number
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined

// budget.ts — pure token-budget helpers (lower-bound heuristic)
export function estimateSystemOneTokens(text: string): number
export function capMiddleToTokenBudget(text: string, budgetTokens: number, marker: string, headRatio?: number): string
export const S1_ENVELOPE_TOKENS: number
export const S1_MARGIN_TOKENS: number
export const MIN_STATE_TOKENS: number
```

## Usage

```ts
import { systemoneDecide, estimateSystemOneTokens, capMiddleToTokenBudget } from '@dsh-cc/systemone'

const state = capMiddleToTokenBudget(JSON.stringify(bigState), 2048)
const result = await systemoneDecide({ baseURL, model: 'laya-rl-agent', state, questions })
if (!result.ok) return /* degrade: 'timeout' | 'error' */
```
