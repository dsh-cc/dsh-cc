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
  延续/恢复）；否则给出简短的无操作说明。已释放（或释放进行中）的子代理
  会以明确的"本会话内不可延续"文案拒绝，而不是可恢复的说法。
- `/agents release <id>` — 通过 harness 的 drain 缝隙逐出该子代理的常驻
  activation（连同其常驻后代）；当其为 running 时释放其容量槽位；驱逐是
  协作式的（一个拒绝取消的 turn 会保留其槽位，此时命令报告释放仍在进行）；
  本会话内单向不可逆（同会话延续不可用——上游 cold-resume-after-drain 缺口）；
  持久化的 session 保留在磁盘上。已释放的行在列表中渲染进程本地的
  `[released]` 标签，在详情中渲染一行 release 说明。
- `/agents attach <id>` — 命名空间已保留，尚未实现（P1）。

## Shared release core

`src/release.ts` 是由 `/agents release` 与面向模型的 `release_agent` 工具
（`@dsh-cc/subagent-task`）共享的唯一释放操作：一套 gate/drain/resolve/
reject/timeout 流程、一套文案，以及一个进程本地的双集合标记
（`releasing` / `released`），经 `@dsh-cc/command-agents/release` 入口导出。
只有当标记存在且该行的驻留状态为 `ready`（快照时刻注册表缺席）时，
`[released]` 标签才会渲染——绝不只凭标记。

## Shared snapshot

`src/snapshot.ts` 是一个基于注入服务的纯快照提供者
（宿主平面的 `subagents.listChildren`、注册表的 `agents.get`、realm 内部的
`resumePinStore`）。该插件挂载在 `cc-services` realm 内部，并把只读的
`ccAgents` 服务发布到 ROOT 上下文（CcPlugins 模式），因此 TUI 的本地斜杠
命令路径消费的是同一份快照。预设 surface 只渲染轻量详情；TUI 以增量方式
叠加由折叠派生的装饰（provider/model、prompt 摘录、最后一次 stopReason）——
这一差异是有意为之，并已在 capability manifest 中记录。
