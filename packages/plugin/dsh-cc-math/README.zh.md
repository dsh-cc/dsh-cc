# @dsh-cc/plugin-dsh-cc-math

[English](README.md) | 中文

官方 dsh-cc 数学研究插件。它提供一个可选 skill `math-research`：把自然语言命题转成 Lean 4
陈述并记录分级的形式化保真结论，在固定预算下借助 Mathlib 前提检索搜索证明，并运行只有通过
独立评估器才接受结果的发现循环。

证明的正确性只来自 Lean 内核，插件中的其他机制都不会认证一个证明。

## 状态

当前是 M0 骨架：manifest、skill、references 和评估包接线。运行时 `.mjs` 脚本（环境准备、
索引构建、检索、Lean 检查、claim 与预算账本）在后续 wave 落地。

`math-research` 按文件是否存在来打开各里程碑。只有当它点名的脚本存在于已安装 skill 的
`scripts/` 目录下时，M1、M2、M3 章节才生效。因此已安装的骨架会报告缺失的能力，而不是声称
执行了它无法运行的检查。

## 前置条件

- Node `^22.19` 或 `>=24`。建议 Node 24：前提检索和经验库使用 `node:sqlite` 的 FTS5。
  脚本在启动时探测 FTS5，缺失时以版本诊断失败退出，而不是静默降级。
- Lean 4 与固定版本的 Mathlib。插件会在工作区的 `.math/env/` 下一次性准备两者；Lean 版本由
  固定的 Mathlib 修订自带的 `lean-toolchain` 决定。准备是唯一的联网步骤，有效回执会被复用，
  不会写入主目录。
- 可选：Python `>=3.10` 加 `sympy`，用于计算检查。缺少时 `computation_verified` 为
  `not-applicable`，不会是 `pass`。

## 安装

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-math@dsh-cc
```

安装后重启 dsh，`/skills` 中即可看到 `math-research`。

## 快速开始

形式化一个已陈述的定理：

```text
用 math-research 把「前 n 个奇数之和等于 n 的平方」形式化为 Lean 4 并检查陈述可以
elaborate。在做任何证明尝试之前先记录保真等级。
```

先检索前提，而不是凭印象编造：

```text
用 math-research 在 Mathlib 中检索关于前 n 个奇数之和的引理，限制在当前证明文件的
import 范围内。
```

在预算内搜索证明：

```text
用 math-research 在 8 次尝试、200000 token 上限内搜索证明，并展示每次失败尝试的诊断。
```

一般数学写作不属于这个 skill。断言一个没有检查器验证过的结论同样不属于。

## 一次运行产出什么

所有内容都在项目目录下的 `.math/`，且 `.math/` 已被 git 忽略。`MATH_HOME` 可以把它改到
其他路径；脚本启动时探测可写性，不可写就失败退出，不会退回到别的位置。

`.math/runs/<run-id>/` 保存 `run-manifest.json`（全部配置，严格 schema）、
`problems/<problem-id>/`（陈述、证明、binding、保真与搜索产物）、`claims.jsonl`
（链式哈希）、`budget.json`、带回执的 `evidence/` 和 `report.md`。

另外，`packages/evaluation/math-eval` 提供仅检查结构的评估工具：运行 manifest schema、
消融矩阵、指标报告结构，以及 fixtures/gold-set 的结构检查。它不发起模型调用，也不会作为
插件在启动时挂载。

## 限制

- 只有 Lean 内核决定证明是否正确。任何模型判断、本插件的任何评分都不认证证明。
- 陈述保真分级判定，而不是默认成立。三项检查中有两项是模型判断，因此可能出现误接受；误接受
  会被测量并报告，`anchored` 等级只在存在可信参考形式化时适用。
- 会话内运行的计算检查只作参考：没有网络隔离时，失败不会被当作反例证据，也不会写成
  `computation_verified: fail`。权威失败需要隔离的运行环境。
- 派发之后的 token 消耗只能协作式约束。准入控制是精确的并有测试覆盖；忽略信封额度的子代理
  可以超支。
- 证明搜索是尝试级的。没有 tactic 级交互状态，没有 Lean IDE，也没有 MCP server。
- 新颖性结论仅供参考，不构成数学新颖性主张。
- 版本 1 对共享状态只有一个写入者：主对话。派发的子代理只写自己的尝试目录。

## 资源

安装包包含 [skill](skills/math-research/SKILL.md) 及其 references：
[formalize](skills/math-research/references/formalize.md)、
[prove](skills/math-research/references/prove.md)、
[discover](skills/math-research/references/discover.md)、
[evidence](skills/math-research/references/evidence.md) 和
[budget](skills/math-research/references/budget.md)。相对资源从已安装的 skill 目录解析，
不需要仓库检出。

系统设计见 dsh-cc 仓库中的
[docs/plans/2026-11-21-mathematical-research-harness.md](../../../docs/plans/2026-11-21-mathematical-research-harness.md)。
