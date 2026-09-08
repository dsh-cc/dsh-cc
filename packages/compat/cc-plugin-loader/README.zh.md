# @dsh-cc/plugin-loader

[English](README.md) | 中文

加载 Claude Code 插件的 `plugin.json` 清单，并把每个组件挂载为内存中的 dsh 插件。

这个兼容性加载器读取 CC 插件清单子集，用 [`@dsh-cc/skill-loader`](../../skill/skill-claude-code/README.md) 与 [`@dsh-cc/claude-code-agents`](../../preset/claude-code-agents/README.md) 的纯函数翻译每个组件，并通过 `ctx.get(...)` 读取该组件的宿主 seam。它不是运行时：它产出类型化挂载与结构化报告，把执行交给它注册到的 seam。

## 发现

`discoverCcPluginRoots({ pluginDirs?, claudeHome?, dshHome?, cwd? })` 是 glue 的磁盘查找器：

| `pluginDirs` | 行为 |
|---|---|
| `undefined`（默认） | `enabledPlugins`（claude-user → dsh-user → project → local 级联，后者按 key 覆盖）与两个 home 合并后的 `installed_plugins.json` 的交集。key 必须是精确的 `name@marketplace`。Claude home 为 `$CLAUDE_CONFIG_DIR`（否则 `~/.claude`）；dsh home 为显式 `dshHome` → 显式 `claudeHome`（旧版单根）→ `$DSH_HOME`（否则 `~/.dsh`）。 |
| `[]` 或 `null` | 空——关闭发现。 |
| 非空 | flatten 这些目录：目录自身或其一层子目录持有 `.claude-plugin/plugin.json` 或顶层 `plugin.json`。仅有 marketplace.json 的目录不是 flatten root。 |

JSON 读失败与缺失的 `installPath` 会跳过而不是抛错。项目/local `enabledPlugins` 偏向 boot cwd（host-plane 单例）；`/reload-plugins` 会重读级联。

### 双 home 状态（兼容读 `~/.claude`，写入 `~/.dsh`）

插件状态是双 home 的：Claude home（`$CLAUDE_CONFIG_DIR` / `~/.claude`）保持完全**可读**以兼容 Claude Code，而 dsh home（`$DSH_HOME` / `~/.dsh`）是**写入根**。两个 home 同时携带状态时，合并按 key 进行、dsh 优先：dsh 的 `enabledPlugins` 条目遮蔽 claude 条目（dsh 级联层位于 claude-user 与 project 层之间），dsh 的 `installed_plugins.json` 条目列表——包括空列表——遮蔽该插件 id 的 claude 列表。值得知道的后果：

- 分叉是单向的：dsh-cc 能看到两个 home，真正的 Claude Code 只看得到自己的。
- **接管陈旧性：** 一旦 dsh-cc 把某个 id 写进 dsh 的 `installed_plugins.json`，之后 claude 侧对该 id 的改动对 dsh-cc 不可见（dsh 已接管该 id）。
- 只传 **`claudeHome`**（不传 `dshHome`）的调用方保持旧版单根行为：该目录既是读根也是写根。

## 加载器

`mountCcPlugin(ctx, { root, nameHint?, seams? })` 解析清单、校验子集，并把每个存在的组件作为 Cordis effect 挂载。它返回 `{ report, dispose }`——`report` 是每个组件的加载结果，`dispose` 回收所有已挂载组件（context 卸载时自动调用）。

清单解析顺序：

1. `${root}/.claude-plugin/plugin.json`（Claude Code 首选路径）
2. `${root}/plugin.json`（旧路径 / 显式 `pluginDirs` fixture）
3. `${root}/.claude-plugin/marketplace.json` 命中 `nameHint`——合成 overlay 并**替换**默认 `skills/` 扫描。marketplace 文件未命中 `nameHint` 是硬失败（绝不落到 synthesize）。
4. 否则合成 `{ name: nameHint ?? basename(root) }`，让可选清单仍能挂默认目录。

当清单省略 `commands` 时，加载器扫描 `commands/*.md`。嵌套命令目录会带原因跳过。已声明的 `commands` 仍替换默认目录。

### 清单子集

加载器校验 `name`（必填、kebab-case）、`version`、`description`、`author`，以及组件字段 `commands`、`agents`、`skills`、`hooks`、`mcpServers`、`settings`。格式错误的清单会在加载时携带插件名抛错。未知的顶层字段被忽略，与 Claude Code 的宽容处理一致。

### 组件及其 seam

每个组件都是 peer 风格：加载器通过 `ctx.get(...)` 探测宿主 seam，当该 seam 缺失时把组件报告为 `skipped`（绝不让整个加载失败）。

| 组件 | 来源 | Seam（探测） | 翻译 |
|---|---|---|---|
| `commands` | 清单内联/source，或默认 `commands/*.md` | `commands` | 通过 `register` 注册每个斜杠命令；handler 返回命令内容 |
| `agents` | `agents/` 目录或清单路径 | `subagents` | 通过 `loadAgentsDir` 加载 `AgentDefinition`，再通过 `registerProvider` 注册为命名 provider——以插件名做命名空间（`namespacePrefix: manifest.name`），因此 `provider.name` 是 scoped id `plugin:agent`，而 `provider.definition.agentType` 保持裸名；provider 还会暴露其 `definition`，供 Task 工具实时枚举。**不带** `namespacePrefix` 挂载则保持裸名——这些 agent 随后**对 Task 工具不可见**（一种向后兼容的逃生舱口，不是受支持的派发模式） |
| `skills` | `skills/` 目录或清单路径 | `skills` | 通过 `discoverCcSkills` 发现 `SKILL.md`、解析 frontmatter，再通过 `register` 注册为运行时技能 |
| `hooks` | `hooks/hooks.json` 或内联 | `hooks`（guest）| 通过 `mergePluginHooks` 注入按事件组织的 hook 映射 |
| `mcpServers` | 内联记录或 `.mcp.json` | `mcp`（guest）| 通过 `registerServer` 注册每个 server（工具命名是 seam 的职责）|
| `settings` | 清单记录 | `settings`（guest）| 过滤到 allowlist（当前是 `agent`）后通过 `set` 写入 |

`hooks` 与 `mcp` seam 在本包内没有 harness 自有的服务；希望挂载这些组件的部署应提供 guest seam，否则它们会被报告为 `skipped`。dsh 的宿主接线现已提供 `mcp` seam：cc-shell glue 内置提供 `mcp` seam（`cc-shell/src/mcpSeam.ts`，即 `cc-mcp-seam` 子插件），因此在发布的部署中插件的 `mcpServers` 会真正挂载（见 docs/plans/2026-09-07-plugin-mcp-seam.md）。`hooks` 仍依赖宿主提供。

## 技能语义接线

在技能挂载之上，本包是把 `skill-claude-code` 的 metadata 转成可执行注册的 consumer：

- **`allowed-tools`** —— `skillToolRestriction(metadata)` 构建仅允许的 `tools.restrict()` 过滤器；`applySkillRestriction(metadata, agent)` 把它应用到 scoped agent 并返回 disposer。
- **`context: fork`** —— `resolveSkillExecution(metadata, subagentsPresent)` 把技能路由到子代理执行；当 subagent seam 缺失时降级为内联并被报告。
- **`paths`** —— `registerSkillPathActivator(ctx, skill, projectRoot)` 挂上用于条件激活的 `fs/observed` 路径激活器。
- **内联 shell** —— `activationFor(metadata, subagentsPresent)` 报告 `forbidInlineShell`（`shell: false` 的技能不得开启内联 shell）。

## 已知限制与待办工作

- **harness 中的 guest seam** —— 除非部署提供 guest seam，否则 `hooks`、`settings` 会报告为 `skipped`；当前没有 harness 自有的 `ctx.hooks` 服务。`mcp` seam 现由 cc-shell glue 提供（见上文），插件的 `mcpServers` 可挂载；tally 统计的是注册时加载，被配置跳过的 server（如未设置的 env 变量）只会通过日志 warn 呈现。
- **agent provider 转发执行** —— agents provider 以名字命名其后端（默认 `fork`）并委托 `start`；执行 CC agent 需要 subagent seam 在运行时存在 `fork` 后端。
- **技能激活由宿主驱动** —— 加载器注册接线与激活描述符；在模型可见的时刻应用它们由宿主负责。
- **Agents 把默认 `agents/` 目录加到清单路径上** —— Claude Code 在声明 `agents` 时替换默认目录。此处未改。
- **skills-directory 插件、managed settings、`defaultEnabled`，以及遍历 `cache/`/`marketplaces/` 均不在范围内。**
