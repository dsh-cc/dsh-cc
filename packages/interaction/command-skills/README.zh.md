# @dsh-cc/command-skills

[English](README.md) | 中文

面向用户的 `/skills` 命令：列出每个可用技能及其描述、来源与调用策略（可由模型、用户或两者调用）。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/skills` | 列出每个技能，格式为 `name — description (source: <来源>, invocable by: <模型和/或用户>)`，按名称排序。没有技能时显示占位提示。 |

目录反映的是已组合的各个技能提供方；它只是对 `ctx.skills.list()` 的一次读取，不会加载任何技能正文。

## 组合

该插件注入 `commands` 与 `skills`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: skills
  name: '@deepseek-ai/dsh-skill'
- id: command-skills
  name: '@dsh-cc/command-skills'
```

## 模型体验

斜杠输入与输出不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **提供方目录视图** —— 只有在组合了技能提供方且其返回技能时才显示；本命令不加载任何正文。
