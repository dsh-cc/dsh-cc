# dsh-claude-code-agents

[English](README.md) | 中文

将 Claude Code 的 `.claude/agents/*.md` 与 `*.json` 子 agent 定义加载为 dsh agent preset。本包是一个纯文件系统驱动的翻译层：它发现 bundled、user 与 project 三层、解析并校验每个 agent 文件，并为每个 agent 返回一个类型化的 [`AgentDefinition`](./src/types.ts) ——不涉及 harness 运行时，因此该 loader 既可以与这个 preset 包一同被 Claude Code 插件 loader 复用，也可以由任何部署以任意方式接入消费。

## 作用

- **三层，高者优先。** bundled 层随包内置工具 agent（`explore` 与 `dsh-cc-guide`，均钉死 `model: haiku` 并带 Read/Glob/Grep 白名单），经 `discoverBundledAgents()` 提供。project 层是从项目根向上遍历找到的最近的 `.claude/agents` 目录；user 层是作者自己的 `~/.claude/agents`。定义以其文件 basename 为键，各层按级别遮蔽——bundled < user < project——同名本地文件总是覆盖其 bundled 同名者。
- **两种格式。** `.md` 文件的 YAML frontmatter 提供字段，其 markdown 正文（或 `prompt` frontmatter 覆写）提供系统提示。`.json` 文件是单个对象，其 `prompt` 字段即系统提示。
- **响亮失败。** 每个坏掉的已知 frontmatter 值都会在加载期带着文件路径与字段名抛错，因此坏 agent 会被修复而非静默降级。未知字段被忽略，因此针对更新版本 Claude Code 编写的定义可移植到受支持子集。
- **字段翻译。** `description` 成为 when-to-use 指南；`tools`/`disallowedTools` 编译为单个有效的 `allow`/`deny` 工具约束，其名称求交集（同时出现在两个列表中的名称被禁用）；`model`（含归一化的 `inherit` 哨兵）、`effort`、`permissionMode`、`maxTurns`、`initialPrompt`、`background`、`memory`、`skills`、`mcpServers`、`hooks` 与 `isolation` 全部透传——且 `background` 不再是死字段:Task 工具会兑现它(在 `run_in_background` 缺省时转后台);`isolation: worktree` 也被 Task 工具消费(child 运行在 per-child git worktree 中——见 `@dsh-cc/subagent-task` 的隔离工作树一节)。

## API

- `loadClaudeCodeAgents(root, options?): Promise<AgentDefinition[]>` 从 `root` 向上遍历解析 project 层，遮蔽 user 层；`options.userDir` 覆写 user 的 `.claude/agents` 目录（对非默认 home 的 harness 与密封测试均有意义）。遇到第一个不可解析的 agent 文件即抛错。
- `parseAgentMarkdown(path, text, source): AgentDefinition` 与 `parseAgentJson(path, text, source): AgentDefinition` 解析单个内存中的文件；适用于单元测试与非目录输入。
- `splitFrontmatter(text): ParsedMarkdown` 从 markdown 字符串中切出开头的 YAML 块。
- `discoverBundledAgents(): AgentDefinition[]` 随包内置的 agent 集合（`source: 'bundled'`）；bundled 文档解析失败即抛错，与任何坏掉的 agent 文件一致。
- `discoverAgents(projectRoot, userDir?): Promise<AgentDefinition[]>` 不含 home 目录默认值的层合并。
- `loadAgentsDir(dir, source): Promise<AgentDefinition[]>` 与 `findProjectAgentsDir(start): Promise<string | undefined>` 按目录扫描与向上遍历。
- `resolveToolRestriction(tools, disallowedTools): ToolRestriction | undefined` 与 `normalizeModel(model): string | undefined` 纯约束合并与模型归一化辅助函数，导出以供复用与测试。

`AgentDefinition` 携带 `agentType`（文件 basename）、`whenToUse`、`systemPrompt`、`source`（`user` | `project` | `bundled`）、`baseDir`、`filename`，以及翻译后的可选字段。`toolRestriction` 值在结构上与 [`dsh-tools`](../../core/tools/README.md) 的 `ToolRestriction` 完全一致，因此消费方可以原样将其交给有作用域的 `ctx.tools.restrict()`。

## 设计

该 loader 刻意与集成解耦。它产出类型化定义并将消费——作用域工具约束、请求改写、权限选择——交给调用方，因此模型侧各部分无需拖入 harness 运行时即可复用。这与 [`agent-presets`](../../preset/agent-presets/README.md) 的理念一致：自包含词表喂给显式消费方，而不是在 loader 内部隐藏默认步骤。
