# @dsh-cc/advisor-watchdog

English | [中文](README.zh.md)

（中文说明，与英文版实质等价。）

Advisor watchdog：可选开启的**第二模型**，审查每一个已完成的轮次。一个只读被动的 `llm/stream` 监听器按会话保存最新的符合条件的对话请求消息数组；在每个 `agent/turn-stopping`，插件提取自其每会话游标以来的窗口（≈ 上一个已完成轮次），渲染为 `[role] content` 行（tool-call 块渲染为 `[assistant tool_use <name>] <args>`），并通过 `@dsh-cc/side-query` 的一次性 `runSideQuery` 以发后即忘的方式询问廉价通道（默认别名 `haiku`）——携带 `onUnrouted: 'skip'`（硬性禁继承规则：未配置的别名绝不可能静默跑在主路由上）和 `rejectToolCalls: true`（不可能存在工具循环）。回复按严格 JSON 契约解析（`nit | concern | blocker`，≤ 16 条，≤ 500 字符，允许为空），幸存的注记在解析时经一次 `agent.inject()` 投递、来源标记 `advisor`——绝不插入工具批次中段，绝不唤醒空闲会话。**默认关闭**（`cc-advisor.enabled: false`）。

## 工作方式

普通插件（无 Service、无 isolate key），注册两个监听器：

- **`llm/stream`**（只读、观察直通、`{ global: true, prepend: true }`——cache-health 同一接缝）：按会话保存最新的符合条件的请求消息数组。请求符合条件当且仅当循环已盖 `sessionId` 戳且未设 `purpose`——因此 advisor 自己手工构建的一次性调用从不进入快照（自我观察在构造上被排除），压缩/会话标题等辅助通道也被跳过。零设置/IO 开销：仅持一个数组引用，立即 `next()`。
- **`agent/turn-stopping`**（触发器；捕获前全程同步、从不抛出）：闸门——设置 `enabled`（原始双半读取）、非顶层会话受 `subagents` 闸门约束、会话已禁用、inFlight（运行期间的轮次停止既不捕获也不推进游标，窗口累积到下一次停止）——随后对快照执行游标协议：首次观察（init）与被重写的历史（压缩/回退 reset）直接跳过不计费；候选窗口剔除所有注入来源类型（advisor 自己的输出对自身不可见，因此被重开的 advisory 尾轮不会触发任何新调用）；过滤后为空或无真实用户消息的窗口推进游标并跳过。命中审查时游标立即推进（标记资格而非完成），分离地派发运行，并在捕获之后递增轮次计数器；解析时仅当 `turnCounter - capturedTurn <= 1` 才投递，否则按过期丢弃。

发射守卫（自 oh-my-pi 移植，计划附录 A），按固定顺序：严重度过滤 → 归一化精确集合拒绝列表（37 条 omp 原文短语；"Stop." 匹配，而真正提及 "Stop:" 的 blocker 不匹配）→ 以 `@dsh-cc/permission-rules` 的 `DEFAULT_DANGEROUS_PATTERNS` 做隔离扫描 → 扁平去重 LRU（4096 个指纹）→ 免疫窗口（投递过 concern/blocker 之后的 `immune-turns` 个轮次内，新的 `concern` 被抑制）→ 每次运行预算（2 条非 blocker，blocker 豁免）。会话总量上限（24 条已投递注记）到达后对该会话静默。

每次尝试的运行向 `$DSH_HOME/advisor/<sessionId>.jsonl` 追加一行 JSON（字段：ts、turn、alias、model、inheritedRoute、ok、reason、durationMs、deltaMessages、deltaBytes、notesIn、notesOut、drops、`usage: null`——在 `SideQueryResult` 暴露用量之前不计量成本，计划 §7）。Dogfood 计划与 jq 记分板：[`docs/dogfood/advisor-watchdog.md`](../../../docs/dogfood/advisor-watchdog.md)。

跨包义务：注入类型 `advisor` 已加入 `@dsh-cc/turn-rules`（matcher）与 `@dsh-cc/memory`（recall）的拒绝列表——advisor 永不以自己或其他插件的注入文本为食，下游也永不以 advisory 构建查询。

## 配置（仅用户层）

用户层 `settings.json`（harness-home 文件）中的 `cc-advisor` 键。**永不读取**项目作用域——结构上不可见，并非"被拒绝"。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关。默认黑暗。 |
| `alias` | `"haiku"` | 经 `ccModelRoutes` 解析的廉价通道别名。 |
| `budget` | `2` | 每次运行的非 blocker 注记上限（1–8）；blocker 豁免。 |
| `immune-turns` | `3` | 投递过 concern/blocker 后的新 concern 抑制轮数。 |
| `session-cap` | `24` | 每会话已投递注记上限；到达即对该会话禁用。 |
| `severities` | 三者全开 | 通过第一道过滤的严重级别。 |
| `subagents` | `"off"` | 子代理全局闸门（仅设置层，§4.7）：`off` 仅审查顶层会话；`on` 以会话别名审查子代理会话；别名字符串则以该别名审查。 |

## 形态

普通 cordis 插件（无 Service、无 isolate key）。由 `packages/preset/cc` 挂载在 cc-services 组尾、turn-rules 之后——turn-rules 的提示匹配器必须看到未被建议的提示（无论怎样，advisor 文本都被排除在匹配候选之外）。所有故障均向软侧失效：监听器绝不能阻塞步骤、向瀑布抛错或唤醒空闲驱动。
