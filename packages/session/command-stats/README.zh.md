# @dsh-cc/command-stats

[English](README.md) | 中文

面向用户的 `/stats` 命令，基于会话事件日志实现：turn 与 step 计数、工具调用分布、token 用量汇总。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/stats` | 显示已完成的 turn 数、已关闭的 step 数、对用户可见的 user 与 assistant 消息计数、按工具名分组（调用次数最多的在前）并带总计的工具调用，以及所有已记录 `assistant/message` usage 记录的 token 用量汇总（input／output／cache-read／cache-write）。没有任何活动的会话会直接说明。 |

计数与 token 汇总从会话持久事件日志中折叠得到；命令运行不消耗模型 token。

## 组合

生产方注入 `commands`。自定义应用会挂载它的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-stats
  name: '@dsh-cc/command-stats'
```

## 模型体验

斜杠输入与直接的统计数据输出都不会进入模型请求，也不消耗模型 token。折叠是会话日志的纯函数；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **仅整段日志总计**：按 turn 或按模型的细分仍属于未来工作。
- **原始计数，不含耗时**：LLM／工具的延迟数据位于 `sessionStats` projection 中，此处不做重复。
