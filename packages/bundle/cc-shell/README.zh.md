# dsh-cc-bundle-shell

[English](README.md) | 中文

CC 壳层的 **host-plane infra** 组合包。本包承载真正属于宿主层的部件——带 deferred-name 支持的 tools 注册表替换、settings-migrations 机制——以及 `cc-shell-glue` 插件的*代码*(glue 代码仍住在这里,但挂载动作由 CC preset 执行,而非本包的 patch)。所有 agent-face 组合——tool-search、skill loader、memory、coordinator、worktree/sleep/notebook/structured-output 工具、19 个斜杠命令、hook 桥、output-style 渲染——都已迁至 [`@dsh-cc/preset-cc`](../../preset/cc/README.md) 组合包,以便按 preset 隔离,而不是泄漏进每个模式。

## 作用

- **tools 注册表替换。** 禁用 in-box 的 `tools` 行,重挂 `@dsh-cc/tools`。`reserve()`/`isAdmitted()` 加入可限制名 universe,权限门可在 deferred 工具加载前按名门控;其余行为与上游一致。基础行的 `DSH_TOOLS_MODE` 开关被延续($DSH_HOME / process.cwd() 语义不变)。
- **settings 迁移。** 挂载 `@dsh-cc/settings-migrations`,在启动时应用版本门控的 `settings.json` 迁移(等价于 CC 的 `runMigrations`)。当前为空注册表——仅机制。
- **glue 插件代码(由 CC preset 挂载)。** `cc-shell-glue` 挂载 cordis patch 行无法静态表达的部件:磁盘上的 Claude Code 插件、`.mcp.json` server 接线,以及内置的插件 `mcp` seam(`cc-mcp-seam`,使插件的 `mcpServers` 通过 mcp-client 真正挂载)。默认插件发现是双 home 合并视图:`enabledPlugins`(claude-user → dsh-user → project → local 级联)∩ 两个 home 合并后的 `installed_plugins.json`(精确 `name@marketplace` key,`installPath` 作为插件根)。**写入根是 dsh home**(`$DSH_HOME` / `~/.dsh`);Claude home(`$CLAUDE_CONFIG_DIR` / `~/.claude`)保持可读以兼容,dsh 条目按 key 优先。显式 `pluginDirs` 仍 flatten 这些目录;`[]`/`null` 关闭。发现为尽力而为——缺失路径与无法读取的 JSON 都不挂载。它还暴露 `ccPlugins` 服务,用于对已挂载插件做实时枚举/重扫(`/reload-plugins` 会重读级联),以及绑定两个 home 的 `ccPluginManager` 服务(`/plugin` 变更落在 `~/.dsh`)。glue 以 **惰性 trampoline** 基于 `ccModelRoutes` 服务把派发时的 `resolveModel` 接入 `AgentProvider`:`(model) => ctx.get('ccModelRoutes')?.resolve(model)`——每次派发查询,服务未挂载时降级为继承父路由。

### 从 glue 迁出的部分

两个原本住在 `cc-shell-glue` 里的部件迁到了各自的属主包:

- **`model-aliases` settings 命名空间注册** → `@dsh-cc/model-aliases` 的 `ccModelRoutes` 服务(`packages/compat/cc-model-aliases`)。glue 不再注册该命名空间(重复注册会 throw),只惰性消费服务。glue config 的 `Config.modelAliases` 已删除。
- **基础 CC-agent 发现**(`~/.claude/agents` + `<cwd>/.claude/agents` → subagent providers)→ `@dsh-cc/subagent-task` 的 Task 工具,它按**会话** cwd(而非宿主进程 cwd)发现。`Config.registerBaseAgents` 已删除。

## 已知限制 / 说明

- 本包不再全局挂载任何 agent-face 表面。只有 host-plane infra 行(tools 注册表替换 + settings-migrations)由本包的 `cordis.patch.yml` 挂载;glue 插件与所有 agent 表面由 `@dsh-cc/preset-cc` 挂载,从而限定在该 preset 内。
- 由于 tool-web executor 行在 rc.6 之前未被 CLI 依赖树携带,基于 fetch 的 web 工具由 preset 挂载而非此处;当前 fetch 状态见 preset 的「已知限制」。
- 项目/local `enabledPlugins` 偏向 boot cwd(glue 是 host-plane 单例,与 `.mcp.json` 相同)。`/reload-plugins` 是热更新出口。插件状态是双 home 的:`$CLAUDE_CONFIG_DIR` 保持可读供发现使用,而插件管理写入落在 `$DSH_HOME`(`~/.dsh`)——设置 `CLAUDE_CONFIG_DIR` 不再决定插件写入位置;`.mcp.json` 仍写死 `~/.claude`。
