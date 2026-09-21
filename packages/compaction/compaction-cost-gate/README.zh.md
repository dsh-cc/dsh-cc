# @dsh-cc/compaction-cost-gate

[English](README.md) | 中文

成本门控的计划步骤压缩。完成一个计划步骤（`todo_write` 中出现转为 completed 的迁移）会武装一个边界；当代理下一次进入空闲时，服务会评估一次全前缀压缩是否划算——将剩余计划上的输入 token 节省预期与提示缓存重写成本加未摊销的债务进行比较——只有通过时才对根会话调用 `ctx.compaction.compactNow`。通过除了账本外完全不可见。

## 决策方式

- **检测（回合中）：** `tools/post-execute` 监听器过滤 `todo_write`，将 todos 快照与前一个快照做差分，并在任何转为 completed 的迁移上武装边界。它从不修改下游决策。
- **动作（空闲）：** `agent/status` 监听器（`status === 'idle'`，压缩家族自身的先例）仅针对已锁定的根会话运行。子代理的 todo 完成和请求既不会武装也不会触发。
- **门控算术：** `projectedSavedInput = contextTokens × shrink × requestsPerStep × pendingSteps` 必须严格大于 `margin × (rewriteCost + debtTokens)`。`contextTokens` 在影子感知表面上求和（`session.surface.nodes` + `eventAt`），因此被压缩的跨度不会被重复计算。过去一次压缩的重写成本作为债务保留，直到后续 5 个提供者请求。`pendingSteps === 0` 永不触发——计划结束没有未来的请求可以摊销。当价格行可解析时，节省按缓存读取速率计价，重写按缓存写入速率计价；否则比较保持以 token 为单位（保守）。
- **窗口压力覆盖：** 当 `contextTokens ≥ window-pressure-tokens` 时绕过门控（冷却和失败熔断仍然生效）。

## 断路器

只有真实缺陷类别（`changed | summary | commit | persistence`、意外抛出）会被计数。预期的 `busy`/`cancelled` 类别被记为跳过。连续 3 次真实失败后，功能对该会话暂停，并给出一条指向手动 `/compact` 的模型可见通知。任何实际压缩之后，门控会冷却 `cooldown-ms`（默认 600 000）。

## 配置（settings 命名空间 `cc-compaction-cost-gate`）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 默认熄火发布。 |
| `mode` | `'dry-run'` | `dry-run` 会评估并记录不等式两侧，从不调用 `compactNow`。 |
| `margin` | `1.0` | 相对重写加债务所需的节省倍数。 |
| `cooldown-ms` | `600000` | 实际压缩后的冷却时间。 |
| `window-pressure-tokens` | 未设置 | 门控绕过阈值；未设置 = 无覆盖。 |
| `model-table` | 未设置 | 可选价格表（`ModelPrice[]`，与 `/cost` 相同形状）。 |

账本：`<dshHome>/compaction-cost-gate/<projectKey>.jsonl`，仅追加、即发即忘。

## 用法

```ts
import type { Context } from '@deepseek-ai/cordis'
import CompactionCostGate from '@dsh-cc/compaction-cost-gate'

export function apply(ctx: Context): void {
  ctx.plugin(CompactionCostGate)
}
```

该服务由 cc 预设挂载（`cc-services` 组，id `compaction-cost-gate`）。压缩引擎被刻意不注入：cordis 严格读取意味着硬 `inject` 会在压缩缺失的地方杀死服务。它通过受保护的访问器读取；缺失时该包以一行日志和一条 `compaction-unavailable` 账本行失效。
