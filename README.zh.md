# dsh-cc

[English](README.md) | **简体中文**

## 熟悉的 Claude Code 工作流，自由选择模型，运行于 DeepSeek Harness

`dsh-cc` 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 组合成一个开箱即用、适合日常开发的编程 Agent 环境。你可以延续熟悉的项目资产与交互方式，同时自行决定使用哪些模型、工具、权限策略和 Agent 组合。

- **复用熟悉的工作流：** 支持 `.claude/agents`、`SKILL.md`、`CLAUDE.md`、hooks、权限规则、斜杠命令和会话恢复。
- **自由组合模型：** 将 `sketch`、`draft`、`blueprint`、`masterplan` 等稳定别名映射到当前 dsh 部署支持的任意 provider/model。
- **覆盖完整编程闭环：** 提供 TUI、MCP、记忆、子代理、后台任务、worktree、结构化输出和延迟工具发现。
- **保持可组合：** 通过 dsh 原生 profile/plugin 系统安装，无需长期维护 DeepSeek Harness fork。

> `dsh-cc` 不是 Claude Code，也不是 Claude Code 的包装器。它在开放、可组合的 DeepSeek Harness 运行时上实现了开发者熟悉的 Claude Code 风格工作流。

## 快速开始

安装 DeepSeek Harness 和 `dsh-cc` 启动器，然后直接启动：

```sh
npm install -g @deepseek-ai/dsh @dsh-cc/cli
dsh-cc
```

`dsh-cc` 要求 `dsh` **>= 0.1.2-rc.1**；默认的 `npm install -g @deepseek-ai/dsh` 目前即可满足（截至 2026-09-12），启动器会在启动时校验该下限。

如果已经安装 `dsh` **>= 0.1.2-rc.1**，只需安装启动器：

```sh
npm install -g @dsh-cc/cli
dsh-cc
```

启动器会创建并运行面向 CC 工作流的 `tui` profile。也可以显式组合这个 profile：

```sh
dsh plugin --profile tui add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell \
  @dsh-cc/bundle-tui
dsh --profile tui
```

同一套后端也可用于 dsh Web UI：

```sh
dsh plugin --profile web add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell
dsh web
```

### 可选：官方插件

上面的 bundle 就是快速开始的全部内容。仓库内建的 `dsh-cc` 插件市场另有两个按需安装的官方插件，提供预配置的子代理通道：

- **`dsh-cc-agents`** — `dsh-cc-agents:critic`（重推理的评审与分析，走 `opus` 别名）和 `dsh-cc-agents:executor`（已批准方案的机械化执行，走 `sonnet` 别名）子代理，外加一个编排路由 skill。
- **`dsh-cc-shunt`** — PreToolUse 门禁，把批量文件阅读和样板代码生成重定向到廉价通道的 worker 子代理，让大文件语料不进入主上下文（配置 `haiku` 别名才能真正省 token）。

在会话内安装：

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-agents@dsh-cc
/plugin install dsh-cc-shunt@dsh-cc
```

`/plugin install` 会替你写入 `enabledPlugins` 标记；安装后重启会话以加载新的 agents 和 hooks。后续更新分两步：先 `/plugin marketplace update dsh-cc` 重新拉取市场，再 `/plugin update <id>` 更新插件。各插件自己的 README（[agents](packages/plugin/dsh-cc-agents/README.md)、[shunt](packages/plugin/dsh-cc-shunt/README.md)）覆盖配置项与已知限制。

## 为什么选择 dsh-cc？

| 需求 | dsh-cc 提供的能力 |
| --- | --- |
| 延续项目约定 | 加载 Claude Code 风格的 agents、skills、项目记忆、settings、hooks 和插件命令 |
| 混合使用快模型与强模型 | 将稳定别名映射到由部署方控制的 provider/model 路由 |
| 委派复杂任务 | 支持子代理派发、后台执行、任务查看和可恢复路由 |
| 安全地并行开发 | 提供权限规则、审批流程、worktree 工具和工作区边界 |
| 避免预先加载全部工具 | 通过 `ToolSearch` 和 MCP 按需发现工具 |
| 在不同界面间切换 | 在终端和 Web profile 中复用同一套 CC 工作流后端 |

`dsh-cc` 已经用于开发 `dsh-cc` 自身。当前仓库的实际配置会把不同任务路由到 Kimi、GLM 和 DeepSeek 模型，具体映射见[使用 dsh-cc 开发 dsh-cc](#使用-dsh-cc-开发-dsh-cc)。

## 适合哪些开发者？

- 希望把 DeepSeek Harness 直接用作日常编程 Agent 的开发者；
- 已经积累 `.claude/` 项目资产，希望继续复用 agents、skills、hooks 和项目记忆的团队；
- 希望按任务选择 Kimi、GLM、DeepSeek 或其他模型，而不是绑定单一模型供应商的用户；
- 希望组合或扩展 Agent 的权限、工具、记忆、子代理和界面，而不是维护产品 fork 的插件作者。

## 当前兼容范围

`dsh-cc` 已覆盖终端交互、斜杠命令、MCP、会话恢复、worktree、模型别名、工具延迟发现等能力；部分 hooks、子代理、权限、记忆和厂商专属体验仍存在已知差异。

项目不会用模糊的“完全兼容”掩盖差异。每项能力的实现状态、证据和已知限制都记录在：

**[查看 Claude Code 功能兼容矩阵 →](docs/cc-parity-matrix.md)**

英文首页中的[兼容状态汇总](README.md#compatibility-at-a-glance)由仓库工具根据能力清单生成。

## 熟悉的编程 Agent 工作流

### 子代理

CC preset 可以发现并派发项目内 `.claude/agents` 中的 Claude Code 风格 Agent 定义：

```text
.claude/
  agents/
    reviewer.md
    debugger.md
```

Agent frontmatter 可以继续使用熟悉的模型别名，实际 provider/model 由 dsh 配置决定。

### Skills

CC skill provider 会发现基于 `SKILL.md` 的技能，包括项目自有技能和已安装的通用技能。

### 记忆

记忆层支持 `CLAUDE.md` 风格的项目上下文，以及面向长期信息的独立写入通道。记忆按工作区隔离，也可配置团队共享记忆。

### MCP

CC profile 中的 MCP 客户端支持：

- tools；
- resources；
- prompts；
- OAuth 2.1 流程。

使用 `/mcp` 查看和管理 MCP 连接。

#### 可选：Serena 代码智能

当你的 MCP 配置连接了 [Serena](https://github.com/oraios/serena) server 时，dsh-cc 会自动加以利用：系统提示词会引导模型在代码问题上优先使用 Serena 的符号工具，内置的 `explore` 子代理也会获得只读符号检索能力（`find_symbol`、`find_referencing_symbols`、`get_symbols_overview`）。Serena 完全可选——不安装时，会话行为完全一致，代码问答仍走内置的 Read/Grep 工具，只是少了这些引导。

在 `~/.dsh/.mcp.json`（或项目级 `.mcp.json`）中添加：

```json
{
  "mcpServers": {
    "serena": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/oraios/serena@v1.7.0", "serena", "start-mcp-server", "--context", "claude-code", "--project-from-cwd"]
    }
  }
}
```

连接状态可通过 `/doctor` 的 `mcp.serena` 检查项查看。

### Hooks

Claude Code 风格 hooks 可以响应会话、用户输入、工具、权限、压缩、任务和子代理生命周期事件。当前支持 command 和 HTTP executor，部分 prompt/agent executor 需要通过配置开关启用。

仓库跟踪了一个 `hooks.json`，CC preset 会从启动目录加载它。PreToolUse remind hook 需要在 `PATH` 中安装 `serena-hooks`，详见[本地开发](#本地开发)。

## 斜杠命令

CC preset 提供的命令包括：

```text
/cost              token / 费用信息
/doctor            会话健康检查（--verbose / --json）
/status            环境和会话状态
/memory            查看记忆
/skills            查看已安装技能
/config            查看或修改配置
/permissions       查看或修改权限模式/规则
/mcp               管理 MCP 连接
/tasks             查看任务和后台作业
/resume            恢复中断的会话
/branch            管理 worktree 分支
/diff              查看 CLAUDE.md / settings 差异
/init               扫描项目并生成 CLAUDE.md
/plugin             管理插件
/provider           管理模型供应商（列表/添加/删除、轮换密钥、设为默认）
/release-notes      查看版本说明
/version            查看版本信息
```

TUI 还提供 todo 查看、审批、排队输入、对话导出、用量/上下文显示和本地 shell 命令等终端交互。

`/provider` 在覆盖层中管理已配置的模型供应商：`/provider list` 列出当前路由，`/provider add <preset-id>` 通过向导添加内置预设（Moonshot、Z.AI/智谱、DeepSeek）或完全自定义的端点；每个路由的详情页支持轮换密钥、刷新模型列表、设为默认和删除。API 密钥通过掩码输入框录入并保存到凭据存储（`~/.dsh/.credentials.yaml`），不写入 settings；由环境变量提供的密钥只读展示。变更对新会话立即生效（凭据按请求解析）；当前会话保持原供应商，直到用 `/model` 重新选择。

## 使用你需要的模型

Claude Code 风格 Agent 定义通常通过别名引用模型：

```yaml
model: sonnet
```

`dsh-cc` 可以把这些别名路由到部署中配置的 provider/model：

```text
sonnet / draft      -> <provider>/<通用编程模型>
opus / blueprint    -> <provider>/<推理模型>
haiku / sketch      -> <provider>/<快速模型>
fable / masterplan  -> <provider>/<最强推理模型>
architect           -> 继承主 Agent 路由（规划/编排）
inherit             -> 继承主 Agent 路由
```

别名只是配置，不会硬编码到某家模型供应商。你可以保留稳定的 Agent 定义，同时根据自己的环境、成本和任务特点选择实际模型。

### 使用 dsh-cc 开发 dsh-cc

本项目当前使用下面的映射进行日常开发：

| 别名 | 模型 |
| --- | --- |
| `fable` / `masterplan` | `kimi-k3` |
| `opus` / `blueprint` | `glm-5.3` |
| `sonnet` / `draft` | `glm-5.3-flash` |
| `haiku` / `sketch` | `deepseek-v4-flash-0731` |
| `architect` | 继承主线程模型 |

这只是项目自身的真实配置，不是强制默认值。用户可以映射到 DeepSeek Harness 部署支持的其他模型。

## 与其他方案有什么不同？

### 与 Claude Code 相比

Claude Code 是完整的编程 Agent 产品。`dsh-cc` 则把许多熟悉的交互模式带到 DeepSeek Harness，让部署方自行控制模型、工具、插件、权限和 Agent 组合。

### 与 DeepSeek Harness fork 相比

本仓库主要以外部插件栈的方式提供能力。大部分功能通过 dsh profile 安装和组合，减少上游演进时维护长期 fork 的成本。

少数组件因为依赖 DeepSeek Harness 当前尚未开放的内部扩展点而包含 vendored 实现，具体说明见英文首页的[架构章节](README.md#architecture)。

### 与模型/API Router 相比

`dsh-cc` 不只是切换模型的代理层。它扩展的是整个 Agent 运行时和开发体验，包括 UI、命令、工具、记忆、子代理、hooks、MCP、权限、会话和 worktree 工作流。

## CC Mode

CC Mode 是一个额外的 dsh Agent preset，不会改变 dsh 原有四种模式的行为。

在 `tui` profile 中，CC Mode 默认启用；在其他 profile 中，可以通过 preset selector 选择，或配置为默认 Agent preset。

终端 profile 默认使用全屏模式。单次关闭全屏模式：

```sh
DSH_CCTUI_UI_MODE=regular dsh --profile tui
```

## 配置

profile 仍然是普通的 dsh 组合。自定义覆盖可以放在：

```text
~/.dsh/profiles/tui/cordis.patch.yml
```

它会在已安装 bundle 之后应用。模型别名、权限、settings 优先级、hooks、记忆和 TUI 行为都由对应插件的配置项控制。

精确语义以各 package README 和[兼容矩阵](docs/cc-parity-matrix.md)为准。

### 自定义状态栏

在 `tui` profile 中，你可以用自定义 shell 命令替换内置的底部状态栏（与 Claude Code 兼容）。该配置块可以放在用户文件 `~/.dsh/settings.json` 或项目文件 `.claude/settings.json` 中：

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.dsh/statusline.sh",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

与 Claude Code checkout 共享的项目 `.claude/settings.json` 文件可以直接使用；如果同时存在 camelCase 的 `statusLine` 和 dsh 原生的 kebab 风格 `statusline` 键，dsh 原生键优先。

命令会在 stdin 上收到与 Claude Code 兼容的 JSON 会话负载（契约见 [CC statusline 文档](https://code.claude.com/docs/en/statusline)）；dsh-cc 只提供能真实取到来源的字段。命令 stdout 的第一行会成为状态栏内容（ANSI 转义原样透传）；失败或输出为空时渲染为空白行。命令会在会话启动/恢复、新消息、mode 和模型变化时重新运行——命令本身变化时立即运行——此外还按 `refreshInterval` 定时器运行，单位为**秒**（最小值 1）。脚本的环境中会带上 `COLUMNS`/`LINES`。

v1 注意事项：只渲染输出的第一行（CC 会渲染每一行），并且运行中会话之外对 `settings.json` 的修改要等到下次重启才生效。

## 兼容性与已知限制

项目目标是提供**实用的 Claude Code 风格工作流兼容性**，而不是逐字节模拟 Claude Code。

部分 hook 事件、后台子代理流程、通知/IDE shell 行为和供应商专属功能仍然不完整，或者依赖 DeepSeek Harness 后续开放扩展点。项目会在[兼容矩阵](docs/cc-parity-matrix.md)中明确标注完整、部分支持、缺失和非目标能力。

## 本地开发

本仓库默认在 `../deepseek-harness` 存在同级 DeepSeek Harness checkout，用于本地 `link:` 依赖开发：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

当前 dogfooding 配置使用 `serena-hooks`：

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

更多离线开发、依赖和测试说明见 **[docs/dev.md](docs/dev.md)**。

## Packages 与版本发布

已发布插件使用 `@dsh-cc` npm scope。根 monorepo package 为 private；可安装 package 由仓库发布工具分别发布。

发布流程详见 **[docs/release.md](docs/release.md)**。

## 项目状态与参与方式

`dsh-cc` 会跟随仍处于快速演进阶段的 DeepSeek Harness 更新，兼容边界可能随着上游扩展点变化。

如果某个工作流与 Claude Code 表现不同，请先查看[兼容矩阵](docs/cc-parity-matrix.md)，确认它属于已实现、部分支持、非目标还是尚未实现。欢迎提交：

- 带复现步骤和 `/doctor --json` 输出的兼容性报告；
- 聚焦单项能力的 bug 修复或测试；
- 能减少 vendored 代码的上游扩展点提案；
- 来自真实项目的模型路由和工作流实践。

**[提交 Issue](https://github.com/dsh-cc/dsh-cc/issues) · [查看 Pull Requests](https://github.com/dsh-cc/dsh-cc/pulls)**

## License

[Apache-2.0](LICENSE)
