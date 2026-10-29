# @dsh-cc/plugin-dsh-cc-agents

[English](README.md) | 中文

官方 dsh-cc 插件，提供三个子代理、五个 skill 和可选的 Serena hooks。

## 组件

| 组件 | 用途 | 模型别名 |
| --- | --- | --- |
| `dsh-cc-agents:critic` | 分析、架构决策、计划评审和原因分析 | `opus` |
| `dsh-cc-agents:executor` | 执行已批准且完全明确的计划 | `sonnet` |
| `dsh-cc-agents:marathon` | 涉及大量文件的变更、需求未知的任务和长时间调试 | `fable` |
| `dsh-cc-agents-orchestration` | Agent 选择和报告契约 | 主 agent |
| `data-analysis` | 指标口径、对账和报告检查 | 主 agent |
| `vwa-writing` | 来源证据、论证审查、文章写作和交付 | 已配置的 VWA reviewer |
| `formal-design` | 在现有设计评审前进行有界 TLA+ 建模、TLC 检查、带实现一致性校验的 Lean 证明和证据审查 | 主 agent |
| `vwa-batch` | 无人值守的多页 VWA 审查批次：manifest、单次任务授权、九个检查点、断点续跑和批次台账 | 已配置的 VWA reviewer |

critic 采用只读人格，通常在后台运行；executor 和 marathon 可以修改文件，通常在前台运行。

使用结果前请核查其报告。critic 的只读行为属于人格规则，不是宿主强制执行的写入限制。

未配置的内置别名会继承父路由。若要为不同任务选择不同模型，请配置别名。

## 安装

使用支持插件安装命令的 Claude 兼容客户端。

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-agents@dsh-cc
```

重启 dsh 以加载插件。用 `/skills` 查看 `vwa-writing` 和其他已安装技能。

## 更新

先更新插件市场，再更新已安装的插件缓存。

```text
/plugin marketplace update dsh-cc
/plugin update dsh-cc-agents@dsh-cc
```

更新后请重启 dsh。仅更新插件市场不会更新已安装插件。

## 形式化设计

对涉及共享状态顺序、重试或迟到消息、崩溃恢复、异步所有权和授权的协议或状态机变更，
使用 `formal-design`。主对话负责建模和解释反例。包内 runner 检查有界模型并审计证据，
不增加运行时强制机制或新的评审通道。

安装只使 skill 可用，不会启用项目级筛查。用户需将[项目规则片段](skills/formal-design/references/agents-snippet.md)
手动加入当前生效的项目规则。明确请求或已加载的 orchestration skill 也可选择它。
主对话在首次使用时说明规则采用情况和缺失的评审规则，不会自动编辑 AGENTS.md。
更新插件后需重启 dsh，才会使用更新后的 skill 和 runner。

执行模型检查只需 PATH 中有 Java >=17。插件已包含固定 TLC v1.7.4 JAR，
无需另外下载或配置 JAR。普通 dsh 启动不需要 Java，运行时和安装阶段也不会执行下载脚本。
选择顺序为 --jar、TLA2TOOLS_JAR、内置 JAR。明确配置的 JAR 缺失或校验失败时会阻塞检查，
不会静默回退；所有来源都必须匹配固定校验值。
[第三方通知](skills/formal-design/toolchain/THIRD-PARTY-NOTICES.md)记录原始产物、源码和许可。
详见 [skill](skills/formal-design/SKILL.md)、[建模指南](skills/formal-design/references/modeling-guide.md)、
[评审契约](skills/formal-design/references/review-contract.md)和[完整示例](skills/formal-design/examples/task-lifecycle/workflow.md)。

### Lean 验证

Lean 适用于高影响的确定性行为：带明确不变式的权限、策略、资格或配置组合；
带明确守恒、边界或排序要求的预算、配额、分配或排名算术；需要通用正确性性质的
确定性转换；或用户明确要求 Lean 验证。事件顺序、重试和恢复仍走 TLA+ 路径；
选择 `both` 时还会增加经过评审的 bridge。

Lean 不随插件打包。请在 Linux x86-64 或 macOS arm64 上单独配置固定版本
`leanprover/lean4:v4.35.0`：

```sh
node skills/formal-design/scripts/lean-provision.mjs --dest <root>
```

该辅助脚本会按 `scripts/lean-toolchain.json` 校验 SHA-256、解压归档并写入 receipt。
检查按 `--lean-root`、`FORMAL_DESIGN_LEAN_ROOT` 的顺序解析根目录；缺失或不匹配会阻塞。
启动和检查过程均不会下载。

Lean 命令为 `lean-preflight.mjs`、`lean-check.mjs`、`lean-check-conformance.mjs`
和 `lean-check-evidence.mjs --stage proof|acceptance`；`check-combined-evidence.mjs`
审计两个后端。证明会校验声明种类、命题完全一致以及公理集合在
`propext`、`Classical.choice`、`Quot.sound` 之内。一致性校验让 Lean 参考实现和项目
实现在固定的有限语料上运行。限制：面向 JSON 边界的确定性纯函数、有界的文件与语料
大小、不支持 Mathlib、Lake 或第三方包，也不做 TypeScript 到 Lean 的翻译〔src:ws:docs/plans/2026-10-26-formal-design-lean-verification.md#L51-L55〕。

Lean 结果表示所列命题在记录的定义、假设和允许公理下通过了内核检查，且实现与参考
在记录语料上一致；它不证明任意 TypeScript 代码与模型等价，也不证明整个程序或部署正确〔src:ws:docs/plans/2026-10-26-formal-design-lean-verification.md#L903-L911〕。
详见 [Lean 建模指南](skills/formal-design/references/lean-modeling-guide.md)、
[一致性指南](skills/formal-design/references/lean-conformance.md)和
[组合模型](skills/formal-design/references/combined-models.md)。

每个已配置 case 都必须验证通过，包括 expansion case。证据新鲜且审计有效不等于模型通过，
还需读取 verification 字段。覆盖充分性和现有评审批准是独立条件。评审者必须收到同一次运行的
完整模型输入及每个 case 的两份日志。验证结论不超出指定模型、参数、性质和假设。

## VWA writing

需要来源证据的研究文章、历史或文学分析、技术报告，可使用 `vwa-writing`。

它既可在不修改正文的情况下审查已有文章，也可用于撰写和修订新文章。

普通编码、翻译和文字润色无需使用此流程，除非你明确要求证据审查。

### 前置条件

skill 不会自动启用 VWA，默认 preset 仍是 CC。

请使用包含第二层交付工具的 dsh-cc 构建。其他客户端可能能加载 skill，但缺少这些工具。

1. 将以下内容加入 `$DSH_HOME/settings.json`，默认目录为 `~/.dsh`。

```json
{
  "vwa-argument": {
    "semantic-enabled": true,
    "review-alias": "sonnet"
  },
  "vwa-evidence": {
    "enabled": true
  }
}
```

2. 修改启用开关后，重启 dsh。
3. 执行 `/preset vwa`；如果当前会话已锁定，请新建会话。
4. 在工作区执行一次 `/vwa init`。
5. 用 `/vwa status` 查看项目。

`review-alias` 是已配置的别名，不是固定模型名，默认为 `sonnet`；未配置的内置别名可能继承父模型。

项目额度在初始化时冻结。reviewer 使用宿主模型路由，审查会消耗模型调用、token 和时间。

`semantic-mode` 设置项目的初始模式标记，不会强制每次交付都通过审查。

skill 会一次列出缺失的前置条件，只读脚本检查设置、项目元数据和实时发现的工具名称。

该脚本不能证明数据完整性或文章质量，这些检查由运行时工具执行。

skill 不会修改全局设置、冒充用户命令，也不会直接写入项目内部状态。

### 使用请求

撰写新文章时，请提供问题、资料范围、语言和输出路径，例如：

```text
请用 vwa-writing 写一篇关于港口关闭的中文文章。
使用 docs/sources/ 中的资料作为证据，正文写入 docs/article.md。
说明有依据的结论、有争议的主张和缺失的证据。
审查后可以修订正文。
```

审查已有文章时，请说明是否允许修改，例如：

```text
请用 vwa-writing，依据 docs/sources/ 审查 docs/article.md。
不要修改正文，请生成问题报告。
```

### 工作流程

1. 检查可用工具、设置和当前项目。
2. 用 `argument.update` 设置研究契约。
3. 阅读来源，用 `evidence.register` 登记准确摘录。
4. 用 `evidence.search_log` 记录实际进行的检索。
5. 用 `argument.update` 建立主张、证据组和论证。
6. 用 `argument.update` 绑定当前正文。
7. 以 `input.stage: "all"` 调用 `argument.review`。
8. 等待宿主任务结束并查看发现的问题。
9. 在冻结额度内执行获准修订，相关内容变化后重新绑定并审查。
10. 用 `argument.report` 生成报告。
11. 通过宿主展示正文与报告的准确路径。

### 结果与限制

证据评级、当前问题和交付状态由运行时决定，skill 不能自行判定通过。

等待中或未完成的任务不算审查通过，报告或已审查候选状态也不代表确认交付。

正文和报告的准确路径都必须进入宿主展示事件，才可能达到 `delivered-reviewed`；缺少展示时，交付未确认。

审查失败、证据缺失和预算耗尽都必须明确呈现，最终结果可能是未验证稿。

用运行时报告查看主张强度、前提、推理、争议和证据缺口；必要限定也应写进正文。

只有用户可以执行 `/vwa sign` 和 `/vwa adjudicate`。critic 的意见不能替代 `argument.review`。

语义审查仍处于实验阶段，人工校准和真实模型验收尚未完成，评级不是事实正确性证书。

包内包含 [skill](skills/vwa-writing/SKILL.md)、[工具契约](skills/vwa-writing/references/tool-contract.md)和[写作规范](skills/vwa-writing/references/writing-rules.md)。

相对资源路径以已安装的 skill 目录为基准，无需仓库源码副本。

## VWA batch

当用户给出一条指令和一份页面清单、希望无需逐页交互就把整轮跑完并产出台账时，使用 `vwa-batch`：
每页一个项目、审查、冻结评估、一次修复加报告的提交、推送、PR、CI，最后产出
`docs/vwa-reports/batch-<batchId>.md`。

驱动者是 agent 本身，没有常驻 runner，也没有守护进程。批次目录
`.dsh/vwa/batches/<batchId>/` 存放 manifest、授权描述文件和状态文件；续跑时逐项从磁盘证据
重算检查点，不信任状态缓存。

唯一的用户动作是 `/permissions grant .dsh/vwa/batches/<batchId>/grant-descriptor.json`。
该命令由任务授权链单独交付；在它落地前，批次会在授权检查点中止，两种情况下契约一致。

详见 [skill](skills/vwa-batch/SKILL.md)、[状态契约](skills/vwa-batch/references/state-contract.md)
和[报告模板](skills/vwa-batch/references/batch-report-template.md)。

## 名称冲突

项目 agent 可以使用相同的裸名，插件 agent 使用组件表中的完整作用域标识符。

两种定义都可能出现在目录中，插件定义带有官方构建说明。

## 可选的 MCP 工具

agent 定义声明了可选的 MCP 工具，dsh-cc Task 派发器会移除不可用的名称并显示警告。

连接这些服务器后，派发器会在子 agent 启动前激活指定工具，并在需要时加入 ToolSearch。

- Critic 声明五个只读 Serena 工具、sequential_thinking 和两个 context7 查询工具。
- Executor 声明十二个 Serena 工具，包括符号修改、诊断和语言服务器重启。
- Marathon 使用 executor 的工具，并增加 critic 的推理工具。

请保留服务器别名 `serena`、`sequential_thinking` 和 `context7`；使用其他别名可能导致指定工具不可用。

直接调用 `AgentProvider.start` 不会移除不可用工具名称。直接调用时，请先净化工具列表或删除不可用的 MCP 条目。

## Serena hooks

PreToolUse hook 可中止反复的原始 read/grep 调用并提醒使用符号工具，每个会话每两分钟最多提醒一次。

SessionEnd hook 清理该会话的 hook 状态。两个 hook 都要求项目已配置 Serena，且 PATH 中可找到 `serena-hooks`。

项目检查会从会话目录向上到 Git 根查找 `.serena/project.yml`。两个前置条件未同时满足时，hooks 不执行操作。

用以下命令安装二进制。

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

Hook 状态通过 `SERENA_HOME=<repo>/.serena` 保持在沙箱写入边界内，请勿将 `.serena/hook_data/` 加入版本控制。

同一种提醒只保留一处。仓库内的第二个提醒可能对相同调用重复计数。

没有 Serena 项目时，每次 read/grep 仍会启动一次带条件检查的 Node 进程，通常约 50 ms，不会启动 Python。

禁用插件可消除这项 hook 开销。发布后请更新插件，以取得 hook 的变更。

## 本地插件目录

宿主组合设置 `pluginDirs` 可加载源码副本或已安装的 `@dsh-cc/plugin-dsh-cc-agents` 包。

插件 CLI 命令不能修改这个组合设置。常规使用请选择插件市场安装方式。
