# @dsh-cc/context-crusher

[English](README.md) | 中文

CCR（Compress-Cache-Retrieve）可逆的工具输出压缩。一个 `tools/post-execute` 监听器压缩大体量的 grep/日志形态的工具结果，把原文缓存到内容寻址存储，并附加 `ccr://<hash>` 标记；`context_retrieve({ hash })` 工具可原样取回原文。原文始终一次调用可得，因此压缩是无风险的。

## 门控流程

1. `tools/post-execute` 触发；crusher 是最外层监听器（`{ prepend: true }`，挂载在 hooks bridge 之前），在 `next()` 之后组合。
2. 下游非 `accept` 的决策原样通过。
3. 门控依序：未启用 → 受保护工具（replace 语义列表）→ 短错误（< 2×min）→ 低于最小尺寸 → 存在非 text 块 → 路由返回 `null` → 节省比例不足。每个门控都退化为透传。
4. `mode: 'dry-run'`（默认）只度量并追加 `applied: false` 的台账行；`mode: 'on'` 存原文、附加标记，并用一个全新 text 块替换结果。下游 `additionalContexts` 在替换后保留。
5. 所有 I/O 错误都退化为透传；缺少 `dshHomePath` 时强制禁用。此处抛错会把用户的工具结果变成错误——数据丢失——因此绝不向瀑布抛错。

## 标记契约（钉死）

`[dsh-cc compressed BEFORE→AFTER tokens. Original: ccr://<hash>]` —— 附加在每个被替换的结果上。`context_retrieve` 的工具描述引用同样的 `ccr://<hash>` 拼写；有测试钉死这一配对。`hash` 为 `sha256(原文 utf8)` 十六进制前 16 位。

## 存储

`$DSH_HOME/ccr/<projectKey>/<hash16>`，projectKey = `sha256(会话 cwd)` 前 16 位（与 TUI 项目根约定的工作树路径分歧在此被接受：存储自身一致）。原子 temp+rename 写入、纯 UTF-8 信封文件、LRU 200 条、TTL 3600 秒、写入后清扫（fire-and-forget）。损坏/过期条目封闭失败（`corrupt` / `expired` / `unknown_hash`）。

## 配置

命名空间 `cc-context-compression`（设置覆盖每次使用时重读；配置默认值在其下）。`protected-tools` 显式设置时替换默认列表——不是并集。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；2026-11-11 起默认开启（设 `false` 关闭）。默认 `dry-run` 模式下只写台账行，绝不改写工具结果。 |
| `mode` | `dry-run` | `dry-run` 只度量；`on` 替换。 |
| `min-bytes` | `8192` | 参与压缩的最小尺寸（按 token 度量；键名保留旧称）。 |
| `min-savings-ratio` | `0.4` | 最小 token 节省比例。 |
| `protected-tools` | 过宽的默认列表 | 永不压缩的工具。 |
| `reducer-enabled` | `false` | 证据保留型 reducer 总开关：合格结果经廉价模型的侧查询压缩，而非桩截断（§3.2）。 |
| `reducer-commands` | 过宽的默认列表 | 与 bash 调用命令行匹配的正则源，决定 reducer 资格；非法模式被丢弃，空列表回退默认值。 |
| `reducer-max-input-tokens` | `30000` | reducer 输入的头/尾截断阈值（token）。 |
| `reducer-min-savings-ratio` | `0.5` | 应用 reducer 输出所需的最小尺寸收益比例。 |
| `reducer-max-tokens` | `1024` | 侧查询输出 token 上限。 |
| `reducer-timeout-ms` | `10000` | 侧查询的挂钟时间预算（毫秒）。 |
| `reducer-alias` | `haiku` | 侧查询使用的廉价 lane 别名。 |
| `defer-requests` | `0` | 延迟外化：合格结果先原样进入会话，在累计这么多次主循环发送后换成标准桩；`0` 表示禁用延迟。 |
| `defer-margin` | `1.5` | 延迟换出的后缀成本闸门乘数。 |
| `defer-max-age-ms` | `1800000` | 从未换出的驻留项的清扫时限（毫秒）。 |
| `defer-urgency-tokens` | 未设置（不激活） | 窗口压力覆盖距离（token）：会话估算距模型窗口不足该距离时，驻留项无视闸门直接换出；没有窗口来源时不激活。 |

## reducer 决策闸门（S1-12）

可选对象 `reducer-decision-gate`，嵌在同一命名空间 `cc-context-compression` 之下。它是该命名空间中唯一按 key 逐个深合并的子对象（上面的扁平键仍保持替换语义）。闸门在生成式 reducer 花掉调用之前，用一个 SystemOne 决策判断"这份回执是否值得尝试"；回执是否有效仍由确定性校验器判定，因此一次跳过只是可撤销的调用预算策略——绝不是"回执不可能生成"的证明。它跑在所有廉价检查之后、lane 溯源检查之后，紧邻侧查询之前。

| 键（对象内） | 类型、范围 | 默认 |
|---|---|---|
| `mode` | `off` \| `shadow` \| `active` | `off` |
| `timeout-ms` | 整数，100–3000；整组判定共用一个预算 | `800` |
| `max-input-tokens` | 整数，512–16384；单次请求，含 state、全部问题与余量 | `4096` |
| `max-source-tokens` | 整数，512–32768；完整原文的上限 | `16384` |
| `max-chunks` | 整数，1–16 | `8` |
| `max-skip-index` | 有限数，0–4；实验性阈值 | `1` |
| `max-compressibility` | 有限数，0–1；实验性阈值 | `0.2` |
| `cache-entries` | 整数，0–1024；`0` 表示禁用缓存 | `128` |
| `cache-ttl-ms` | 整数，0–300000 | `60000` |

模式：`off`（默认）从不调用闸门——无请求、无台账行，reducer 路径与加闸门前逐字节一致。`shadow` 判定并记录台账，但始终继续原有生成。`active` 可以跳过生成，且仅当每个分块都回答 `score ≤ max-skip-index` 且 `noul ≤ max-compressibility`；跳过会记入台账 `applied: false`，原因 `decision-gate`，并显式写入零节省（闸门的分数绝不会被当成节省量）。

开放失败：非法值（类型不符或超出范围）、非对象值、未知 `mode` 都会让该次解析的整个闸门退化为 `off`——配置错误绝不解读为"reducer 被禁用"，原有 reducer 照常继续。缺少决策服务、决策 scope 或会话水位时，闸门同样保持不激活。`enabled: false` 或 `reducer-enabled: false` 让闸门休眠，且 `mode: active` 无法启动一个本来关闭的 reducer；闸门的 `active` 与 crusher 的 `dry-run`/`on` 是相互独立的状态。

回滚：把 `reducer-decision-gate` 设为 `{ mode: off }`（或删除该对象）——reducer 回到加闸门前的路径，没有其他键需要回退。

## `foldCounters` 约定

本包为 `@dsh-cc/token-efficiency` 导出 `foldCounters(materials)`；标记/台账形态的任何变更必须在同一个 PR 中同步更新该 fold 及其测试。

## 注意事项

- 转录中永久保留的是压缩后的形态：TUI 回放与 `command-export` 展示压缩块（原文只在存储与台账中）。
- `final-result` 派发与工具定义的 `finalizeContent` 绕过或晚于瀑布，可能重写已压缩内容——残余绕过类别，尽力覆盖。
- 标记是惰性文本；没有自动恢复，也没有模型摘要。
