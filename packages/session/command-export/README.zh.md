# @dsh-cc/command-export

[English](README.md) | 中文

面向用户的 `/export` 命令，通过 [`ctx.fs`](../../fs/fs/README.md) 把当前会话 transcript 写入文件，格式为 markdown（默认）或无损 JSON。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/export` | 将会话的 markdown transcript 写入 `<defaultDir>/transcript-<sessionId>.md`，并报告写入路径与字节数。 |
| `/export json` | 改为写入无损 JSON transcript（原始事件日志）。 |
| `/export [json] <path>` | 写入 `<path>`（结尾 `/` 或裸文件名会解析到默认目录；识别 `.md`／`.json` 后缀，否则自动追加）。 |

markdown transcript 会把每个对模型可见的事件（用户、助手、工具结果）渲染为一个小节；没有任何会话事件的会话会导出一个声明性的文档。JSON transcript 是原始持久事件日志，因此命令生命周期（及其他）记录会与对话事件一起按原样出现。

## 配置

插件 `Config` 承载默认导出目录：

```yaml
- id: command-export
  name: '@dsh-cc/command-export'
  config:
    defaultDir: ./exports
```

未提供显式路径时，transcript 会写入 `defaultDir` 下；显式路径会覆盖它。

## 组合

生产方注入 `commands` 与 `fs`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: fs
  name: '@deepseek-ai/dsh-fs-local'
- id: command-export
  name: '@dsh-cc/command-export'
```

## 模型体验

斜杠输入、文件写入与直接的成功／错误输出都不会进入模型请求，也不消耗模型 token。渲染是会话日志的纯函数；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **不创建归档目录**：目标目录必须已存在；文件系统接缝不做 mkdir。
- **仅纯文本输出**：HTML、PDF 或脱敏后的精简 transcript 仍属于未来工作。
