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

本包为 vwa 专属（按设计 §3.2(a) 不进入能力清单）；turn-stopping 接线、
交付物集合推导、settings 注册与 nudge 限额在 P2b 落地。

计划：`docs/plans/2026-10-12-verifiable-workspace-agent.md`
