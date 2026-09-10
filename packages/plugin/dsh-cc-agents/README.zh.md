# @dsh-cc/plugin-dsh-cc-agents

[English](README.md) | 中文

官方 dsh-cc 插件，提供三个 subagent 和一个编排 skill：

- **`dsh-cc-agents:critic`** — 推理密集型工作：复杂分析、架构决策、对抗性计划评审、根因分析。运行在 `opus` 模型别名上；只读人格。
- **`dsh-cc-agents:executor`** — 对已批准、已完全指定的计划做机械执行：格式化、简单重构、样板代码、重命名、测试、文档、检查。运行在 `sonnet` 模型别名上。
- **`dsh-cc-agents:marathon`** — 长周期、模糊或仓库级复杂度：架构重设计、跨模块重构、无明显线索的长期调试，以及主线程设计失败后的重新攻关。运行在 `fable` 模型别名上（未配置时继承主线程路由）；可变更人格，且没有后台 pin——默认像 executor 一样前台运行，因此委派方应在基于其报告继续之前先核验其报告。
- **`dsh-cc-agents-orchestration` skill** — 用于在这些 agent 之间做选择的路由表，以及后台不对称性与它们的报告契约。

## Prerequisites

这些 agent 请求 `opus` / `sonnet` / `fable` 模型别名。若这些别名未配置，
agent 仍能工作——未配置的别名会解析为继承父路由——但在你配置它们之前，
分道（重推理交给更强的模型、机械工作交给更快的模型）就不成立。
可选，非必需。

## Install

在支持插件的 Claude 兼容客户端中：

1. `/plugin marketplace add dsh-cc/dsh-cc`
2. `/plugin install dsh-cc-agents@dsh-cc`
3. 重启会话。

## Update

更新需要**两条命令**——仅重新拉取 marketplace 并不会刷新已安装的插件缓存：

1. `/plugin marketplace update dsh-cc`
2. `/plugin update dsh-cc-agents@dsh-cc`

## Name collisions

如果你的工作区定义了名为 `deep-reasoner` 或 `fast-worker` 的基于文件的
agent（例如 `.claude/agents/deep-reasoner.md`），裸名（`deep-reasoner`）
会解析到你的工作区定义；插件副本只能通过精确的带作用域 id 解析
（`dsh-cc-agents:critic` / `dsh-cc-agents:executor`）。
两者都会出现在 agent 目录中；插件副本带有独特的"official plugin build"
描述以便区分。

## MCP-enhanced tool surfaces (optional)

所有 agent 都在其 frontmatter 中列出延迟加载的 MCP 工具名。当宿主连接
这些服务器时，这些名字能在 spawn 期过滤中保留下来，并在子 agent 的首个
回合前预先激活，因此 agent 可以直接调用它们：

- **critic** — 五个只读 serena 符号工具
  （`mcp__serena__find_symbol`、`get_symbols_overview`、
  `find_referencing_symbols`、`search_for_pattern`、
  `get_diagnostics_for_file`），`mcp__sequential_thinking__sequentialthinking`，
  以及两个 context7 文档查询。
- **executor** — 十二个 serena 符号工具，包括引用感知的编辑家族
  （`replace_symbol_body`、`insert_before/after_symbol`、`rename_symbol`、
  `replace_content`、`replace_in_files`、`get_diagnostics_for_file`、
  `restart_language_server`）；其 serena-first 编辑策略随这些工具激活。
- **marathon** — executor 的编辑家族加上 critic 的推理集合：
  全部十二个 serena 符号工具（含编辑类）、用于多分支探索的
  `mcp__sequential_thinking__sequentialthinking`，以及两个 context7 文档查询。

没有这些服务器的宿主不受影响：这些名字随启动警告被丢弃，agent 仅靠内置
工具运行。

**可移植性说明：**"带警告丢弃"的降级是 dsh-cc Task 派发路径的属性，该路径
会在 spawn 时依据实时注册表对定义的工具列表做净化（sanitize）。插件加载器
自己导出的 `AgentProvider.start` 会原样叠加工具限制而不净化，当命名的服务
器缺失时可能在后端失败——如果你直接通过 provider.start 派发这些定义（或在
dsh-cc 之外嵌入它们），请先剥离 `mcp__*` 条目或自行净化。该增强还假定这些
服务器保持其惯用别名（`serena`、`sequential_thinking`、`context7`）；改名
的服务器会落入同样的"带警告丢弃"路径。

## Advisory safety: critic

`critic` 保留 `Bash` 工具用于只读验证（跑测试、复现失败、查看历史）。
其只读性是**人格契约，而非强制限制**——宿主不会阻止（默认置于后台的）
推理者执行可变更命令。避免把诱使其修改数据的任务交给它，并在采纳其输出
之前先审阅。

## Advanced: pluginDirs

你可以跳过 marketplace，把宿主的 `pluginDirs` 组合级设置指向本包目录，
从任意本地副本加载插件——本仓库的 checkout，或独立执行
`npm install @dsh-cc/plugin-dsh-cc-agents`。该开关是配置级的，CLI 插件
命令无法触达；推荐使用上文的 marketplace 流程。
