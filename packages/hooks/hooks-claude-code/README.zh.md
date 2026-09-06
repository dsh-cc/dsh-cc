# @dsh-cc/hooks-claude-code

[English](README.md) | 中文

一个 Cordis 插件，在 harness 的规范拦截点上运行用户现有 **Claude Code** hook 配置（`hooks.json` 或 settings 文件的 `hooks` key）中受支持的 command hook 子集。它是 hooks 子系统的 **CC 方言**部分，负责桥接中 CC 格式的逐事件 stdin payload、CC 的 env 和 `${CLAUDE_PLUGIN_ROOT}`／`${CLAUDE_PROJECT_DIR}` 替换，以及将 hook 的中性结果映射为 harness 的类型化 Decision。方言无关原语（matcher、退出码／stdout codec、`ctx.shell` 执行、最严格合并、`hook/*` 事件）来自 [`@dsh-cc/hook-protocol`](../hook-protocol/README.md)。

原生 Cordis 插件可以完成此桥接的所有工作，功能更强，且具有类型化返回，没有序列化边界。**该桥接只是已映射 CC command hook 子集的兼容路径**；所有定制行为都应当使用相同扩展点上的原生插件（见 [拦截扩展点 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)）。

## 配置

```ts
import type { Config } from '@dsh-cc/hooks-claude-code'
const config: Config = {
  configPath: '/path/to/hooks.json', // required: a hooks.json or a settings file with a `hooks` key
  pluginRoot: '/path/to/plugin',     // optional: replaces ${CLAUDE_PLUGIN_ROOT} in command strings
  projectDir: '/path/to/project',    // optional: replaces ${CLAUDE_PROJECT_DIR} AND sets the hook env var; defaults to the session cwd when omitted
  defaultTimeoutMs: 600_000,         // optional: per-hook timeout when a hook sets none (CC default)
  stderrSummaryMaxChars: 500,        // optional: char cap on the hook/result event's persisted stderr summary
  enablePromptHooks: false,          // optional: run `prompt` hooks by forking a small-model subagent (default off)
  enableAgentHooks: false,           // optional: run `agent` hooks by forking a verification subagent (default off)
}
```

在 `cordis.yml` 中：

```yaml
- dsh-hooks-claude-code:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

配置只在加载时解析**一次**。`configPath` 是**进程级**配置：相对路径在加载时根据进程启动 cwd 解析，因此一份配置应用于整个进程。尚未进行每会话（`session/new.cwd`）配置发现（`TODO(per-session-hook-config)`）。读取／解析失败会被隔离处理，其中包括实际消费 matcher 的事件所带的无效 matcher 正则（会报告其 pattern 与事件）：桥接记录警告且不注册任何内容，而不是使启动崩溃（路径拼写错误不应使 agent（智能体）停止）。`command`、`http`、`prompt`、`agent` 四种执行器都会运行（后两者仅在对应开关开启时运行，见下）；未知 handler `type` 会被跳过并记录警告。没有每 hook `timeout` 的 hook 会使用协议参考默认值 `DEFAULT_HOOK_TIMEOUT_MS`（来自 `dsh-hook-protocol`，10 分钟，即 CC 默认值；`prompt`／`agent` hook 的每 hook `timeout` 不会应用到 fork —— 由父操作 signal 管控）。

hook **本身**会在 agent 的会话工作区中运行：对 agent scope 点，桥接会将会话 `cwd`（`session/new.cwd`）作为 hook 进程工作目录，因此 hook 的 `pwd`／相对路径／marker 作用于用户项目树，而非服务器启动目录。

## Hook 点 → 类型化 Decision

| CC hook | Harness 点 | 映射 |
|---|---|---|
| `SessionStart` | `agent/session-start`（emit） | additionalContext → `agent.inject()` 到新会话（无法阻塞） |
| `UserPromptSubmit` | `agent/pre-step`（waterfall（瀑布式事件）） | `deny` → `PreStepDecision.reject`；仅 additionalContext → 通过 `next()` 委托，再向下游 `enter` 决策追加一条单独标记来源的消息（后续外层 listener 仍可 reject／改写） |
| `PreToolUse` | `tools/pre-execute`（waterfall） | `deny` → `PreToolDecision.deny`；`ask` → `PreToolDecision.ask` |
| `PostToolUse` | `tools/post-execute`（waterfall） | `deny` → 带反馈的 `block`；仅 additionalContext → 通过 `next()` 委托，再将一个单独标记源的上下文前置到下游决策；Code Mode 将子调用上下文延迟到外层 `run_code` 结果 |
| `PostToolUseFailure` | `tools/post-execute` 且结果为 `isError`（emit） | 只观测；工具结果为错误时触发，与同一调用上的 `PostToolUse` 互斥；payload 携带 `tool_name`／`tool_input`／`tool_use_id` + 展平的 `error` 文本 |
| `Stop` | `agent/turn-stopping`（serial） | 阻塞 Stop hook 通过 `steer()` 送入其原因，强制再执行一步 |
| `SubagentStart` | `subagent/start`（emit） | additionalContext → `agent.inject()` 到仍在运行的同进程 child；远程 child 没有本地注入目标 |
| `SubagentStop` | `subagent/end`（emit） | 只观测 |
| `PermissionRequest` | `approval/request`（waterfall（瀑布式事件）） | `deny` → 拒绝审批；`allow`/`approve` → 预审批（`allowed-once`）；无决策 → 委托给应答者链 |
| `PermissionDenied` | `session/event` 观测 `approval/decided {outcome:'rejected'}`（emit） | 只观测 |
| `Notification` | `session/event` 观测 `approval/asked`（emit） | **部分支持**：仅 `permission_prompt` 子类型触发；payload 携带 `notification_type: 'permission_prompt'` |
| `PostCompact` | `session/event` 观测 `compaction/end`（emit） | 只观测 |
| `SessionEnd` | `session/disposed`（emit） | 只观测；`reason` 恒为 `'other'`（该 seam 无法推导） |
| `StopFailure` | `agent/error`（emit） | 只观测；将错误映射到 CC 错误码词汇（`rate_limit`、`authentication_failed`、`billing_error`、`invalid_request`、`server_error`、`max_output_tokens`，否则 `unknown`） |
| `TaskCreated` | `ctx.jobs` 变更 diff（emit） | 桥接对 `list()` 快照做 diff，对每个新出现的 job id 触发一次（无主或变更 owner scope 的 job） |
| `TeammateIdle` | `agent/status` → `idle`（emit） | 只观测；仅对被视为 subagent 的 agent 触发（根 agent 的 idle 不触发） |
| `Setup` | `agent/session-start` `source:'startup'`（emit） | **部分的一键近似**：仅对全新（seeded）会话触发，payload 为 `source:'init'`；resume/clear/compact 源不触发 |
| `SessionResume` | `agent/session-start` `source:'resume'`（emit） | 只观测；仅在 `resume` 源触发 —— `clear`／`compact` 在 dsh 无 emit 点，`UserPromptCancel` 在 dsh 无 seam（均暂缓） |

以上 emit 点都以分离方式运行：没有扩展点会等待这些 hook；`PermissionRequest` 是其中唯一的拦截点，并同步返回其决策。每条运行链都会被跟踪；对桥接执行 dispose（资源释放）时，会中止仍在运行的 hook 进程，并在 dispose 完成前排空 continuation（`createDetachedRuns`，位于 `dsh-hook-protocol`）。

matcher subject 是工具名称（`PreToolUse`／`PostToolUse`）、会话源（`SessionStart`），或常量 `agent_type`，其值为 `general-purpose`（`SubagentStart`／`SubagentStop`）。harness subagent seam 不携带每 kind label，因此桥接报告 Claude Code 自身 Task 工具默认值；默认／`*`／空 `agent_type` matcher 会触发，特定 kind matcher 不会触发。`UserPromptSubmit`／`Stop` 忽略 matcher。一个点上文件配置的多个 hook 会**按配置顺序串行运行**，并按最严格方式折叠（`deny > ask > allow`，见 `dsh-hook-protocol`）。串行使每个 hook 的 `hook/invoked`／`hook/result` 对在日志中相邻，权限决策的折叠结果与顺序无关（见 Agent Note 的「run serially, not concurrently」说明）。

每个 agent scope stdin payload 都携带 `session_id` 与字符串形式的 `transcript_path`。可用时，桥接通过 `ctx.sessionPersistence.locate(session.header)` 解析后者，否则发送 `''`。查找不会创建或 flush 产物，因此第一个轮次结束检查点之前路径可能不存在，也可能省略当前开启轮次。

## 上下文源

注入上下文携带显式 `{ kind: 'plugin', plugin: 'hooks-claude-code' }` 来源，因此持久消息绝不会被误认为用户提示词。

## 模型体验

### Hook 提供的上下文

#### 模型看到的内容

`SessionStart`、已接受提示词、工具后和实时同进程 subagent-start hook 可以添加带源归因的上下文消息；阻塞 `Stop` hook 将原因添加为下一步 steering（中途引导）。远程 child 注入没有本地目标。

#### Token 影响

hook 不返回上下文时没有成本。Hook 文本取决于数据，会被记录，并在后续会话请求中重发，直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已阻塞提示词或工具结果

#### 模型看到的内容

提供方提供的原因逐字传递。缺失原因时，已阻塞提示词精确使用 `blocked by UserPromptSubmit hook`，已拒绝工具变为 `Error: blocked by PreToolUse hook`，已阻塞工具后反馈精确为 `blocked by PostToolUse hook`，阻塞 stop 则精确添加 steering `continue: blocked by Stop hook`。`systemMessage` 会作为持久的暗色 notice 行呈现在会话 transcript 中（对模型可见 —— 见下方已知限制）；`updatedInput` 会被记录 + 警告但不应用（仍暂缓）。

#### Token 影响

阻塞提示词不会产生该提示词对应的模型请求 token；拒绝或反馈会添加保留的回退或提供方文本；强制 continuation 需要另一个完整请求。

#### KV Cache 影响

已阻塞提示词不发送请求，不会导致失效。拒绝、反馈与强制 continuation 上下文会追加在可复用前缀之后，不改写前缀。

## 已知限制与暂缓事项

- **已支持的 hook 事件（18 项）：** `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`SubagentStart`、`SubagentStop`、`PermissionRequest`、`PermissionDenied`、`Notification`（部分 —— 仅 `permission_prompt` 子类型）、`PostCompact`、`SessionEnd`、`StopFailure`、`TaskCreated`、`TeammateIdle`、`Setup`（部分 —— 一键近似）、`SessionResume`（部分 —— 仅 `resume` 源）。**不支持（14 项）：** `PreCompact`（需要上游 `compaction/start` seam）、`InstructionsLoaded`、`UserPromptExpansion`、`MessageDisplay`、`PostToolBatch`、`TaskCompleted`、`ConfigChange`、`CwdChanged`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove`、`Elicitation`、`ElicitationResult`、`UserPromptCancel`（dsh 无取消 seam —— 桥接不做有损近似）；另有 `Notification` 的 `idle`／`auth_success`／`elicitation` 子类型（headless 无法映射）以及 `SessionResume` 的 `clear`／`compact` 源（dsh 无 emit 点）。这些事件的配置会在配置组解析前被忽略，因此不支持的事件既不会使配置失效，也不会注册 hook。比较基线是 Claude Code [官方 hook 事件参考](https://code.claude.com/docs/en/hooks#hook-events)。
- **`SessionStart` 只支持部分功能：** 会消费 JSON `additionalContext`，但不支持纯 stdout 上下文、`initialUserMessage`、`sessionTitle`、`watchPaths`、`reloadSkills` 与 `CLAUDE_ENV_FILE`。hook 脱离运行，因此上下文可能错过第一个请求（`TODO(session-start-gating)`），payload 会省略 `model`、`agent_type` 和 `session_title` 等当前可选字段。
- **`UserPromptSubmit` 只支持部分功能：** 支持阻塞与 JSON `additionalContext`，但不支持纯 stdout 上下文、`sessionTitle` 和 `suppressOriginalPrompt`。除非被覆盖，否则桥接还会使用自身 600 秒默认值，而非 Claude Code 的事件特定 30 秒 command 超时。
- **`PreToolUse` 决策：** `deny`、`ask`、`allow` 均可用 —— `allow` 会预审批该调用（跳过权限提示）；下游边界 deny 仍然优先于 hook `allow`（并把同一次调用上的 hook `ask` 变为 deny），运行时完整性守卫仍会复核被 `allow` 的调用。不支持 `defer`。`additionalContext` 会作为 post-result 上下文注入，从下一次模型请求起可见（CC 将其附加到工具调用本身 —— 已接受的顺序差异）；`deny` 则携带 hook 原因。`updatedInput` 会被记录 + 警告但不应用（见 [pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)）。
- **`PostToolUse`：** 阻塞反馈、JSON `additionalContext`，以及 `updatedToolOutput`／`updatedMCPToolOutput` 均可用。替换是内容投影：只替换工具结果面向模型的文本（`{ kind:'accept', content:[{type:'text', text}] }`），保留规范值，仅当下游决策是无自身内容的纯 accept 时才应用（下游／边界优先），且 `block` 决策优先于替换。`updatedMCPToolOutput` 仅适用于 `mcp__*` 工具名；字段不匹配时被忽略。非文本工具内容（如图片）在替换时会展平为文本，hook payload 中的 `tool_response` 也会展平为文本。
- **`SubagentStart` 与 `SubagentStop` 只支持部分功能：** 两者均报告常量 `agent_type`，其值为 `general-purpose`，并在 Claude Code 报告父会话的位置使用 child 会话 id。Start 上下文是尽力而为，且只能到达仍在运行的同进程 child；stop 只观测，无法阻塞 subagent 或向其提供上下文。Start 省略 `transcript_path`；stop 还省略 `agent_transcript_path`、`last_assistant_message`、`background_tasks` 和 `session_crons`，并始终报告 `stop_hook_active: false`。
- **`Stop` 只支持部分功能：** 阻塞会强制另一个模型轮次，连续阻塞上限为 8（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可覆盖；`0`／非法值回退为 8）—— 超过上限后 hook 被覆盖、轮次结束，并将该覆盖记录为 `stop-cap` 诊断。`stop_hook_active` 在 agent 已因 Stop hook 而 continuation 时为 `true`。会省略 `last_assistant_message`、`background_tasks` 和 `session_crons`。
- **通用 payload 与输出字段只支持部分功能：** 已映射事件会省略 Claude Code 原本会提供的 `prompt_id`、`transcript_path`、`permission_mode` 和 `effort`。`systemMessage` 会作为持久的暗色 notice 行呈现 —— 相比 CC 的仅用户可见消息存在降级：notice 行对模型可见（会进入会话历史），但其 plugin source 保证它们不会出现在用户行中、也不会重置 stop-block 计数器；空／纯空白消息会渲染 `(<point> hook message)` 回退标签。`{"continue": false}` 会通过 `agent.cancel({kind:'hook'})` 停止运行 —— 任何排队或 steering 输入都会被丢弃（在停止 notice 中注明）；在脱离 emit 点上（无运行中的轮次），停止只是记录日志的 no-op。不会应用 `suppressOutput` 和 `terminalSequence`；`stopReason` 仅出现在停止 notice 中。
- **Handler 与配置只支持部分功能：** 运行 shell 形式 command handler，并运行 `http` handler（带 `allowedHttpHookUrls` + 拦截 header `allowedEnvVars`）。`prompt`／`agent` handler 仅在 `enablePromptHooks`／`enableAgentHooks` 开启时运行（否则跳过并警告）；未知 handler `type` 被跳过并警告。不遵循 `args`、`async`、`asyncRewake`、`shell`、`if`、`once` 和 `statusMessage` 等 command handler 选项；`prompt`／`agent` 的 `model` 覆盖经 `ccModelRoutes` alias 服务解析后映射到 fork 的 `agentOptions`（未写 `model` → 默认走 `resolve('haiku')` 低价车道；不可解析 → 继承父路由），每 hook `timeout` 不会应用到 fork。 在 cc preset 中，本插件行位于 `cc-services` isolate group 内，fork 的模型解析才能看见 `ccModelRoutes`。匹配 handler 串行运行且不去重，而 Claude Code 会并行运行并对相同 handler 去重。一个进程级 `configPath` 会在加载时解析一次；尚未实现 Claude Code 的分层项目、用户、插件与策略发现和实时重新加载（`TODO(per-session-hook-config)`）。
- **Hook 诊断：** `timeout`、`exit-code`、`parse-failure`、`spawn-failure`、`stop-cap`、`config` 等类别的 hook 问题会以 JSON 行追加到 `<dsh home>/hooks/diagnostics.jsonl`，并可在 `/doctor` 中查看（最近 10 条加上全部已记录问题的计数）。该文件是尽力而为的共享日志：跨进程并发追加可能交错，所有文件系统错误都会被吞掉（诊断绝不破坏 hook 运行），读取方会跳过残缺／非法行，日志超过 256 KB 时会压缩并保留最新 100 条有效记录。
