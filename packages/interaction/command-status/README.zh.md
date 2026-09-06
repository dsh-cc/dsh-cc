# @dsh-cc/command-status

[English](README.md) | 中文

面向用户的 `/status` 命令：显示当前模型、权限 preset、会话 id 与工作目录的会话状态摘要。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/status` | 显示当前 `provider/model`（来自最新 `request/header`）、生效的权限 preset（挂载了权限服务时）、会话 id 与工作目录。在当前组合中来源缺失的条目行会被省略，而不是显示为空。 |

模型行读取会话的持久 `request/header` 日志；preset 行在存在时读取 [`ctx.permissionPresets`](../permission-presets/README.md)。两种来源都缺失的组合只会省略对应行。运行 `/status` 不消耗模型 token。

## 组合

生产方注入 `commands`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-status
  name: '@dsh-cc/command-status'
```

组合了权限 preset 栈时，其行会自动出现；否则省略。

## 模型体验

斜杠输入与直接的状态输出都不会进入模型请求，也不消耗模型 token。所有行都是对会话日志与已组合服务的纯读取；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **没有 MCP／hooks 挂载行**：该 harness 目前没有可枚举已挂载 hooks 或 MCP 服务器的运行时注册表；在出现此类注册表之前省略该行。
- **模型是最新记录的路由**：只有在首个 `request/header` 事件之后才直到 header；此前该行会被省略。
