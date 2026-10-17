# @dsh-cc/vwa-argument

可验证工作区智能体（VWA）lane-2 论证契约包（设计：
`docs/plans/2026-10-16-vwa-evidence-argument.md`）。切片 1（P0）交付包门面、
JSON Schema 契约、Ajv 校验入口和设置命名空间。功能**默认关闭且惰性**。

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
- **插件门面**（`src/index.ts`）：普通 cordis 插件，`apply(ctx)` 仅注册设置
  命名空间。无监听器、无工具、无评审运行 —— 在后续切片（§23）之前，挂载它
  不改变任何行为
  〔src:ws:packages/interaction/vwa-argument/src/index.ts#L1-L30〕。

不在本包内：回执写入（vwa-evidence 是唯一写入方）、评审执行器、工具/命令、
报告渲染器与 preset 行 —— 均属后续切片（§23 P1–P5）。
