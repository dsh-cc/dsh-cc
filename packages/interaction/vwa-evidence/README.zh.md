# @dsh-cc/vwa-evidence

可验证工作区智能体（VWA）证据基座（设计文档：
`docs/plans/2026-10-12-verifiable-workspace-agent.md` §4）：把一篇
markdown 交付物转成机器可查证证据回执的纯函数模块。

- **标记语法** `〔src:<sourceId>#L<a>-L<b>〕`（全角括号），仅在散文中识别
  （markdown-it AST 遮蔽围栏代码块与行内代码，遮蔽保持长度不变，因此所有
  span 始终是 UTF-16 代码单元索引）。v1 sourceId 词表：
  `ws:<相对工作区根的 posix 路径>`；多个来源用 `;` 连接。
- **语料白名单（冻结）**：realpath(workspace) 下的 `docs/**` ∪
  `**/*.md` ∪ `**/*.mdx`；realpath 逃出工作区的目标为越界。
- **论断检测**是测试钉死的四组正则：带单位/百分比的数字、ISO 日期、版本
  串、API/标识符形态；实体名按设计排除。未检出论断的文档产出零论断
  （上游判 abstained）。
- **校验**只做机械读回：白名单内的合法路径、文件存在、行号区间存在。
  语义一致性属于 judge 层（§4.4），不进入机械得分。
- **三道闸门**（§4.3）：A 链接/锚点/仓库内路径（纯仓库内检查）；B 文风在
  P2 固定 `abstained`（本仓库尚无可运行的规则集——接口为 D3 预留）；
  C 可执行性按冻结的围栏语言表（bash 干跑解析、ts/js 最小 `tsc --noEmit`
  级检查、其余语言带 detail 弃权），执行面为注入式（ctx 接线归 P2b）。
  单闸门超时（默认 30s）=> `abstained`；任一 fail => 整体 fail；
  `missing` = 闸门未运行。
- **回执**（§4.1）：带版本的 v:1 JSONL 行写入
  `<dshHome>/vwa-receipts/<encodeSegment(sessionId)>.jsonl`，经 sidecar-io
  `appendJsonl(..., {repairTail: true})` 并强制写后读回（最后一行必须可
  解析且 `artifactHash` 匹配）。§8 覆盖率 = marked-ok 论断数 / 检出论断数，
  首发阈值 0.9。

## Turn-stopping 插件（P2b，§4.5）

本包同时以普通 cordis 插件挂载（`inject = ['shell']`，post-edit-verify
惯用法），且仅进入 vwa 预设——cc 预设刻意没有该行（§4.4；
`vwa-evidence.enabled:false` 只是 vwa 内的关闭阀门）。`agent/turn-stopping`
监听器：

- **窗口锚定**：从本轮最后一条真实 `user/message`（`source.kind = 'user'`
  白名单，completion-gate 先例）到 `data.turn === payload.turn` 的
  `assistant/message`——绝不按轮次边界。中止/出错轮（无匹配尾消息，或
  `interrupted: true`）本轮不写回执，也不会顶替更早轮次的尾消息。
- **交付物集合**：窗口内 `edit`/`write` 的 `tool/call` 命中文件
  （post-edit-verify 的 EDITING_TOOLS 集合未导出——本地副本附出处注释）
  → realpath 去重 → 白名单 ∩ 工作区内。闸门 C 经 harness ShellExecutor
  执行（`ctx.shell`，在 `inject` 中声明）。
- **Nudge**（同步注入，`source.kind = 'vwa-evidence'`）：overall ≠ pass 或
  覆盖率低于阈值。限额：每交付物每轮 ≤ 1、每轮 ≤ 2、每会话
  `nudge-budget`（默认 4，热读）。自修复后的重评由同轮续跑自然产生
  （nudge 消息不是真实用户消息，窗口锚仍停在真实用户消息上）；仍不过的
  重评落地 fail/abstained 回执，文内弃权说明保留——v1 不阻断交付。
- **Settings 热读**（§4.4）：`registerNamespaceSafe` 注册仅为 /config 交互
  与校验；评估器每次分发直接重读原始 `<dshHome>/settings.json`
  （`readUserSettingsSync`），改动在下一轮生效、无需重启
  （completion-gate 双半模式，evaluate-time）。
- **唯一写者**：只有本评估器向 vwa-receipts 台账追加。
- **重启恢复**：pending = 全会话被编辑过、但台账中没有 `artifactHash`
  与当前文件匹配回执行的路径（重放来源：会话事件与磁盘上的台账）；已消耗
  的 nudge 预算从台账投影（`nudge.round > 0` 行）恢复。
- **时间关联**（实现备注，§4.5）：行身份遵循 config-snapshot v7 的三元组
  ——会话视图中的 `(artifactPath, event seq)`、进程 `bootId`、行的
  `appendedAt`（`ts`）——以及"取 ≤ 事件时间的最大 `appendedAt`"的选取规则。
  评估器将其实现为按会话单调事件序的每路径最后一行选取
  （`staleAgainst`），不引入额外的外部记账。

本包为 vwa 专属（按设计 §3.2(a) 不进入能力清单）。

计划：`docs/plans/2026-10-12-verifiable-workspace-agent.md`
