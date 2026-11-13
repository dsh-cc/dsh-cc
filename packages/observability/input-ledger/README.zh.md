# @dsh-cc/input-ledger

[English](README.md) | 中文

逐步输入账本的唯一 schema 来源与纯函数写入/读取核心——上下文工程输入治理program所依赖的共享、无内容组合记录。本包**自身不含任何观察者，也不做 cordis 装配**：文档 1、5、7、8 导入这里的行类型、写入器与类型化读取器，而产生行的观察者由预设挂载 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L53-L53〕。

单位统一为 **UTF-8 字节** 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L82-L82〕。时间戳为 epoch 毫秒。

## 行 schema（v1）——唯一来源

五种行类型共享一个基座，且只定义在 `src/rows.ts`；文档 1/7 的 governor、dedupe、cap 行引用该文件，不另行重定义形状 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L55-L80〕。

```
BaseRow = { v: 1; ts; sessionId; gen; turn?; step? }
```

`gen` 是进程启动 id（apply 时随机生成）；`turn`/`step` 来自逐步载荷，辅助调用时**显式 undefined、绝不继承**。

| `type` | 产生方 | 载荷 |
|---|---|---|
| `assemble` | `system-prompt/assemble` 观察 | `isSubagent`、`sections: {name, bytes, hash8}[]`、`totalBytes`、`renderedFromCache` |
| `request` | `llm/stream` 观察 | `seqPerGen`、`provider`、`model`、`purpose?`、`mainLoop`、`systemBytes`、`systemHash8`、`toolsCount`、`toolsBytes`、`messages{count, bytesTotal, nonTextBlocks, bySourceKind, toolResults, assistantBytes}` |
| `governor` | 预算 governor（文档 1） | `mode: 'observe' \| 'enforce'`、`bytesByClass`、`trimmed: {kind, bytes, action}[]`、`offeredBacklog`、`hardOver`、`error?: true` |
| `dedupe` | 注入去重（文档 7） | `applied`、`kind`、`hash12`、`suppressedWithin` |
| `cap` | 按类上限（文档 7） | `applied`、`kind`、`runningCount`、`suppressedTotal` |

Governor 的裁剪动作恰为 `defer`、`drop-expired`、`drop-oversize`；observe 模式把其决策映射到同一个 `trimmed` 数组（`mode: 'observe'`），而不是新增平行的 `wouldTrim` 字段。`runningCount` 的存在是为了让 observe 模式能回答分布翻转问题。

## 写入

```ts
import { appendLedgerRow, sessionLedgerPath } from '@dsh-cc/input-ledger'

const file = sessionLedgerPath(dshHome, projectKey, sessionId) // <dshHome>/input-ledger/<projectKey>/<encodeSegment(sessionId)>.jsonl
await appendLedgerRow(file, row, onError)
```

- `sessionLedgerPath(dshHome, projectKey, sessionId)` —— 会话 id 经 `encodeSegment`（`@dsh-cc/sidecar-io`）编码为单一安全路径段，`../`、分隔符与 NUL 因此永远逃不出项目目录 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L108-L108〕。
- `appendLedgerRow(filePath, row, onError?)` —— 通过 sidecar-io 的 `appendJsonl` 追加，自动建父目录且从不抛错。文件路径为 `undefined`（宿主没有 dshHome）时是**空操作**：无 provider 的宿主既不写文件也不会崩溃 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L111-L111〕。
- 轮转：当会话文件达到 `maxRowsPerFile` 行（默认 2000，沿用 cache-health 先例）后，下一次追加会先把它重命名为 `<file>.1`（覆盖旧归档），再用该行开启新文件。读取端容忍撕裂的末行，因此无需 fsync 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L110-L110〕。
- `getLedgerHealth()` 返回 `{ droppedRows }`，即进程内因追加失败而丢失的行计数。写失败不会产生通知，也绝不向调用方的 waterfall 传播 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L109-L109〕。
- 同一文件路径的追加按目标串行化，轮转计数不会发生竞态。

## 读取

`readAssembleRows` / `readRequestRows` / `readGovernorRows` / `readDedupeRows` / `readCapRows` 各接收一个文件路径，返回对应行类型的 `AsyncIterable`。它们跳过其他类型的行（所有产生方共用一个文件）、非 schema `v: 1` 的行以及无法解析的行——包括撕裂的末次写入。文件不存在时什么都不产出。本包所有函数都是纯模块代码：不需要 cordis 上下文，离线工具可复用同一套写入器与读取器。

## 隐私边界

记录的内容：段名与来源类别字符串（编译期标识符，均经 `clampLabel` 硬性截断至 64 字符）、provider/model 路由字符串、数值统计，以及本地提示文本的 8 位十六进制 sha256 指纹 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L148-L148〕。指纹绝不离开本机；它是仅用于本地前缀稳定性的指纹，不是导出格式。

绝不记录：块文本、工具参数、内容中的文件路径、环境数据 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L149-L149〕。约束是结构性的——行类型根本不含文本字段——并由回归夹具钉住：携带 `sk-…` 与 `Bearer …` 凭据形状字符串的合成消息，必须产出可证明不含这些字符串的序列化行（`tests/privacy.spec.ts`） 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L150-L150〕。

## 测量注意事项

- `assemble` 行是一次**装配观察**，不是权威的最终提示词：更外层的监听器与完整段恢复仍可能在此后改写文本。提示词字节的记账以 `request` 行为准 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L90-L90〕。
- `request` 行读取的是交给中间件链时的 `llm/stream` options——中间件之前的视图，而非线上忠实呈现（继承自 `cache-health` 的同一边界限制） 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L38-L38〕。`systemBytes`/`systemHash8` 由前导 system 角色消息与 `source.kind === 'system-prompt'` 的消息计算，并在存在一次性 `options.system` 时加上它——因为主循环构造的请求会把系统提示词放在 `messages` 里。
