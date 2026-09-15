# @dsh-cc/side-query

English | [中文](README.md)

**side-query 原语**：声明式、绝不抛异常、非流式的辅助 LLM 调用，供 harness 中需要小/快模型在主 Agent 循环之外作答的特性使用（设计文档：docs/plans/2026-09-15-side-queries.md）。在本包之前，web_fetch 的页面摘要、session-title 提供器、权限 auto 模式分类器各自手写一次性调用，超时/失败/路由语义相互漂移；`runSideQuery` 是收敛后的唯一形态。

## API

```ts
export interface SideQueryOptions {
  agent: Agent                      // 必填：经 agent.session.requestHeader 补齐路由的 provider 半（web-fetch 先例）
  alias?: string                    // 默认 'haiku'（resolveAlias / ccModelRoutes 通道）
  system?: string
  prompt: string
  maxTokens?: number                // 默认 512
  timeoutMs?: number                // 默认 8000
  signal?: AbortSignal              // 调用方持有；与超时组合（AbortSignal.any）
  onUnrouted?: 'inherit' | 'skip'   // 默认 'inherit'（alias 未配置 → 继承父路由）
  rejectToolCalls?: boolean         // 默认 true
}

export type SideQueryResult =
  | { ok: true; text: string; inheritedRoute: boolean; durationMs: number }
  | { ok: false; reason: 'unrouted' | 'timeout' | 'error' | 'empty'; inheritedRoute?: boolean }

export async function runSideQuery(ctx: Context, opts: SideQueryOptions): Promise<SideQueryResult>
```

## 语义

- **绝不抛异常**。所有失败形态——alias 无路由、超时、adapter 错误、空文本——都收敛进 `SideQueryResult`。dsh-llm runtime 会把 adapter 抛错规范化为终止 error chunk，因此两条路径都映射到 `reason: 'error'`。
- 非流式契约：内部经 BlockAssembler 模式消费 `ctx.llm.stream` 并等待完整文本（`tool-web-fetch` 的一次性调用模式）。
- `rejectToolCalls`（默认开启）拒绝发出 tool-call 块的流：side query 试图"动手"是 bug 而不是能力（memory recall selector 幻影执行事故的教训）。
- `inheritedRoute` 报告 alias 是否回落到了父路由，供消费方计量"零节省"运行（配合 `@dsh-cc/cc-model-aliases` 的 `warnOnInherit`）。
- 无重试、无缓存、无持久化、无账本——这些属于消费方（如 `@dsh-cc/tool-use-summary` 自带账本）。

## 形态

纯库包：无 preset 行、无 settings 命名空间、无 capability manifest 条目。消费方以 `workspace:^` 依赖它，并在自己的 `tsconfig.json` 中加 project reference。
