# @dsh-cc/systemone

English | [中文](README.md)

**共享的 System One 客户端 + token 预算助手**：针对 System One 决策模型端点（`{baseURL}/v1/systemone`）的原生、绝不抛异常的传输客户端，内建有限次数的 HTTP 429 重试；外加基于脚本感知的 token 预算估算器，用于预截断通道负载。自 `@dsh-cc/permission-rules` 抽出（设计文档：docs/plans/2026-10-09-moa-tiered-cascade-routing.md §3.6），使任何接入 System One 通道的 harness 特性——今天是 permission-rules，接下来是 `@dsh-cc/moa`——共用同一实现。纯模块：除 node 标准库外无运行时依赖。

## API

```ts
// client.ts — 绝不抛异常；所有失败映射为带标签的 SystemOneResult
export function systemoneDecide(opts: {
  baseURL: string
  model: string
  state: unknown
  questions: SystemOneQuestion[]
  timeoutMs?: number
  signal?: AbortSignal
  // ... 可注入 fetch/clock/sleep/jitter 供测试
}): Promise<SystemOneResult>

export const SYSTEMONE_429_MAX_RETRIES: number
export const SYSTEMONE_429_RETRY_BUDGET_MS: number
export const SYSTEMONE_429_RETRY_AFTER_CAP_MS: number
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined

// budget.ts — 纯 token 预算助手（下界启发式）
export function estimateSystemOneTokens(text: string): number
export function capMiddleToTokenBudget(text: string, budgetTokens: number, marker: string, headRatio?: number): string
export const S1_ENVELOPE_TOKENS: number
export const S1_MARGIN_TOKENS: number
export const MIN_STATE_TOKENS: number
```

## 用法

```ts
import { systemoneDecide, estimateSystemOneTokens, capMiddleToTokenBudget } from '@dsh-cc/systemone'

const state = capMiddleToTokenBudget(JSON.stringify(bigState), 2048)
const result = await systemoneDecide({ baseURL, model: 'laya-rl-agent', state, questions })
if (!result.ok) return /* 降级：'timeout' | 'error' */
```
