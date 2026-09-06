# @dsh-cc/permission-rules

[English](README.md) | 中文

Claude Code 兼容的权限规则引擎。解析 `ToolName` 与 `ToolName(content)` 规则，在 `tools/pre-execute` waterfall 上收敛出感知模式的判定，并通过单调的 `guard()` 层强制执行 bypass-immune 内容规则——任何模式切换或 `bypassPermissions` 都无法翻盘。规则在加载期 fail loud；settings 通过重建合并状态并重注册 guard 实现热更新。

## 规则语法

规则形如 `ToolName`（整工具）或 `ToolName(content)`（内容级）。`content` 可用反斜杠转义 `(`/`)`/`\`，可用 `*` 作为通配符，也可用 `:*` 结尾声明前缀规则。

| 规则 | 含义 |
|---|---|
| `Bash` | 覆盖所有 `Bash` 调用的整工具规则 |
| `Bash(npm install)` | 前缀规则：任何以 `npm install` 开头的命令 |
| `Bash(npm publish:*)` | 对主干 `npm publish:` 的前缀规则 |
| `Edit(foo/*.json)` | 通配符：匹配 `foo/*.json` 的命令/路径（`*` 匹配任意片段） |
| `Bash(python -c "print\(1\)")` | 内容中的字面括号 |

畸形规则（括号未闭合、结束括号后有内容、只有内容没有工具名）在加载期抛出 `TypeError`——fail loud。`escapeRuleContent`/`unescapeRuleContent` 可安全往返内容（先 `\`，再括号）。

## 评估顺序

插件注册一个 `tools/pre-execute` 监听器，为每次调用收敛一个判定：

1. **Bypass-immune** 内容规则（例如 `.git` 内部、shell 配置文件路径）始终 deny——注册为单调 **guard**，模式切换或 `bypassPermissions` 都不能覆盖。
2. **风险分类器**（`classifierEnabled` 开启时，默认开）：灾难性 shell 命令（`rm -rf /`、`sudo`、`dd of=/dev`、`kill -9 1`、将 curl/wget 管道接入 sh、重定向到系统路径）在所有模式下**硬 deny**；写入受保护文件（`.bashrc`、`.ssh/**`、凭据）同样硬 deny；写文件逃逸出工作目录作用域时在 `bypassPermissions` 之外 **ask**（在它之下放行）。
3. **整工具 deny** → deny。
4. **整工具 ask** → ask（当设置了 `exemptSandboxedBashFromToolAsk` 时，被沙箱限制的 `Bash` 豁免并直接 allow）。
5. **内容级 allow/deny/ask** 规则按来源优先级评估（最高优先级先；首个命中规则决定）。
6. **模式**短路：`bypassPermissions` 放行一切（除非 `disableBypassPermissionsMode`）；`acceptEdits` 自动放行文件编辑工具；`plan` 自动放行只读工具。`auto` 不是 evaluate 短路——它与 `default` 评估一致，审批由插件层的风险分类器代理。
7. **整工具 allow** 是该工具的粗略默认——没有更具体的规则命中时放行。
8. **无命中** → passthrough 给下游监听器（最终到审批缝），后者仍可能 `ask`。
9. **plan 收口**：非只读调用上残留的 `ask`/`passthrough` 变成 deny，理由是 `plan mode is read-only; submit via exit_plan_mode`。命中的 allow/deny 规则仍然生效。

## 配置

```ts
import PermissionRules from '@dsh-cc/permission-rules'

await ctx.plugin(PermissionRules, {
  rules: {
    deny: ['Bash(rm -rf)', 'Edit(.git*)'],
    bypassImmune: ['Edit(~/.bashrc)', 'Edit(~/.zshrc)'],
  },
  bashToolName: 'Bash',           // default
  fileEditTools: ['edit'],        // auto-allowed under acceptEdits
  readOnlyTools: ['read'],        // auto-allowed under plan
  exemptSandboxedBashFromToolAsk: false,
  defaultMode: 'default',
  classifierEnabled: true,        // 风险分类器升级阶段
})
```

所有字段可选；服务 schema 应用图示默认值。规则字符串以 `config` 来源解析。

## settings 与热更新

当 `ctx.settings` 挂载时，插件注册 `permissions` 命名空间（`permissions.allow` / `permissions.deny` / `permissions.ask` / `permissions.defaultMode`，另加供风险分类器使用的 `additionalDirectories` / `protectedFiles` / `dangerousPatterns`，以及可选的 `autoMode` 小节——`autoMode.soft_deny` 文字规则（支持 `$defaults` 展开）与 `autoMode.classifier`（`enabled` / `route` / `timeoutMs` / `cacheMaxEntries`）共同驱动 `auto` 模式下可选择性开启的 LLM 风险分类器阶段；`autoMode` 键缺席即保持缺席，该阶段保持解除武装）。settings 规则携带 `settingsSource` 标签（默认 `userSettings`），并按来源优先级与 Config `rules` 合并——settings 规则优先。存储变更会立即重跑合并并重注册 guard（热更新）；畸形 settings 规则在 settings 边界 fail loud。当 `ctx.settings` 缺席时，仅 Config `rules` 生效（分类器使用其精选默认值）。

## 来源与模式

每条规则携带 `PermissionRuleSource`（`session` > `cliArg` > `policySettings` > `flagSettings` > `localSettings` > `projectSettings` > `userSettings` > `config`），用于内容规则的优先级。引擎在调用时解析生效模式：plan 激活（来自 `@deepseek-ai/dsh-plan-mode`）最先覆盖，然后是会话记录的 `permission/mode` 覆盖（`foldPermissionMode`），否则回退到 `defaultMode`。

模式是**持久的**——`setMode(agent, mode)` 追加一条 last-wins 的 `permission/mode` 会话事件（插件加载时注册进 `KNOWN_SESSION_EVENT_TYPES`，持久化可恢复它）。`plan` 归 plan-mode 所有，在这里会抛错。进入 `bypassPermissions` 会把会话沙箱钉到 `danger-full-access` 并记录 `resumeSandbox`；离开时恢复记录（或回退 `workspace-write`）的约束。在 `auto` 下，风险分类器代理每次 `ask`：LOW 风险调用自动放行，MEDIUM 风险仍会询问。LLM 分类器阶段武装时，只读工具调用豁免——完全不经过模型（读流量零额外延迟）。判定解析保持严格并 fail-closed：模型输出畸形时返回常量原因 `classifier output unparseable`（模型输出永不展示；审计记录只含摘要）。按路由的连续失败熔断器（阈值 3，按 `provider/model` 键控）会为故障车道打开断路——该路由不再调用分类器，每进程一次 warn、每会话一条 `breaker` 审计事件；`rebuild()`（设置变更）重置熔断状态并重新武装。

## 切换模式

`permissionRules.setMode(agent, mode)` 持久切换（见上）；`/permissions <mode>` 命令（在 `@dsh-cc/command-permissions`）为 `default | acceptEdits | plan | auto | bypassPermissions` 驱动它。每次切换都会向会话的模型转录注入一条面向人的提示。

## 供宿主 UI 使用的纯导出

- `parseRuleString(rule)`、`parseRule(rule, behavior, source)`、`escapeRuleContent`/`unescapeRuleContent`——解析规则为 `PermissionRule`。
- `evaluatePermission(input)`——为一次调用收敛 `PermissionDecision`（`allow` / `deny` / `ask` / `passthrough`），给定工具、subject、规则集、模式与豁免标志。无需挂载插件即可预览某规则会命中什么。
- `mergeRuleSets(...sets)`——按来源优先级合并规则集。
- `foldPermissionMode(events)`、`foldResumeSandbox(events)`、`setPermissionMode(session, mode, resumeSandbox?)`——读写持久的 `permission/mode` 覆盖。`setPermissionMode` 拒绝 `plan` 与未知模式；其他插件可用 `foldPermissionMode` 折叠某会话的记录模式。
- `assessBashCommand(command, patterns?)`——对 shell 命令做风险分级（`LOW`/`HIGH`）。
- `assessFilePath(filePath, opts)`——对文件写入做风险分级（`LOW`/`MEDIUM`/`HIGH`）。
- `PERMISSION_MODES`、`SOURCE_PRIORITY`——封闭词汇表。

规则解析与评估是浏览器安全的（纯字符串逻辑），因此类型/解析/评估模块可干净地导入 UI 预览。

## Invariant 伴生插件

`@dsh-cc/permission-rules/invariant` 在会话边界校验 `permission/mode` 会话事件：`mode` 必须是可切换的（绝不能是 `plan`），且 `resumeSandbox`——若存在——必须是已知沙箱模式（`read-only` | `workspace-write` | `danger-full-access`）。

参见 [Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-cc-permission-rules.md)。
