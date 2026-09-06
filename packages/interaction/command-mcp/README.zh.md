# @dsh-cc/command-mcp

[English](README.md) | 中文

面向用户的 `/mcp` 命令：列出已注册的 MCP 服务器及其连接状态，或按名称重连/断开某个服务器。它读取并驱动由 mcp-client 实例挂载的可选 `mcpConnections` 服务。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/mcp` | 列出每个已注册服务器的名称、连接状态、工具数量（若已知）与 OAuth 鉴权要求。 |
| `/mcp reconnect <name>` | 断开并为命名服务器建立全新连接。 |
| `/mcp disconnect <name>` | 为该命名服务器停止连接并注销其工具。 |
| `/mcp <其他内容>` | 打印用法文本。 |

所有形式都读取/驱动可选的 `mcpConnections` 衔接服务。未含 mcp-client 的组合会优雅地报告缺少该服务。任何形式都不消耗模型 token。

## 组合

生产方注入 `commands`。自定义应用会挂载 mcp-client（提供衔接服务）与此插件：

```yaml
- id: mcp-client
  name: '@dsh-cc/mcp-client'
- id: command-mcp
  name: '@dsh-cc/command-mcp'
```

`mcpConnections` 衔接服务在运行时经 `ctx` 发现，并非注入项，因此即便缺少 mcp-client，命令也能加载（此时会报告缺少该服务）。

## 模型体验

斜杠输入与直接输出都不会进入模型请求，也不消耗模型 token。输出都是对连接注册表的读取/驱动；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **发送/断开语义由 mcp-client 持有**：该命令只是把 `reconnect`/`disconnect` 转发给衔接服务，无法配置 OAuth 或调整传输设置。
- **状态是快照**：条目反映最近一次上报的生命周期转换；瞬时的 `connecting` 状态可能在途中呈现。
