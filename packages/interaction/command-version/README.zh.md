# @dsh-cc/command-version

[English](README.md) | 中文

面向用户的 `/version` 命令：打印插件包的版本，并在宿主暴露时打印 harness 版本。该插件通过 `ctx.commands` 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/version` | 打印 `@dsh-cc/plugins <版本>`，并在宿主暴露时附加 `harness <版本>` 行。无需网络。 |

内置版本在运行时由 `@dsh-cc/version-info` 的 `readOwnVersion` 读取。该辅助函数读取 version-info 自身的 `package.json`，其中承载各发布包共用的发布列车版本，并在清单缺失或不可读时返回编译期兜底常量。该读取确定且离线安全。harness 行仅在存在兼容的宿主值时出现。

## 组合

该插件注入 `commands`。自定义应用会挂载它们的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-version
  name: '@dsh-cc/command-version'
```

版本读取委托给 `@dsh-cc/version-info` 依赖完成；本包不读取任何自身的清单文件。

## 模型体验

斜杠输入与输出不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **harness 版本是可选的** —— 该行仅在宿主暴露版本时出现；不暴露版本的宿主仍会打印插件包行。
