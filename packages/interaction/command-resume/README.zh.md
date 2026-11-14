# @dsh-cc/command-resume

[English](README.md) | 中文

面向用户的 `/resume` 命令：列出最近的会话（id、标题、工作目录、可用性状态与开始时间），以便用户挑选一个继续。它读取可选的 `sessionQuery` 服务。该插件通过 `ctx.commands` 注册一个全局命令。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/resume` | 按从新到旧列出最近的会话：会话 id、最新折叠标题（若日志中存在）、工作目录（若记录）、可选父会话、可用性状态（`available` 表示既在线又已持久化，`live`，`persisted`，`archived` 表示两者皆无）与创建时间。最后附带宿主持有的继续指针。 |

只渲染 `sessionQuery` API 实际暴露的字段；没有来源的字段会被省略。结果为空时渲染一个友好的占位提示。该命令读取可选的 `sessionQuery` 衔接服务——缺少它的组合会报告缺少该服务。

在开始标题处理之前，列表会先过滤掉临时的一次性子会话。该过滤读取可选的根域 `ccOneShotLedger` 服务，只有当会话带有父会话且账本把其 id 标记为一次性子会话时才丢弃该会话。缺少该服务的组合不做任何过滤，因此列出的每个会话都可继续。

## 组合

生产方注入 `commands`。自定义应用会挂载会话查询后端（例如 `@deepseek-ai/dsh-session-query-sqlite`）与此插件：

```yaml
- id: session-query
  name: '@deepseek-ai/dsh-session-query-sqlite'
- id: command-resume
  name: '@dsh-cc/command-resume'
```

`sessionQuery` 衔接服务在运行时经 `ctx` 发现，并非注入项，因此即便没有查询后端，命令也能加载（此时会报告缺少该服务）。

## 模型体验

斜杠输入与直接输出都不会进入模型请求，也不消耗模型 token。输出都是对会话语料的纯读取。

## 已知限制与暂缓事项

- **会话切换由宿主持有**：该命令只负责列出；要切换需要用户以 `dsh --resume <sessionId>` 重启。它无法切换实时进程。
- **没有 `lastActive` 字段**：`sessionQuery` API 暴露的是创建时间与可用性状态，而非最后活跃时间戳，因此不会渲染此类行。
- **一次性过滤存在残留问题**：账本行会在子会话结束后约五分钟被清理，因此长期结束的临时子会话可能重新出现在列表中。
