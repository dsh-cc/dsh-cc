# @dsh-cc/input-budget

[English](README.md) | 中文

上下文工程输入治理 program 的逐步输入预算 governor：对最终的 `agent/pre-step` enter 批次施加唯一的最外层闸门，按类别与字节预算仲裁各生产者写入的内容。三层一并交付：纯核（`govern()`——只是其参数的函数，因此整个算法无需运行时即可单测）、预设 `input-budget` 行所挂载的 `agent/pre-step` 监听器，以及每次闸门调用写入一条 `GovernorRow` 的账本写入。出厂 observe 优先：observe 模式下批次原样返回，只记录决策。

## 类别——仅显式成员

成员集合封闭且显式。未列出的任何值——未知类别、后注册插件、缺失或空的 `source.kind`——由构造即归为 `passthrough`，因此未枚举的生产者永不被裁剪、永不被延迟。

| 类别 | 类别名（kind） | 策略 |
|---|---|---|
| `governance` | `turn-rules`、`edit-recovery-hint`、`completion-gate`、`permission-rules`、`agent-instructions`、`hooks-claude-code`、`compact-checkpoint`、`moa-escalation` | 永不裁剪、永不延迟；照常计量 |
| `task` | `user`、`progress-rebuild`、`moa`、`subagent-settled`、`cc-subagent-children`、`vwa-evidence`、`cc-workflow-completion` | 永不裁剪、永不延迟；照常计量 |
| `memory` | `memory` | 在 `memory-budget-bytes` 下 FIFO 裁剪/延迟 |
| `advisory` | `advisor`、`retry-attendant`、`compaction-micro`、`compaction-cost-gate` | 在 `advisory-budget-bytes` 下 FIFO 裁剪/延迟 |
| `passthrough` | `cc-shell-glue`（v1 硬规则）、`command-preset`、`side-query`、`tool-web-fetch`、`tool-registry`、已列名 harness kind、其余全部 | 永不裁剪、永不延迟；照常计量 |

`cc-shell-glue` 在 v1 落入 `passthrough` 是一条**算法规则**，不是注解：`mcpReadyNotice` 在返回通告**之前**就已提交其每会话一次闩锁，因此对 glue 通告的任何强制裁剪、延迟或超限丢弃都会变成静默的一次性丢失。`memory` 与 `advisory` 是唯二带预算的类别；一条 12 KiB 的 memory 记录按 `memory-budget-bytes` 判定，绝不以 advisory 限额判定。

## 预算模型（每个 enter 批次）

1. 逐条分类；计算各类 UTF-8 字节（仅文本块——与 `@dsh-cc/input-ledger` 记录的口径相同，因此两族行逐字节一致）。
2. `governance` / `task` / `passthrough`：永不改动、永不计量入预算。
3. `memory`：只要 memory 字节超过 `memory-budget-bytes`，就裁剪最旧的 memory 消息（整条消息，FIFO）。
4. `advisory`：只要 advisory 字节超过 `advisory-budget-bytes`，就裁剪最旧的 advisory 消息。
5. Enter 预算：若批次总量超过 `enter-budget-bytes`，继续裁剪 advisory（其后 memory）。若在可裁剪类别内仍无法满足预算，则不再进一步裁剪、绝不触碰受保护类别，并由 `hardOver` 记录溢出。

被裁剪消息若其自身字节单独就超过其类别预算，立即以 `drop-oversize` 丢弃且绝不入队——先延迟后丢弃会记录一次永远不可能成功的延迟。

## 延迟队列

每会话的 `{ message, enqueuedAtSeq, lastOfferedSeq }` backlog，全部取值以 `gateSeq` 为单位。`gateSeq` 是**单调的每会话调用计数**，每次闸门调用递增；`agent/pre-step` 的 `step` 是回合内局部量，永不使用。`govern()` 接收该计数并返回下一个；监听器按会话持有它。

每次调用按序执行：

1. **老化**——`gateSeq - enqueuedAtSeq > defer-ttl-steps` 的条目以 `drop-expired` 丢弃。
2. **backlog 准入**——按 FIFO 走查，只要**队头自身**类别预算尚有余量就准入（memory 条目按 `memory-budget-bytes`，advisory 按 `advisory-budget-bytes`，`used` 取本次调用已准入的字节）。被准入的条目排在这一步批次之首。
3. **新批裁剪**——即上面的预算模型；存活批次中被裁剪的消息追加到 backlog 尾部。

`lastOfferedSeq` 初值等于 `enqueuedAtSeq`，并在每次评估过该条目的调用结束时推进到当前 `gateSeq`——准入、拒绝与再次延迟一视同仁。TTL 由调用次数而非准入次数界定。

## Observe 模式

`mode: 'observe'` 执行完全相同的新批计算并以 `mode: 'observe'` 记录相同的行，但原样返回输入批次、不保留延迟队列、不模拟 backlog、不产生 `drop-expired` 行。observe 下**仍可能**出现 `drop-oversize`，因为它属于新批计算。由于 observe 调用返回空 backlog，`observe → enforce` 翻转由构造即从空队列开始——不存在跨模式遗留。

## 装配——监听器、预设行、账本写入

`registerGovernorListener(ctx)` 以一个 `{ prepend: true }` 的 `agent/pre-step` 监听器注册，因此它在预设的 pre-step 重写者中最外层运行，并在返回途中看到最终决策；它 delegate-first（先 await `next()`，再展开返回的决策、只替换消息批次），且绝不向瀑布抛错。共享预设体中的预设行 `input-budget` 经 `apply()` 挂载它，排序在 `tool-task` 之后，使 subagent 的 strip-instructions/settled-notice 组合留在闸门之内；组合 pin 与两项 live-fold 顺序测试让该边界是被测试的性质而非偶然。

行经 `createGovernorLedgerSink()` 落地：每次闸门调用一条无内容 `GovernorRow`，追加到 `$DSH_HOME/input-ledger/<projectKey>/<sessionId>.jsonl`，与账本自身观察者使用同一 sink 与路径约定（project 桶为 `sha256(realpath(cwd))` 的前 16 个十六进制字符；因 `@dsh-cc/input-ledger` 不导出该函数，此处保有一份一致的本地副本）。该依赖按设计是软依赖：没有 dsh-home、没有会话 cwd，或 `cc-input-ledger.enabled: false` 时 governor 照常运行，行只是不落盘；追加失败被吞掉、记入调试日志并计入 `getGovernorLedgerHealth().droppedRows`——绝不抛入瀑布，也绝不在热路径上等待。governor 自身抛错时返回未改动的决策并记录 `{ error: true }` 行，因此失败的闸门绝不会半应用一个批次。

## Governor 管线

导出的管线接缝只固定阶段顺序 `dedupe → caps → trim`。`runGovernorPipeline(input, hooks?)` 让某个阶段的每个 `GovernorStageHook` 都在前一阶段产出的批次上运行，再把结果交给 trim 阶段，也就是 `govern()` 本身。hook 看到的是监听器收到的批次，即所有内层 `agent/pre-step` 监听器跑完之后的 claimed enter 批次，并返回下一阶段将要评估的批次。`GovernorStage` 命名三个阶段，`GOVERNOR_STAGES` 以运行时值承载冻结的顺序。此处目前不含任何去重或上限逻辑，因此两个 pre-trim 阶段默认接收空 hook 列表，管线就等于 trim 本身。hook 失败会传播给监听器，监听器返回未改动的决策并记录 `{ error: true }`，因此失败的阶段绝不会半应用一个批次。

## 算术（钉住已验证模型）

`available(budget, used) = budget - used`（饱和减法）、`fits(budget, used, bytes) = bytes <= available(...)`、`oversize(budget, bytes) = budget < bytes`——与 `specs/lean/input-admission-arithmetic/Model.lean` 中的 `Formal.fits` / `Formal.oversize` 完全一致。受保护类别永不计量，这就是"永不触碰"的算术面。

## 行字段

行 schema 归 `@dsh-cc/input-ledger` 所有；本包只提供 `mode`、`bytesByClass`、`trimmed`、`offeredBacklog` 与 `hardOver`。`trimmed` 元素为 `{ kind, bytes, action }`，`action` 取 `defer | drop-expired | drop-oversize`。

以下约定由本包钉住，因为设计把细节留给实现：`bytesByClass` 恒含全部五个类别键、按表格顺序、以**决策**批次计量（因此 observe 与 enforce 一致）；`offeredBacklog` 是调用开始时的 backlog 长度（observe 模式恒为 0）；决策批次中被准入的 backlog 条目在前（它们更旧），随后是存活的新批消息按到达顺序——除此之外不重排；自身字节超过类别预算的条目在 backlog 走查中同样以 `drop-oversize` 丢弃，这一分支只有在热读预算于入队后收窄时才可达。

## 设置——`cc-input-budget`

kebab 键、用户层设置，每次闸门调用重读，因此热开关在下一步即生效、无需重启。

| 键 | 类型 | 默认 | 取值范围 |
|---|---|---|---|
| `enabled` | bool | `true` | — |
| `mode` | `'observe' \| 'enforce'` | `'observe'` | —（翻转到 enforce 会重置延迟队列） |
| `enter-budget-bytes` | int | `24576` | 4096..262144 |
| `advisory-budget-bytes` | int | `8192` | 512..65536 |
| `memory-budget-bytes` | int | `16384` | 1024..131072 |
| `defer-ttl-steps` | int | `3` | 1..16 |

默认值分散在四个必须一致的面：schema 的 `.default()`、`DEFAULT_INPUT_BUDGET_SETTINGS` 常量、fail-soft 原始读取器（文件缺失或损坏、越界整数 → 默认值或边界值、未知 mode → `observe`）以及装配层的兜底。没有设置文件即默认值，即 **observe 模式照常运行**。

## 用法

```ts
import { govern, messageBytes, createGovernorListener, registerGovernorListener } from '@dsh-cc/input-budget'

// 纯核：整个算法就是其参数的函数。
const result = govern({ messages, settings, backlog, gateSeq })
// result.messages  —— 决策批次（observe 模式下即原输入批次，原样返回）
// result.decision  —— { mode, bytesByClass, trimmed, offeredBacklog, hardOver }
// result.backlog   —— 传递给下一次调用的延迟队列
// result.gateSeq   —— 传递给下一次调用的 gateSeq

// 装配：预设行负责挂载，测试宿主也可直接挂载。
const release = registerGovernorListener(ctx) // prepend 的 agent/pre-step 监听器
```

## 注意事项

- observe 模式是出厂默认，也是当前生产唯一启用的模式；enforce 预算应在翻转前依据账本数据设定。
- 被延迟的消息只通过 governor 自身的返回值回流，从不经 `agent.inject`，因此不会额外形成 claimed 批次。
- 两项顺序防御（生产者链 live-fold 测试、后注册 prepend 监听器边界）与全仓类别枚举扫描分别钉在 `tests/live-fold.spec.ts` 与 `tests/kinds-enumeration.spec.ts`；缺少 pinned harness 检出时枚举硬失败。
- 持续过载下 advisory 的饥饿被限定而非消除；按类上限是姊妹文档的职责。
