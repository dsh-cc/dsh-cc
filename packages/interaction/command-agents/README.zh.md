# @dsh-cc/command-agents

[English](README.md) | 中文

面向可延续后台代理的、供人类使用的 `/agents` 命令（计划
`docs/plans/2026-09-05-continuable-background-ux.md` §3.2，Slice 0 MVP）。

## Surface

- `/agents` — 分组列表（Working / Idle / Ready；仅按驻留状态分组，没有
  Blocked/Done 组），由标签渲染的行，包含固定（pin）状态及 gate 拒绝码。
- `/agents <id>` — 轻量详情：pin 来源（路径、定义、模型选择器、工作区、
  gate 评估结果）、驻留状态、ids。
- `/agents stop <id>` — 对运行中的子代理发送一次中断请求（子代理仍可
  延续/恢复）；否则给出简短的无操作说明。
- `/agents attach <id>` — 命名空间已保留，尚未实现（P1）。

## Shared snapshot

`src/snapshot.ts` 是一个基于注入服务的纯快照提供者
（宿主平面的 `subagents.listChildren`、注册表的 `agents.get`、realm 内部的
`resumePinStore`）。该插件挂载在 `cc-services` realm 内部，并把只读的
`ccAgents` 服务发布到 ROOT 上下文（CcPlugins 模式），因此 TUI 的本地斜杠
命令路径消费的是同一份快照。预设 surface 只渲染轻量详情；TUI 以增量方式
叠加由折叠派生的装饰（provider/model、prompt 摘录、最后一次 stopReason）——
这一差异是有意为之，并已在 capability manifest 中记录。
