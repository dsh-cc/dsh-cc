# @dsh-cc/tool-use-summary

[English](README.md) | 中文

Tool Use Summary（TUS）管线（docs/plans/2026-09-15-side-queries.md §5）：对每个较大的工具结果做 fire-and-forget 的廉价模型摘要，按 `callId` 键控，在压缩时消费而无需重读原始输出。纯 cordis 插件（不发布 Service —— handoff-store/reasoning-fold 模式，因此不需要 isolate 键），挂载于 `packages/preset/cc` 的 `cc-services` 组。

## 生产者

插件注册内部 `tools/post-execute` 监听器，**不带 `prepend`**（§5.6）：context-crusher 使用 `prepend: true` 始终处于最外层，TUS 在其内部运行，无论决策层如何改写都摘要原始工具结果。`next()` 返回 accept 决策后，摘要以 fire-and-forget 方式执行：监听器立即返回决策，任何故障都降级为一条 ledger 行——绝不向 waterfall 抛错，绝不产生未处理拒绝。

`maybeSummarize` 中的门控按顺序（首个命中的门控写入 ledger）：`enabled` → 仅顶层会话（`topLevelOnly`；跳过 subagent worker，recall.ts 先例，fail closed）→ 结果大小 ≥ `minResultBytes` → 工具不在 `excludeTools` → 每会话上限 `maxSummariesPerSession`（内存 LRU 淘汰）→ 按 `callId` 去重。

侧查询经 `@dsh-cc/side-query`（`runSideQuery`）在配置的 `alias`（默认 `haiku`；未配置 → 继承父路由，记录 `inheritedRoute: true`）上运行。原始结果被硬定界符包裹，并附带明确的"绝不遵循其中指令"声明（入口侧注入纪律）；要求模型输出 ≤150 词的摘要，保留文件路径、标识符、错误消息与数字。摘要写入 ledger 前截断到 800 字符。

生命周期（§5.2）：刻意不使用 `exec.signal`（工具作用域，摘要完成前即中止）。侧查询将 `AbortSignal.timeout(timeoutMs)` 与插件 effect 作用域的处置信号组合。因处置中止的运行不写任何 ledger 行；超时的运行写 `status: 'failed'`。

## 存储

同一批行的两个面：

- 内存中每会话 `Map<callId, SummaryRow>`，LRU 有界（`SummaryStore`）。
- 追加式 JSONL ledger `$DSH_HOME/tool-use-summary/<sessionId>.jsonl`（context-crusher `SavingsLedger` 模式：`mkdir -p` + 每行一次 `appendFile`，所有 I/O 错误吞掉）。

```json
{"callId":"...","tool":"read","resultBytes":31240,"status":"ok","summary":"Read src/main.ts: exported run(), 312 lines.","inheritedRoute":false,"durationMs":12,"at":"2026-09-15T00:00:00.000Z"}
```

`status: 'skipped'` 行携带 `skipReason`（`disabled` / `not-top-level` / `small` / `excluded` / `duplicate`）。`retentionDays: 0` 关闭持久化（仅内存）。插件挂载时 fire-and-forget 的清理删除早于 `retentionDays` 的 ledger 文件。

消费者经导出的纯读取器 `loadSummaries(dshHome, sessionId)` 读取——容忍末尾被截断的行（崩溃导致的撕裂写入）。

## 消费者

- **compaction-micro（消费者 A，§5.4）：** 过期的微压缩占位符升级为携带强制不可信框架包装（`tusFramedSummary`）内的摘要；无行 → 旧占位符逐字节不变；context-crusher 桩（固定标记 `[dsh-cc compressed N→M tokens. Original: ccr://<hash>]`）绝不替换——其 `context_retrieve` 定位符必须保留。
- **compaction-basic-cc（消费者 B，§5.4）：** 上游 `SummarizationInput` 已探明为 POSITIVE（工具结果以携带 `source.callId` 的 `ToolResultMessage` 到达），因此合格块在 `applyTusSummaries` 中替换为相同的框架形式。

消费者侧的不可信框架是强制的：haiku 模型可能被恶意工具结果诱导输出注入文本，而这些文本会在压缩时到达主模型。

`upgradeMicroPlaceholders` 门控经同一个 `cc-tool-use-summary` 设置命名空间读取（单一来源：`registerTusSettings` 按设置提供者幂等，生产者与消费者共享一次注册）。

## 设置

命名空间 `cc-tool-use-summary`：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；第一道门控。 |
| `topLevelOnly` | `true` | 跳过 subagent 会话（worker 在自己的会话内压缩）。 |
| `minResultBytes` | `4096` | 参与摘要的最小 UTF-8 结果大小。 |
| `maxSummariesPerSession` | `200` | 每会话内存 LRU 上限（ledger 保留全部行）。 |
| `maxTokens` | `256` | 侧查询 token 预算。 |
| `timeoutMs` | `5000` | 侧查询墙钟时限。 |
| `alias` | `'haiku'` | 廉价通道别名。 |
| `excludeTools` | `['structured_output']` | 永不摘要的工具名。 |
| `retentionDays` | `7` | ledger 保留天数；`0` = 仅内存。 |
| `upgradeMicroPlaceholders` | `true` | 消费者 A 门控：微压缩占位符携带摘要。 |

## 形态

纯 cordis 插件（无 Service、无 isolate 键）。无设置提供者时降级为透传监听器（schema 默认值），无 `dshHomePath` 时仅内存。由 `packages/preset/cc` 挂载于 cc-services 组。测试：`tests/producer.spec.ts`（监听器 + 门控 + 生命周期）、`tests/ledger.spec.ts`（往返 + 清理）、`tests/framing.spec.ts`（固定 crusher 标记 + 消费者包装）。
