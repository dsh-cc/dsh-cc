# @dsh-cc/subagent-resume-pins

[English](README.md) | 中文

面向可续接的后台子代理的固定恢复描述符（"resume pins"）。
设计记录：`docs/plans/2026-09-04-subagent-resume-pins.md`。

对后台子代理的冷恢复（父会话已销毁，随后新 Context 在同一持久化根上启动，并以
`send_message` 寻址该子代理）会恢复 harness 描述符的头部——persona、工具过滤、模型路由——
但会丢弃其余所有 spawn 时的 `AgentOptions` 字段，尤其是别名盖戳的
`reasoningEffort` 和 `maxTokens`。本包弥补这一缺口：spawn 路径把子代理生效的运行时
配置钉存到磁盘，恢复路径再重新应用——显式可见，绝不静默。

## 挂载内容

一个 cordis 插件（`apply`），包含：

- 一个 **`PinStore`**（`pinsRoot` 下每个子代理一个原子化的 `<childId>.json` 文件），
  以 `resumePinStore` 服务发布，使 Task 插件的 spawn 捕获与门和 overlay 共享同一缓存；
- 一个针对 `send_message` 到无存活 Activation 的钉存子代理的 **`tools/pre-execute`
  恢复门**：会话存在性（`PIN_ORPHANED`）、pin 可读性（`PIN_UNREADABLE`）、
  workspace 存在性/一致性（`WORKSPACE_MISSING`、`WORKSPACE_CHANGED`）、定义重指纹
  （`DEFINITION_CHANGED`）、钉存工具可用性（`PINNED_TOOL_UNAVAILABLE`）、钉存路由
  可用性（`SUBAGENT_MODEL_UNAVAILABLE`）——每次拒绝都会**在**拒绝返回**之前**持久化进
  pin（`resume.state='blocked'`）；
- 一个 **`agent/request` overlay**，把钉存的
  `{provider, model, reasoningEffort, maxTokens}` 元组逐字段（含缺席）应用到
  每个恢复的轮次，无论由谁恢复；
- **`tools/post-execute`** 在 `send_message` 上加通知前缀，并在 `list_agents` 上
  附注 `resumeState`/`definitionChanged`；
- **`subagents-resume` 设置 namespace**（kebab-case），提供策略开关
  `onUnavailableModel`、`onDefinitionChanged`、`onWorkspaceChanged`
  （默认 `resume-with-notice`，可选 `block`，模型路由的兜底为 `route-current`；
  always-block 条件没有安全回退）。

未挂载时零开销：pin 只是不被读取，行为与旧版一致。只有钉存过的子代理受影响；
缺 pin 即旧版/外来子代理（直接放行），发往存活 Activation 的同 epoch steer 投递不受影响。

## 组合

cc 预设挂载该插件（`cc-resume-pins`，位于 `cc-services` isolate 组内），并传
`pinsRoot: !!js dshHomePath('sessions', 'resume-pins')`——与 harness 基础补丁的
jsonl 会话持久化根同址——且挂载于 `tool-task` **之前**，后者的 spawn 捕获优先取共享的
服务级 store。独立使用方可改为向 Task 插件配置传 `resumePins: { pinsRoot }`。
