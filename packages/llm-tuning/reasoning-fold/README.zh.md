# @dsh-cc/reasoning-fold

English | [中文](README.md)

Stage-0 reasoning-fold **探针**：一个只读的 `llm/stream` 监听器，按字节统计 `reasoning-delta` 与 `text-delta` 块，并把终止的 usage 块记录到按会话划分的 JSONL 账本。先测量、后改变行为（docs/plans/2026-09-10-reasoning-fold-deepseek.md）：探针**只读、只记账、不改变任何行为**——每个 chunk 原样透传，探针自身失败在监听器内吞掉，账本失败也绝不影响模型调用。折叠本身（在重发历史中丢弃 reasoning）是门控的独立 Stage-1/2 工作。

## 工作方式

插件注册一个只读的 `llm/stream` 瀑布监听器（cordis 瀑布中唯一合法的只读形态：观察 chunk 并原样转发 `next()` 的输出）。每次调用维护一个局部记录 `{provider, model, sessionId, purpose, reasoningBytes, textBytes, usage?}`——调用之间不共享任何可变状态——并在 `finally` 中追加恰好一条账本行，因此中止或中途失败的调用仍会记录部分计数。探针开关在每次调用开始时读取一次：调用中途的设置变更不会丢弃进行中的记录。

字节计数使用 UTF-8（`Buffer.byteLength`），多字节 reasoning（中文、emoji）按线上字节数统计。没有 usage 块的调用，其行中省略 `usage`。

## 账本

`$DSH_HOME/reasoning-fold/<sessionId>.jsonl`，只追加，每次模型调用一行 JSON：

```json
{"ts":"2026-09-10T12:00:00.000Z","sessionId":"...","provider":"...","model":"...","purpose":null,"reasoningBytes":1234,"textBytes":567,"usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120,"cacheReadTokens":80,"cacheWriteTokens":0,"reasoningTokens":50}}
```

`purpose` 对普通对话调用为 `null`，辅助调用为 `"compaction"` / `"session-title"`。所有账本 I/O 错误一律吞掉。增长受会话数约束（每会话一个文件）；仅在 `reasoning-fold/` 超过 ~10MB 或 Stage 1 落地时做轮转/封顶。

Usage 语义（harness `llm/src/types.ts` 的 TokenUsage）：`inputTokens` 只计未缓存输入；计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`。任何"重发 reasoning 占计费输入比例"的分析必须使用该合计分母。`reasoningTokens` 属于输出侧，无法度量重发成本。

## 设置

命名空间 `cc-reasoning-fold`：

| 键 | 默认 | 含义 |
|---|---|---|
| `probe` | `true` | 总开关。`false`（每次调用实时读取）关闭探针；进行中的调用保持其开始时的决定并仍追加该行。 |

下列 Stage-1 键仅为未来折叠功能的前置文档——**在 Stage 0 中不起作用**，且有意不写入 settings schema（无消费链的 schema 键会挂能力清单审计）：

- `providers` — 将探针/折叠限定到匹配的 provider 路由。
- `head-chars`（默认 4000）、`tail-chars`（默认 2000）— Stage-1 折叠窗口大小；`floor-chars`（默认 12000）为折叠适用的最小 reasoning 块长度，`floorChars > headChars + tailChars` 的校验随 Stage 1 落地。

## 形态

普通 cordis 插件（不发布 Service，handoff-store/memory 模式——避免 leakedServices/isolate 问题）；当 settings provider 缺失、`probe` 为 false 或 `dshHomePath` 缺失时不注册任何东西（跳过账本，chunk 照常透传）。由 `packages/preset/cc` 挂载在 cc-services 组内。
