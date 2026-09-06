# @dsh-cc/command-help

[English](README.md) | 中文

面向用户的 `/help` 命令：列出每个已注册的斜杠命令，或显示某个命名命令的详情（含输入提示）。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/help` | 按名称排序列出每个已注册命令，格式为 `/name — description`。 |
| `/help <cmd>` | 显示单个命令的详情（名称、描述与声明了时的输入提示）。未知命令会给出友好提示。 |

命令详情来自命令注册表本身；只显示当前组合中已注册的命令。

## 组合

该插件注入 `commands`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-help
  name: '@dsh-cc/command-help'
```

## 模型体验

斜杠输入与输出不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **注册表范围视图** —— 只列出当前组合中注册的命令；在其它 agent 作用域下挂载的命令不会被显示。
