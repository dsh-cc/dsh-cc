# @dsh-cc/command-branch

[English](README.md) | 中文

面向用户的 `/branch [note]` 命令：将当前会话 fork 成一个新的子分支，并报告子会话 id。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/branch` | Fork 调用方自身会话（至当前最后一条事件），并报告新的子会话 id 及进入指令。 |
| `/branch <note>` | 同上，并在此成功报告中回显该自由文本备注。 |

Fork 读取注入的会话仓库。缺少仓库的组合，或仓库拒绝的 fork（例如非 live 的源），会报告一个友好的错误而非失败。任何形式都不消耗模型 token。

## 组合

生产方注入 `commands`。自定义应用会挂载会话仓库与此插件：

```yaml
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: command-branch
  name: '@dsh-cc/command-branch'
```

会话仓库在运行时经 `ctx` 发现，并非注入项，因此即便没有仓库，命令也能加载（此时会报告缺少该服务）。

## 模型体验

斜杠输入与直接输出都不会进入模型请求，也不消耗模型 token。输出是对会话仓库的一次性 fork 驱动；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **Fork 边界为当前最后一条事件**：该命令不暴露 `boundary` 参数，因此总是 fork 到会话的最新事件为止。
- **备注不会被持久化**：可选备注会回显给用户，但本命令不会将其写入会话标题/日志（未接入轻量标题 API）。
- **切换由宿主持有**：与 `/resume` 类似，该命令会报告 `dsh --resume <childId>`，但不会切换实时进程。
