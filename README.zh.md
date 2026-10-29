# dsh-cc

[English](README.md) | **简体中文**

## 在 DeepSeek Harness 上使用编程与文档工作流

`dsh-cc` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加 Claude Code 风格的工作流。模型、工具、权限和 agent 配置由你选择。

- 复用 `.claude/agents`、`SKILL.md`、`CLAUDE.md`、hooks、斜杠命令和已保存的会话。
- 将模型别名映射到当前部署可用的 provider 和模型。
- 使用 TUI、MCP、记忆、子代理、后台任务、worktree 和结构化输出。
- 使用 `context-crusher` 与 `context_retrieve` 进行可逆的工具输出压缩。
- 通过可选的 `vwa-writing` skill 为文档增加证据检查。

`dsh-cc` 是 DeepSeek Harness 的插件栈，不是 Claude Code，也不是 Claude Code 的封装。

## 快速开始

安装 DeepSeek Harness 和启动器。

```sh
npm install -g @deepseek-ai/dsh @dsh-cc/cli
dsh-cc
```

启动器要求 `dsh >= 0.2.0-rc.2`。如果版本更旧，启动器会停止并提示升级。

如果已经安装所需版本的 dsh，只需安装启动器。

```sh
npm install -g @dsh-cc/cli
dsh-cc
```

### 升级

```sh
npm install -g @dsh-cc/cli@latest
dsh-cc
```

正式版（`vX.Y.Z`）发布到 npm 的 `latest` dist-tag；候选版（`vX.Y.Z-rc.N`）发布到 `next`，不会占用 `latest`。要试用候选版，请运行 `npm install -g @dsh-cc/cli@next`。

升级后，启动器会在下次启动时更新 profile 中的 bundles，并将版本记录在 `~/.dsh/profiles/tui/.dsh-cc-bootstrap.json`。

如果更新失败，启动器会显示警告并使用当前 profile 启动，下次启动时重试。

网络错误和 npm/pnpm 的 minimum-release-age 限制可能延迟更新。由开发同步生成的 profile 使用开发恢复流程。

### 安装 profile

启动器会创建 `tui` profile。也可以用以下命令直接安装其 bundles。

```sh
dsh plugin --profile tui add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell \
  @dsh-cc/bundle-tui
dsh --profile tui
```

Web UI 使用以下命令。

```sh
dsh plugin --profile web add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell
dsh web
```

### dsh 版本兼容性

每个版本使用一个 dsh 版本进行 CI 验证，启动器也将该版本作为最低要求。

| dsh-cc 版本 | 已验证的 dsh |
| --- | --- |
| v0.8.3-rc.1 – v0.9.2 | 0.2.0-rc.2 |
| v0.8.2 | 0.1.7-rc.2 |
| v0.6.3 – v0.8.1 | 0.1.5-rc.1 |
| v0.6.0 – v0.6.2 | 0.1.2-rc.1 |
| v0.5.0 | 0.1.1-rc.2 (启动器未设置版本门禁) |

没有最高版本限制，但更高版本的 dsh 可能尚未验证。当 dsh-cc 提高最低要求时，请先升级 dsh。

这两个包独立发布，各自的 `@latest` 不一定构成已验证的版本组合。

维护者：请保持本表与 `.github/workflows/presubmit.yml` 的 `DSH_HARNESS_REF`、`packages/launcher/tui/bootstrap.mjs` 的 `MIN_DSH_VERSION` 一致。

### 可选官方插件

快速开始只需安装 bundles。`dsh-cc` 插件市场另提供五个可选的官方插件。

- **`dsh-cc-agents`** 提供三个子代理、五个 skill 和可选的 Serena hooks。
  - `critic` 使用 `opus` 做分析和评审。
  - `executor` 使用 `sonnet` 执行已明确的计划。
  - `marathon` 使用 `fable` 处理涉及大量文件的变更或需求未知的任务。
  - 五个 skill 分别是 `dsh-cc-agents-orchestration`、`data-analysis`、**`vwa-writing`**、**`formal-design`** 和 **`vwa-batch`**。
  - `formal-design` 在现有设计评审前检查有界 TLA+ 模型，并用 Lean 证明高影响的确定性规则。TLC 检查需要 Java >=17，固定版本 JAR 已随插件提供。Lean 检查需要单独配置的固定版本工具链，启动和检查过程都不会下载。安装插件不会启用项目级筛查；需[手动采用规则片段](packages/plugin/dsh-cc-agents/skills/formal-design/references/agents-snippet.md)，并在更新插件后重启。
- **`dsh-cc-writing`** 提供文章写作、文章评审和语言修改三个 skill，另有一个支撑流程 skill。
  - 三个公开 skill 支持中文和英文文章，覆盖三类文体。
  - 一次运行会在磁盘上保留 brief、plan、各阶段评审和保留性检查。
- **`dsh-cc-shunt`** 将批量读取和重复代码生成交给 worker 子代理。配置 `haiku` 可降低模型成本。
- **`cc-codex-bridge`** 通过 PreToolUse hook 放行一种指定形式的 Codex 命令。
- **`cc-grok-bridge`** 通过 PreToolUse hook 放行一种指定形式的 Grok 命令。

子代理使用完整作用域名称，例如 `dsh-cc-agents:critic`。桥接 hook 不会为每次符合规定的命令调用请求审批。

在会话内安装插件。

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-agents@dsh-cc
/plugin install dsh-cc-writing@dsh-cc
/plugin install dsh-cc-shunt@dsh-cc
```

安装会设置 `enabledPlugins`。重启 dsh 后加载新的 agents、skills 和 hooks。

更新已安装插件时，先更新插件市场，再更新插件缓存。

```text
/plugin marketplace update dsh-cc
/plugin update dsh-cc-agents@dsh-cc
```

仅更新插件市场不会更新已安装的插件。完成插件更新后请重启 dsh。

各插件的配置和限制见：[agents](packages/plugin/dsh-cc-agents/README.zh.md)、[writing](packages/plugin/dsh-cc-writing/README.zh.md)、[shunt](packages/plugin/dsh-cc-shunt/README.zh.md)、[Codex](packages/plugin/cc-codex-bridge/README.zh.md) 和 [Grok](packages/plugin/cc-grok-bridge/README.zh.md)。

## 用 VWA 写作与审查文档

默认 preset 仍为 CC。安装 `dsh-cc-agents` 不会自动切换到 VWA，也不会开启语义审查。

`vwa-writing` skill 可用于撰写新文章或审查已有文章，负责组织证据、主张、论证、审查和交付流程。

请使用包含第二层工具的 dsh-cc 构建。其他 Claude 兼容宿主可能能够加载 skill，但缺少所需工具。

1. 按上文安装或更新 `dsh-cc-agents`。
2. 将以下设置加入 `$DSH_HOME/settings.json`；默认目录为 `~/.dsh`。

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

3. 重启 dsh，加载已启用的工具。
4. 执行 `/preset vwa`。如果会话已锁定，请新建会话。
5. 在工作区执行一次 `/vwa init`。
6. 用 `/skills` 确认已加载 `vwa-writing`。

然后用自然语言要求 agent 使用该 skill，例如：

```text
请用 vwa-writing，依据 docs/sources/ 审查 docs/article.md，不要修改正文。
```

撰写新文章时，请给出研究问题、资料范围和输出路径。如果希望 agent 修正审查发现的问题，请授权修改正文。

skill 会先检查前置条件；设置不完整时，会一次列出用户需要完成的操作。

它不会修改全局设置，也不会代替用户执行专属命令。`/vwa sign` 和 `/vwa adjudicate` 仍由用户执行。

### 审查行为与限制

该流程会登记来源摘录、建立论证图、绑定当前正文，并用 `input.stage: "all"` 启动 `argument.review`。

agent 会等待任务结束后生成报告。获准修订的相关内容发生变化后，需要重新绑定并审查。

评级和交付状态由运行时决定，skill 或 critic 的意见不能代替这些检查。

只有正文和报告的准确路径都进入宿主展示事件，才可能达到 `delivered-reviewed` 状态。

等待中的任务、失败的检查或耗尽的预算都不能算审查通过，但仍可能交付未验证稿。

`review-alias` 选择模型别名，默认为 `sonnet`；未配置的内置别名可能继承主模型。

`semantic-mode` 设置新项目的初始模式标记，不会强制每次交付都通过审查。

项目审查额度在初始化时冻结，审查会增加模型调用、耗时和 token 用量。

语义审查仍处于实验阶段。60 例人工标注评估和真实模型验收尚未完成，评级不是事实正确性证书。

详见[插件指南](packages/plugin/dsh-cc-agents/README.zh.md#vwa-writing)和[验收记录](docs/vwa/lane2-validation.md)。

## 为什么使用 dsh-cc？

| 需求 | 能力 |
| --- | --- |
| 延续项目约定 | Agents、skills、记忆、settings、hooks 和命令 |
| 按任务选择模型 | 已配置的 provider/model 别名 |
| 分解大型任务 | 子代理、后台任务和已保存会话 |
| 控制变更 | 权限、审批规则、worktree 和工作区边界 |
| 按需发现工具 | ToolSearch 和 MCP 发现 |
| 切换交互界面 | 终端和 Web profile |
| 审查文档证据 | 可选的 VWA 运行时与 vwa-writing skill |

本项目使用 dsh-cc 开发自身；其模型路由属于用户配置，仅通过[模型别名](#模型别名)表达。

## 适用用户

- 使用 DeepSeek Harness 编程的开发者。
- 复用 `.claude/` agents、skills、hooks 和项目记忆的团队。
- 按任务选择不同模型的用户。
- 扩展 agent 运行时的插件作者。
- 需要为文档检查证据与论证的写作者。

## 兼容性概览

<!-- parity:matrix:start -->
| Category | Full | Partial | Missing | Non-goal |
| --- | --- | --- | --- | --- |
| Engine subsystems | 11 | 26 | 4 | 2 |
| Hook events | 10 | 7 | 4 | 0 |
| Command surface | 22 | 10 | 1 | 1 |
| Sessions and context | 0 | 2 | 1 | 0 |
| Memory and CLAUDE.md | 0 | 1 | 1 | 0 |
| Skills | 2 | 1 | 0 | 0 |
| Subagents | 0 | 4 | 0 | 0 |
| MCP | 2 | 1 | 0 | 0 |
| Plugins and marketplaces | 0 | 6 | 0 | 0 |
| Settings | 2 | 1 | 1 | 0 |
| Permissions | 0 | 1 | 0 | 0 |
| Models | 0 | 1 | 0 | 0 |
| Workspace | 0 | 4 | 0 | 0 |
| Interactive UX | 1 | 2 | 0 | 0 |

Statuses were verified against upstream documentation retrieved as of 2026-09-23 (freshness threshold: 120 days).

For the exact feature-by-feature status and known gaps, see the **[Claude Code parity matrix](docs/cc-parity-matrix.md)**.
<!-- parity:matrix:end -->

## Agent 工作流

### 子代理

CC preset 会发现 `.claude/agents` 中的项目 agent 定义，其 frontmatter 可指定模型别名。

```text
.claude/
  agents/
    reviewer.md
    debugger.md
```

### Skills

skill provider 会发现项目和已安装技能目录中的 `SKILL.md`，可用 `/skills` 查看生效的技能目录。

### 记忆

记忆包括 `CLAUDE.md` 上下文和独立写入通道。工作区记忆相互隔离，可选启用团队共享记忆。

当记忆索引压力增加时，后台整合流程会自动运行。

### MCP

MCP 客户端提供工具、资源、提示词和 OAuth 2.1 认证。用 `/mcp` 查看和管理连接。

#### 可选的 Serena 代码智能

配置 [Serena](https://github.com/oraios/serena) 服务器后，可增加符号工具和提示指导；`explore` 子代理会获得只读符号工具。

没有 Serena 时，agent 使用内置 Read/Grep 工具。需要符号工具时，请安装 Serena。

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

将服务器加入 `~/.dsh/.mcp.json` 或项目 `.mcp.json`。

```json
{
  "mcpServers": {
    "serena": {
      "command": "serena",
      "args": ["start-mcp-server", "--context", "claude-code", "--project-from-cwd"]
    }
  }
}
```

请使用已安装的二进制。通过 `uvx --from git+…` 启动会写入 `~/.cache/uv`，该写入会被会话沙箱拒绝。

用 `/doctor` 查看 `mcp.serena` 检查。

### Hooks

Hooks 可响应会话、提示词、工具、权限、上下文压缩、任务和子代理事件；可使用命令及 HTTP 执行器。

提示词和 agent 执行器需要开启相应配置，已实现的事件见[兼容矩阵](docs/cc-parity-matrix.md)。

CC preset 会从启动目录加载本仓库跟踪的 `hooks.json`，其中包含开发用 hooks。

可选的 `dsh-cc-agents` 插件包含 Serena hooks，前置条件见[本地开发](#本地开发)。

## 斜杠命令

CC preset 包含以下命令。用 `/help` 查看当前安装构建中的命令。

```text
/agents            manage continuable background agents
/auto-mode         inspect the auto permission mode (defaults, config, decision review)
/branch            worktree branch management
/commit-split      propose an atomic-commit split of the working tree (dry-run)
/compact           compact the session context
/config            inspect or change settings
/cost              token / cost information
/diff              inspect CLAUDE.md / settings differences
/doctor            session health report (--verbose / --json)
/export            write the session transcript to a file
/help              list commands or show one command's help
/init              scan a project and scaffold CLAUDE.md
/learn             distill recurring corrections into workspace memory
/mcp               manage MCP connections
/memory            inspect memories
/onboard           re-run the first-run setup (clears the onboarding opt-out)
/permissions       inspect or change permission mode/rules
/plugin            manage plugins
/provider          manage LLM providers (list/add/remove, rotate keys, set default)
/release-notes     show release notes
/rename            pin an explicit title on the current session
/resume            resume an interrupted session
/skills            list installed skills
/stats             session event-log stats (turns, tools, tokens)
/status            environment and session status
/tasks             inspect current tasks/jobs
/version           show version information
```

共享 preset 还包含 `/preset`，VWA preset 另外提供 `/vwa` 项目命令。

TUI 另有本地命令：`/model`、`/effort`、`/clear`（`/new`、`/reset`）、`/exit`（`/quit`）、`/usage`、`/export-md`、`/copy`、`/tui-help`。详见 [TUI 包](packages/ui/tui/README.zh.md#按键)。

TUI 还提供任务列表、审批、排队提示词、会话导出、用量显示和本地 shell 命令。

### 配置 provider

用 `/provider list` 查看路由，用 `/provider add <preset-id>` 添加 Moonshot、Z.AI/智谱、DeepSeek 或自定义端点。

provider 面板可更换密钥、刷新模型列表、选择默认值和移除路由。

请在掩码输入框中填写密钥。密钥保存在 `~/.dsh/.credentials.yaml`，不写入 settings。

环境变量提供的密钥在面板中为只读。凭证按请求解析，默认值变更对新会话生效。

用 `/model` 更改当前会话的模型路由。

### 首次启动

没有默认模型时，TUI 会打开 provider 面板。请选择 provider、输入密钥并设置默认模型。

Esc 仅跳过当前会话的设置，下次启动仍会出现该面板。

在用户设置中设定 `cc-onboarding.suppressed: true` 可关闭自动引导，用 `/onboard` 可再次启用。

非 TTY 运行不会打开面板，而是显示未配置模型的提示。

## 模型别名

agent 定义可选择一个别名。

```yaml
model: sonnet
```

配置的路由决定实际 provider 和模型。

```text
sonnet / draft      -> <provider>/<general coding model>
opus / blueprint    -> <provider>/<reasoning model>
haiku / sketch      -> <provider>/<fast model>
fable / masterplan  -> <provider>/<maximum-reasoning model>
architect           -> parent agent route (planning / orchestration)
gauge               -> typed-decision cheap lane (System One models; not generative)
inherit             -> parent agent route
```

别名属于配置，不绑定固定厂商。未配置的内置别名通常继承父路由。

## 产品边界

Claude Code 是独立产品；dsh-cc 将类似工作流加入 DeepSeek Harness 运行时。

模型路由器负责切换模型路由，本插件栈还增加 UI、命令、工具、记忆、子代理、hooks、权限、会话和 worktree。

大部分功能由外部插件提供，少数组件因所需扩展点仍为内部接口而包含上游源码副本。

## CC 模式

`tui` profile 的默认 preset 是 CC；dsh 内置的四种模式保持原有行为。

其他 profile 可通过 preset selector 选择 CC，或将其配置为默认值。

`/preset vwa` 可以改变后续新会话的已保存默认值；返回 CC 可使用 `/preset cc`。

终端 profile 默认全屏运行。单次使用普通界面模式，可执行以下命令。

```sh
DSH_CCTUI_UI_MODE=regular dsh --profile tui
```

## 配置

Profile 使用标准的 dsh 组合方式，本地 profile 覆盖项可放在以下文件中。

```text
~/.dsh/profiles/tui/cordis.patch.yml
```

覆盖项在已安装 bundles 之后应用。各包 README 说明设置优先级、模型路由、权限、hooks、记忆和 TUI 行为。

### 自定义状态栏

在 `tui` 中可用 shell 命令替换底部状态栏；配置可放在用户设置或项目 `.claude/settings.json` 中。

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

如果两个键同时存在，dsh 原生 `statusline` 的优先级高于兼容键 `statusLine`。

命令从 stdin 接收 JSON 会话数据，仅包含[状态栏契约](https://code.claude.com/docs/en/statusline)中当前可提供的字段。

stdout 的前三行成为状态栏，ANSI 转义序列保留。执行失败或输出为空时显示空行。

命令会在启动、恢复、新消息、模式变更、模型变更和每个刷新周期执行。

`refreshInterval` 的单位为秒，最小值为 1；环境中提供 `COLUMNS` 和 `LINES`。

设置修改无需重启即可生效，命令变化后会立即重新执行。三行输出限制与 Claude Code 不同。

## 已知限制

兼容目标是实现有用的功能，而非完整复制 Claude Code。部分 hook 事件、后台工作流、IDE 功能和厂商专有能力仍不完整。

当前状态见[兼容矩阵](docs/cc-parity-matrix.md)。

## 架构

包按职责分组。

```text
packages/
  settings/       settings cascade, migrations, namespaces
  interaction/    slash commands, permission rules, interaction plugins
  mcp/            MCP client and configuration
  hooks/          hook protocol and CC bridge
  core/           tool registry, ToolSearch, NotebookEdit, StructuredOutput, Sleep, workflow, web-fetch
  skill/          SKILL.md support
  preset/         CC agent preset and agent compatibility
  compat/         plugin loader and manager, model aliases, output styles
  memory/         CLAUDE.md memory and dream consolidation
  workspace/      worktree tool and session-cwd guard
  subagent/       coordinator, task tool, handoff store, resume pins
  compaction/     compaction tiers, cost gate, tool-use summaries
  session/        session commands (cost, export, stats, learn) and forensics
  context/        reversible tool-output compression (context-crusher) and post-compact progress rebuild
  llm-tuning/     reasoning-fold and side-query
  observability/  cache-health observer, config snapshot sidecar, shared sidecar IO
  plugin/         first-party plugins of the in-repo marketplace
  test-support/   shared test fixtures and eval harnesses (not published)
  bundle/         installable profile bundles
  ui/             terminal UI and the vendored pi-tui renderer
  launcher/       the dsh-cc executable
```

源码副本涉及工具注册表、MCP 客户端、hook 协议、Claude Code hook 桥接和 pi-tui 渲染器。

运行时包使用独立名称并保留服务接口。`check:vendor-purity` 门禁检查 pi-tui 的源码边界。

## 本地开发

按锁文件安装工作区依赖。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

### Serena hooks

官方 agents 插件包含 Serena 提醒和会话清理 hooks，前置条件见其 [README](packages/plugin/dsh-cc-agents/README.zh.md#serena-hooks)。

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

本仓库包含 `.serena/project.yml`。插件启用且 `serena-hooks` 位于 PATH 时，hooks 可以运行。

Hooks 使用 `SERENA_HOME=<repo>/.serena`，使其状态位于会话沙箱的写入边界内。

默认 home 可能不可写，且 Serena 可能不报告此错误。请勿将 `.serena/hook_data/` 加入版本控制。

所固定的安装版本还提供 `serena` 和 `serena-agent`。健康检查和索引使用一次性 uvx 命令。

这些命令见[代码智能健康检查](docs/code-intelligence-health.md)。

用以下命令在真实 profile 中测试未发布包。

```sh
pnpm run build
bash scripts/sync-local-profile.sh web
dsh web
```

开发同步后，`dsh-cc --version` 显示 `-dev+<commit>[.dirty]`；通过 npm 更新启动器会将 profile 恢复到已发布 bundles。

交付前运行生产启动检查。它使用临时 DSH_HOME 和伪终端，不调用模型。

```sh
pnpm smoke:profile-boot
```

Bundles 已包含 `@dsh-cc/preset-cc`，无需单独安装 CC preset。依赖规则和离线开发见[开发说明](docs/dev.md)。

## 包与发布

已发布包使用 `@dsh-cc` npm scope。根包为私有包，可安装包通过仓库发布工具发布。

参见[发布流程](docs/release.md)。

## 项目状态

上游变化可能影响本项目的接口和兼容性，可用兼容矩阵查看已实现功能和已知缺口。

英文文档请遵循 [ASD-STE100 写作规范](docs/i18n/ste100.md)，并保持每份中文 README 与英文版本语义一致。

欢迎提供复现步骤、`/doctor --json` 输出、带测试的针对性修复、扩展提案和真实项目示例。

[提交 issue](https://github.com/dsh-cc/dsh-cc/issues) · [查看 PR](https://github.com/dsh-cc/dsh-cc/pulls)

## 许可证

[Apache-2.0](LICENSE)
