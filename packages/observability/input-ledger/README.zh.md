# @dsh-cc/input-ledger

[English](README.md) | 中文

上下文工程输入治理program的逐步输入账本：唯一 schema 来源、纯函数写入器与类型化读取器，以及由引用计数挂载注册的三个产生行观察者。它记录某一步真正进入模型的内容——段级与消息来源级的组合、字节量与本机短指纹——绝不记录任何内容明文。预设在顶层以 `input-ledger` 行挂载它。

单位统一为 **UTF-8 字节**。时间戳为 epoch 毫秒。

## 行 schema（v1）——唯一来源

五种行类型共享一个基座，且只定义在 `src/rows.ts`；文档 1/7 的 governor、dedupe、cap 行引用该文件，不另行重定义形状。

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

## 观察者

三个只观察的监听器，全部由 `mountInputLedger(ctx)` 注册。任一观察者内部抛错即该次调用零行 + 一条 debug 日志——观察者绝不向 waterfall 抛错。

- **装配**（`system-prompt/assemble`，不加 `prepend`）——运行在所有 prepend 改写器之内，因此看到的是其位置上最内层的最终视图。产出一条 `assemble` 行，含逐段 `{name, bytes, hash8}` 与 `totalBytes`；`renderedFromCache` 把该行与同一 `(sessionId, scopeKey)` 的上一条对比得出。无 scope 的装配不带会话身份，按约定跳过。
- **请求**（`llm/stream`，`{global: true, prepend: true}`）——同步计算，在 `next()` 之前完成，绝不改动 options。`seqPerGen` 按 `(sessionId, gen)` 单调递增；`purpose` 原样记录自开放的增广映射；`mainLoop` 即 `purpose === undefined`，辅助调用不填 `turn`/`step`。
- **归属**（`agent/pre-step`，`{prepend: true}`，delegate-first）——从载荷记录 `(turn, step)` 与该会话的项目/路由事实，然后原样返回 `next()`。

只有当归属观察者先登记了该会话（请求行需要它的项目桶）才会产出行；当 `include-subagents` 为 false 时跳过被委派的会话。

## 挂载

预设在顶层以 `input-ledger` 行把本包作为普通 cordis 插件挂载：`apply(ctx)` 就是整个插件入口，且不声明 `inject`——本包不发布任何 Service。其余逻辑都在 `mountInputLedger(ctx)`：它把监听器注册在**根**上下文上，并返回释放句柄。cordis 会在某个预设卸载时注销它的监听器，因此一个简单的"已挂载"标记会在某个预设卸载、另一预设仍在挂载时永久压制观察；所以挂载是引用计数的：

- 某个根上的首次挂载注册三个监听器；之后每次挂载只递增 `refs`（预设主体的 cc + vwa 双重 include 由此覆盖）；
- 每次释放递减；只有计数归零才真正销毁监听器，重复释放是惰性的；
- `apply(ctx)` 把释放句柄注册为 fiber effect，因此属主预设卸载时只递减计数，而不会留下孤立的监听器；没有该入口的包在预设装配时会"从未启动"。
- `mountStateOf(ctx)` 暴露 `{ listenerCount, refs }` 供测试使用。

## 写入

```ts
import { appendLedgerRow, sessionLedgerPath } from '@dsh-cc/input-ledger'

const file = sessionLedgerPath(dshHome, projectKey, sessionId) // <dshHome>/input-ledger/<projectKey>/<encodeSegment(sessionId)>.jsonl
await appendLedgerRow(file, row, onError)
```

- `sessionLedgerPath(dshHome, projectKey, sessionId)` —— 会话 id 经 `encodeSegment`（`@dsh-cc/sidecar-io`）编码为单一安全路径段，`../`、分隔符与 NUL 因此永远逃不出项目目录。
- `appendLedgerRow(filePath, row, onError?, maxRowsPerFile?)` —— 通过 sidecar-io 的 `appendJsonl` 追加，自动建父目录且从不抛错。文件路径为 `undefined`（宿主没有 dshHome）时是**空操作**：无 provider 的宿主既不写文件也不会崩溃。
- 轮转：当会话文件达到 `maxRowsPerFile` 行（默认 2000，沿用 cache-health 先例）后，下一次追加会先把它重命名为 `<file>.1`（覆盖旧归档），再用该行开启新文件。读取端容忍撕裂的末行，因此无需 fsync。
- `getLedgerHealth()` 返回 `{ droppedRows }`，即进程内因追加失败而丢失的行计数。写失败不会产生通知，也绝不向调用方的 waterfall 传播。
- 同一文件路径的追加按目标串行化，轮转计数不会发生竞态。

## 读取

`readAssembleRows` / `readRequestRows` / `readGovernorRows` / `readDedupeRows` / `readCapRows` 各接收一个文件路径，返回对应行类型的 `AsyncIterable`。它们跳过其他类型的行（所有产生方共用一个文件）、非 schema `v: 1` 的行以及无法解析的行——包括撕裂的末次写入。文件不存在时什么都不产出。写入器与读取器完全不需要 cordis 上下文，离线工具（文档 5/8）可复用同一套。

## 设置——`cc-input-ledger`

kebab 键、用户层设置，每个被观察事件热读取，因此切换在下一个事件即生效、无需重启。

| 键 | 类型 | 默认 | 取值域 |
|---|---|---|---|
| `enabled` | bool | `true` | ——（关闭后不再产生新行；文件永不删除） |
| `include-subagents` | bool | `true` | —— |
| `max-sections-per-row` | int | `64` | 8..256 |
| `max-rows-per-file` | int | `2000` | 100..100000 |

默认值落在四个必须一致的面上：schema 的 `.default()`、`DEFAULT_INPUT_LEDGER_SETTINGS` 常量、fail-soft 的原始读取器（文件缺失或损坏、整数越界 → 默认值或边界）以及 wiring 兜底。没有设置文件即默认值，观察者照常工作。

## 隐私边界

记录的内容：段名与来源类别字符串（编译期标识符，均经 `clampLabel` 硬性截断至 64 字符）、provider/model 路由字符串、数值统计，以及本地提示文本的 8 位十六进制 sha256 指纹。指纹绝不离开本机；它是仅用于本地前缀稳定性的指纹，不是导出格式。

绝不记录：块文本、工具参数、内容中的文件路径、环境数据。约束是结构性的——行类型根本不含文本字段——并由回归夹具钉住：携带 `sk-…` 与 `Bearer …` 凭据形状字符串的合成消息，必须产出可证明不含这些字符串的序列化行（`tests/privacy.spec.ts`）。

## 测量注意事项

- `assemble` 行是一次**装配观察**，不是权威的最终提示词：更外层的监听器与完整段恢复仍可能在此后改写文本。提示词字节的记账以 `request` 行为准。
- `request` 行读取的是交给中间件链时的 `llm/stream` options——中间件之前的视图，而非线上忠实呈现（继承自 `cache-health` 的同一边界限制）。`systemBytes`/`systemHash8` 由前导 system 角色消息与 `source.kind === 'system-prompt'` 的消息计算，并在存在一次性 `options.system` 时加上它——因为主循环构造的请求会把系统提示词放在 `messages` 里。
- 轮转后每个会话只保留 `max-rows-per-file` 行以内的历史，与 cache-health 先例一致。
