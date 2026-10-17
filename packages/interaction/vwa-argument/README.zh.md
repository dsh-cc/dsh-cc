# @dsh-cc/vwa-argument

可验证工作区智能体（VWA）lane-2 论证包（设计：
`docs/plans/2026-10-16-vwa-evidence-argument.md`）。切片 P5 后功能已完整：
契约、存储/论证图、评审流水线、工具、`/vwa` 命令、v2 回执与报告渲染器。
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
  （按阶段的后台语义评审）
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
  kebab 键。`semantic-enabled` 默认为 **false**；全部评审预算遵循 §13。
  与 vwa-evidence 相同的双半模式：`registerNamespaceSafe` 供 /config 使用，
  外加对 `<dshHome>/settings.json` 的失败回退原始热读
  （`readUserSettingsSync`）
  〔src:ws:packages/interaction/vwa-argument/src/settings.ts#L1-L50〕。
- **Preset**（`packages/preset/cc/agent.vwa.cordis.yml`）：插件仅挂载于
  vwa 闭包 —— cc preset 刻意不含该行。

不在本包内：回执写入（vwa-evidence 是唯一写入方），以及冻结的语义评分器
`humanities-scorer@1` 与 humanities 金标集（`@dsh-cc/vwa-eval`，§22.2）。
