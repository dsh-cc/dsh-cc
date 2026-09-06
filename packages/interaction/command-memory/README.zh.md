# @dsh-cc/command-memory

[English](README.md) | 中文

面向用户的 `/memory` 命令：列出 memdir 记忆文件（名称、类型、首行），或按名称打印单个记忆的正文，通过 `ctx.fs` 读取。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/memory` | 列出每个主题，格式为 `- name (type) — 首行`，按名称排序，并附记忆目录头。 |
| `/memory <name>` | 按 frontmatter `name` 或文件名打印单个记忆的元信息与完整正文。未知名称会给出友好提示。 |

除非通过 `memoryHome` 显式配置，否则读取默认记忆主目录；在未设置覆盖且可发现项目根时，使用项目级 `.claude/memory` 覆盖层。完全只读。

## 组合

该插件注入 `commands` 与 `fs`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-memory
  name: '@dsh-cc/command-memory'
```

文件系统服务提供 `fs` 接口。可通过 `memoryHome` 配置指向显式目录。

## 模型体验

斜杠输入与输出不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **目录解析** —— 仅在未显式配置 `memoryHome` 且可发现 `.git` 根时，才使用项目覆盖层。
