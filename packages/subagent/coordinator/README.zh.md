# @dsh-cc/coordinator

[English](README.md) | 中文

协调模式是一种基于可继续子代理（continuable subagent）的、作用于单个 agent 作用域的编排角色：激活后，宿主 agent 不再直接修改工作区，而是把任务委派给有名字的后台 worker，并在它们之间路由消息。激活由部署开关控制——Config 的 `enabled` 或 `DSH_COORDINATOR_MODE` 环境变量——它作用于挂载本包的 agent 作用域，因此 preset 会[把该组合编排进会话](../preset/agent-presets/README.md)，并通过在 resume 时从固定的组合中重新挂载来保持该模式。

## 激活与工具限制

`apply(ctx, config)` 解析 `config.enabled ?? DSH_COORDINATOR_MODE`，未激活时不注册任何内容——preset 可以无条件挂载它。激活时需要 agent 作用域的上下文（它读取被挂载的 `agent`），因为工具限制是 agent 作用域操作；挂载到普通上下文会明确报错，而不是遮蔽所有 agent。随后它会安装以下内容（全部限定在该 agent 作用域）：

- 一个 `coordinator:mode` system-prompt 区段（`installCoordinatorMode` 的 `sectionOrder`，默认 prompt-order 110），说明编排职责、委派工具清单以及结果回流协议；
- 调度工具 `spawn_worker`、`send_to_worker`、`worker_broadcast` 和 `worker_tasks`；
- 通过 `ctx.tools.restrict()` 施加的[作用域工具限制](../../core/tools/README.md)，默认为 `{ deny: ['write', 'edit'] }`（Config `restrict` 可覆盖，也可改用 `allow` 掩码）。

释放插件 fiber 会一次性撤销全部注册，因此关闭协调模式即可恢复该 agent 的完整工具面。

## 委派面

调度工具是 subagent 服务之上的薄适配层，因此驻留、冷恢复和投递权限仍归服务所有：

- `spawn_worker(name, prompt)` 调用 `ctx.subagents.startContinuable()`，并把持久子 id 记录在给定名称之下。
- `send_to_worker(worker, message)` 解析名称（或持久 id），并通过 `ctx.subagents.followup()` 投递一条下一轮消息，其来源记为 `{ kind: 'coordinator', form: 'relay' }`。
- `worker_broadcast(message)` 把相同内容发送给每个已注册 worker。
- `worker_tasks()` 列出已注册 worker，并附带来自 Agent 注册表的实时状态。

未知的 worker 引用会得到出错结果；在无调用 agent 的情况下调用调度工具会明确失败。

## 结果回流与完成（复用既有协议）

协调模式不会重新实现 worker 到协调者的结果回流。worker 通过独立安装的 [`@deepseek-ai/dsh-tool-subagent-report`](../tool-subagent-report/README.md) 的 `report` 工具上报，subagent 服务会将其作为一条父级消息投递。当某 worker 结束（settle）时，subagent 服务的 continuation 结算已把它的 `subagent-settled` 通知作为唤醒消息注入协调者 agent 的会话（参见 [`dsh-subagent` continuation 结算投递](../subagent/README.md)）——这正是唤醒协调者循环的完成通知。本包记录这一复用而不是重复实现唤醒；其测试断言该通知确实到达协调者会话。

## 目录

`src/section.ts` 中的 Section 文本与常量；worker 记账、调度工具、激活开关与释放器均位于 `src/index.ts`。
