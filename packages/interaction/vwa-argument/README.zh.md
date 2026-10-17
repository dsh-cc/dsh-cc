# @dsh-cc/vwa-argument

可验证工作区智能体（VWA）lane-2 论证包（设计：
`docs/plans/2026-10-16-vwa-evidence-argument.md`）。本包提供契约、存储/论证图、评审流水线、作者与报告工具、`/vwa` 命令、v2 回执与报告渲染器。人工金标集和真实模型验收完成前，语义质量仍属实验性；确定性集成测试通过不等于语义准确率已达标。
语义评审保持**默认关闭**（`vwa-argument.semantic-enabled: false`，§13）；
关闭时工具不注册，功能保持惰性。

- **契约**（`src/contracts/`，JSON Schema Draft 2020-12）：
  - `author.schema.json` —— 作者侧论证图（`ProjectSnapshot`：来源、证据、
    论断、证据组、论证、议题、检索记录、工件；§5）
    〔src:ws:packages/interaction/vwa-argument/src/contracts/author.schema.json#L1-L40〕。
  - `review.schema.json` —— 评审记录：分阶段 `ReviewResponse` 判别联合、
    `Finding`、`Assessment`、`AdjudicationRecord`、`ExtractedAtomicClaim`、
    `ExtractionRecord`、`MechanicalStatus`（§6、§11.4）
    〔src:ws:packages/interaction/vwa-argument/src/contracts/review.schema.json#L1-L40〕。
  - `receipt-v2.schema.json` —— v2 回执行（§16.1）。`ReceiptV2` 的 TS 类型
    由唯一回执写入方 `@dsh-cc/vwa-evidence` 持有；本包只提供校验 schema
    〔src:ws:packages/interaction/vwa-argument/src/contracts/receipt-v2.schema.json#L1-L20〕。
- **存储与论证图**（`src/store.ts`、`src/graph.ts`、`src/sources.ts`、
  `src/dependencies.ts`、`src/policy.ts`）：不可变、链式哈希的项目图，
  原子可恢复写入（temp + fsync + rename，§14）；来源快照为逐字节副本并
  对照真实文件字节校验（D02/D06/D10）；依赖摘要使旧评审自然失效；策略
  依据活跃发现集计算工件等级
  〔src:ws:packages/interaction/vwa-argument/src/store.ts#L1-L40〕。
- **评审流水线**（`src/review-adapter.ts`、`src/review-runner.ts`、
  `src/review-tasks.ts`、`src/audit.ts`）：分阶段提示词
  （`prompts/sources|support|arguments|extract|align.md`），由
  `argument.review` 注册的带预算后台运行并立即返回（§14、D14）；评审从不
  修改正文或作者图；相同 `requestId` 返回缓存的运行状态（D07）。
- **工具**（`src/tools.ts`，仅在 `semantic-enabled` 时挂载，§13）：
  `evidence.register`（来源快照与摘录，引文由运行时读取）、
  `evidence.search_log`（1–50 条检索记录，本身不执行检索）、
  `argument.update`（原子全图变更联合）、`argument.review`
  （按阶段的后台语义评审）、`argument.report`（确定性 Markdown/JSON，可写入 `docs/vwa-reports/<projectId>/`，不调用模型）
  〔src:ws:packages/interaction/vwa-argument/src/tools.ts#L1-L40〕。
- **命令**（`src/commands.ts`）：封闭语法的 `/vwa
  <init|status|import|sign|adjudicate|repair>` 命令 —— 仅限人类来源
  （D21）、裁决必须给出非空理由且从不改写模型的原始记录、存储修复采用
  最新自校验候选（§14.2）
  〔src:ws:packages/interaction/vwa-argument/src/commands.ts#L1-L40〕。
- **报告**（`src/report.ts`、`src/report-render.ts`）：四个目标问题仅凭
  报告即可回答（§22.3），保留评审者分歧（D19）与逐发现的出处。
- **校验**（`src/schema.ts`）：Ajv 8 strict、Draft 2020-12 入口，
  `coerceTypes:false`、`useDefaults:false`、`removeAdditional:false`（§25）。
  UUID/Hash/Span 规则为显式 schema 模式加运行时辅助函数（`isPrefixedId`、
  `isHash`、`spanError`）；字符串限额按 UTF-16 代码单元计。
  `stableJson`/`sha256Hex` 自 `@dsh-cc/vwa-evidence` 单向复用导出
  （§3 —— 反向导入被禁止且不存在）
  〔src:ws:packages/interaction/vwa-argument/src/schema.ts#L1-L40〕。
- **设置**（`src/settings.ts`）：命名空间 `vwa-argument`，§13 表中的扁平
  kebab 键。`semantic-enabled` 默认为 **false**；全部评审预算遵循 §13，并在项目初始化时冻结到 `contract.reviewSettings`；修改研究契约会保留这些运行时管理的限额。
  `review-alias`（默认 `sonnet`）指定评审所走的模型别名，绝不写具体模型 id。
  与 vwa-evidence 相同的双半模式：`registerNamespaceSafe` 供 /config 使用，
  外加对 `<dshHome>/settings.json` 的失败回退原始热读
  （`readUserSettingsSync`）
  〔src:ws:packages/interaction/vwa-argument/src/settings.ts#L1-L50〕。
- **宿主接线**（`src/review-host.ts`、`src/capture-wiring.ts`；仅在
  `semantic-enabled` 时生效）：`argument.review` 每次调用时解析 `llm`、
  `jobs` 与 `review-alias` 路由（宿主缺服务时返回带原因的
  `REVIEW_UNAVAILABLE`）；`tools/post-execute` 监听器把 `read`/`write`/
  `edit`/`web_fetch` 写入按会话隔离的采集登记表；绑定产物从调用方工作区读取；
  `vwa-argument` 交付服务经 `forWorkspace(root)` 绑定到调用方工作区
  〔src:ws:packages/interaction/vwa-argument/src/review-host.ts#L1-L20〕。
- **Preset**（`packages/preset/cc/agent.vwa.cordis.yml`）：插件仅挂载于
  vwa 闭包 —— cc preset 刻意不含该行 —— 与 vwa-evidence 同处 `vwa-lanes`
  组，组的 `isolate` 覆盖 `vwa-argument` 服务。

不在本包内：回执写入（vwa-evidence 是唯一写入方），以及冻结的语义评分器
`humanities-scorer@1` 与 humanities 金标集（`@dsh-cc/vwa-eval`，§22.2）。

## 交付与验证

调用完成不代表评审通过。交付只采用任务依赖、契约、策略、提示词和实际 prepared 模型配置仍匹配的记录。相关输入变化使旧判断失效；无关作者变更不会使独立支持任务失效。同输入下的评审分歧会保留，后来的 pass 不能擦除此前的 fail。必要前提按最弱支持等级传播，不同备选支持路径分别评价。

`all` 依次运行来源、支持关系、论断、论证和全文抽取/对齐。发送给 provider 的 schema 自包含，抽取响应接受严格校验，对齐必须返回 AUDIT-01 至 AUDIT-05。包括审计与修复重试在内的每次调用，均在派发前预留并持久化预算；进程中断后的预留不会变成免费调用。项目限额初始化后冻结；模型路由每次解析，实际 prepared 配置参与评审身份。

机械检查读取调用方工作区的实际文件。未安装的可选风格检查单独披露；链接检查和实际使用的可执行代码检查仍是必要条件。快照、哈希、引文失败阻止语义交付。报告保留当前评估、明确的前提与推论依据、限制、未解决问题和实验性校准状态。必须同时展示正文与报告的准确路径并匹配当前哈希，才推进交付状态；报告失败不能生成成功回执。签名要求用户会话中真实存在且匹配的回执；人工裁决随所绑定输入变化而失效。

验收覆盖和人工校准要求见 `docs/vwa/lane2-validation.md`。测试包含真实 Cordis 挂载下的 `all` 流程、报告与回执检查，以及 npm 包解包后的资源加载。语义功能保持默认关闭。
