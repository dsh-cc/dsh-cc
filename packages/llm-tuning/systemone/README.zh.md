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
  questions: Record<string, SystemOneQuestion>
  timeoutMs: number
  signal?: AbortSignal
  // ... 可注入 fetch/clock/sleep/jitter 供测试
}): Promise<SystemOneResult>

export const SYSTEMONE_429_MAX_RETRIES: number
export const SYSTEMONE_429_RETRY_BUDGET_MS: number
export const SYSTEMONE_429_RETRY_AFTER_CAP_MS: number
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined

// validation.ts — 严格双向契约（S1-01，无依赖）
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

// budget.ts — 纯 token 预算助手（下界启发式）
export function estimateSystemOneTokens(text: string): number
export function capMiddleToTokenBudget(text: string, budgetTokens: number, marker: string, headRatio?: number): string
export const S1_ENVELOPE_TOKENS: number
export const S1_MARGIN_TOKENS: number
export const MIN_STATE_TOKENS: number
```

## 契约校验

`systemoneDecide` 执行严格的双向契约（设计文档：
docs/plans/2026-11-02-systemone-01-contract-validation.md）。请求在任何网络
动作之前先做预检——问题 ID、选项数量、criteria 形状、JSON 可序列化的
state（拒绝环、BigInt、非有限数及 undefined/函数/symbol 值）、model 与
timeout 边界——预检失败以 `malformed` 返回且 fetch 次数为零。响应必须
精确回答所请求的问题集且类型匹配：choice 的 probabilities 键集与
criteria 完全一致、每个值在 `[0,1]` 内有限、总和在 1 的 `1e-4` 容差内、
被选项的概率不比最大值低超过 `1e-4`；score 答案携带完整
`"0".."n-1"` 分布且 `score` 与期望值差不超过 `1e-4`；usage 的两个 token
计数均为非负安全整数（缺失值绝不折算为零）。任何违规都会整体拒绝该响
应——禁止部分消费——并返回固定原因 `systemone validation: <code>`。服
务端 model 原样保留，绝不回填请求别名。在共享校验器之上，权限 gauge
的 allow 分支独立失败关闭：`P(allow)` 缺失或越界时返回 `ask`
（`gauge allow probability missing or invalid`）而非 `allow`。

## 用法

```ts
import { systemoneDecide, estimateSystemOneTokens, capMiddleToTokenBudget } from '@dsh-cc/systemone'

const state = capMiddleToTokenBudget(JSON.stringify(bigState), 2048)
const result = await systemoneDecide({ baseURL, model: 'systemone-model', state, questions, timeoutMs: 5000 })
if (!result.ok) return /* 降级：'timeout' | 'error' */
```
