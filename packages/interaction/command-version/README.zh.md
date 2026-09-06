# @dsh-cc/command-version

[English](README.md) | 中文

面向用户的 `/version` 命令：打印插件包的版本，并在宿主暴露时打印 harness 版本。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/version` | 打印 `@dsh-cc/plugins <版本>`，并在宿主暴露时附加 `harness <版本>` 行。无需网络。 |

内置版本在调用时读取本包 `package.json`（带编译期兜底），因此确定且离线安全。harness 行仅在存在兼容的宿主值时出现。

## 组合

该插件注入 `commands`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-version
  name: '@dsh-cc/command-version'
```

## 模型体验

斜杠输入与输出不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **harness 版本是可选的** —— 该行仅在宿主暴露版本时出现；不暴露版本的宿主仍会打印插件包行。
