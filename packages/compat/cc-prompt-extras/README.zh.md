# @dsh-cc/prompt-extras

[English](README.md) | 中文

面向 CC preset 的两个系统提示词叠加层，合成一个包、两个入口：

| 入口 | 贡献内容 |
|---|---|
| `@dsh-cc/prompt-extras/serena-first` | serena MCP server 就绪时，把代码问题引向 `mcp__serena__*` 符号工具。 |
| `@dsh-cc/prompt-extras/output-styles` | Claude Code 风格的输出风格，含项目与用户自定义风格。 |

两者是各自独立的 cordis 插件（插件 id 与 `inject` 集合都不同），因此 preset 以两行挂载：

```yaml
- id: serena-first
  name: '@dsh-cc/prompt-extras/serena-first'

- id: cc-output-styles
  name: '@dsh-cc/prompt-extras/output-styles'
```

## Serena-first 引导

CC 预设的 serena 优先提示词引导（参见 `README.md`）。

当 serena MCP 服务器已连接（仓库 `.serena/project.yml`，用户级
`~/.claude.json` 条目——见 `docs/code-intelligence-health.md`）时，会话中
存在约 30 个 `mcp__serena__*` 符号工具，可以在不整读文件的情况下回答代码
问题。本插件让系统提示词说明这一点：

- **贡献 A** —— 注册 `serena-first` 段落（order 105），动态 provider 在
  serena 就绪时渲染策略段落，否则渲染空字符串（渲染时被丢弃）。
- **贡献 B** —— `system-prompt/assemble` 瀑布监听器（`{ prepend: true }`，
  最外层，返回值权威），在 serena 就绪时以 replace-not-mutate 方式为上游
  `tool:read` 与 `tool:grep` 段落各追加一句。

检测仅依赖注册表且实时求值：对 `mcpConnections` 做鸭子类型读取
（`state: 'ready'` 且 `toolCount > 0`），每次组装时重新求值，因此会话中途
断开会在下一轮停止引导。无作用域的组装直接放行（与 `tool-append-order`
一致）；`tool:write`、`tool:edit`、`tool:glob` 永不改写。

配置：`enabled`（默认 `true`）、`serverName`（默认 `'serena'`）——后者同时
决定探测与所有 `mcp__<serverName>__*` 工具名。

## 输出风格

面向 DeepSeek Harness、兼容 Claude Code 的输出风格选择。选中的风格通过 `systemPrompt` 注册表贡献一个系统提示词 section——`default` 风格下为空——使模型的沟通契约镜像熟悉的 Claude Code `Explanatory`／`Learning` 风格，加上项目与用户自定义风格。

### 输出风格

随包提供三种内建风格：

| 风格 | 效果 |
|---|---|
| `default` | 不贡献任何 section。 |
| `Explanatory` | 指示模型在工作中解释其实现选择与代码库模式。 |
| `Learning` | 指示模型协作式教学，请求以单个 `TODO(human)` 标记为门槛的简短动手实践贡献。 |

自定义风格从 `<project>/.claude/output-styles/*.md`（项目）与 harness home `~/.dsh/output-styles/*.md` 加载，靠后的项目目录会覆盖同名较早风格。每个文件名即风格名；frontmatter 提供 `description`（必需）与可选的 `keep-coding-instructions` 布尔值（默认 `true`）：

```md
---
description: Keep answers concise and skip the usual preamble.
keep-coding-instructions: false
---
Your concise coding and communication instructions here.
```

当 `keep-coding-instructions` 为 `false` 时，所贡献的 section 会声明其取代默认编码指示 section；为 `true`（默认）时，默认编码指示会与该风格正文一起保留。格式错误或缺失的 frontmatter 会导致插件加载期明显失败。

### 选择

当前风格是 `cc-output-styles` 命名空间中的 settings 键 `outputStyle`，叠加在插件组合 `outputStyle` 配置之上。没有 settings 提供器时以组合值为主；随后 `/output-style` 仍会在会话内切换。

切换会重新发出 `system-prompt/change`，使下一个组装的提示词采用新风格的 section。

### `/output-style` 命令

通过 `ctx.commands` 注册；每个已组合的命令适配器都能发现并执行它，无需模型轮次。

| 输入 | 结果 |
|---|---|
| `/output-style` | 显示当前风格与可选择的风格。 |
| `/output-style <name>` | 设置当前风格；未知名称返回列出可选择风格的错误。 |

### 组合

插件注入 `systemPrompt` 与 `commands`。自定义应用会挂载其所有者与这一行：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: cc-output-styles
  name: '@dsh-cc/prompt-extras/output-styles'
  config:
    outputStyle: Explanatory
```

### 模型体验

#### 输出风格 section

##### 模型看到的内容

非 `default` 风格激活时，其正文以 `cc:output-style` 提示词 section 出现，并渲染在部署 persona 之前。`default` 风格不贡献任何内容。

##### Token 影响

`default` 风格不增加 token。非 default 风格会把各自的 section 正文加入每次组装的提示词。

##### KV Cache 影响

该贡献是固定的提示词 section 提供器；风格切换会改变 section 文本，从而改变下一轮次组装的提示词，与任何系统提示词 section 变更一致。

### 已知限制与暂缓事项

- **仅替换提示词 section**——`keep-coding-instructions: false` 表达在所贡献 section 的引导语中，而非注销 harness 自身拥有该槽位的编码指示提供器。
- **组合回退是静态的**——没有 settings 提供器时，重载后选择会回退到组合 `outputStyle`；`/output-style` 的持久化需要 `settings` 服务。
- **无插件强制风格**——Claude Code 插件自带的 `force-for-plugin` 输出风格不在本行范围内。
