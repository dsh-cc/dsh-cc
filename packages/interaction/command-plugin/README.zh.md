# @dsh-cc/command-plugin

[English](README.md) | 中文

面向用户的 `/plugin` 与 `/reload-plugins` 命令：列出已挂载的 Claude Code 插件（名称、插件根目录与各组件加载计数），并对磁盘上的发现根目录进行重新扫描以热重挂载。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册两个全局命令，因此每个已组合的命令适配器都能发现并执行它们，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/plugin` | 列出每个已挂载插件的清单名称、插件根目录与各组件计数（`commands: N`、`agents: N`、`skills: N`……），并标注非零的 skipped/failed 组件。 |
| `/reload-plugins` | 按逆序释放所有已跟踪的挂载，重新运行发现并重挂载；报告最新挂载列表并附带各个根目录的失败信息。 |

两者读取由 cc-shell-glue 挂载的可选 `ccPlugins` 服务。未含 glue 的组合会优雅地报告缺少该衔接服务，而不是报错。两个命令都不消耗模型 token。

## 组合

生产方注入 `commands`。自定义应用会挂载 glue 与此插件：

```yaml
- id: cc-shell-glue
  name: '@dsh-cc/bundle-shell'
- id: command-plugin
  name: '@dsh-cc/command-plugin'
```

`ccPlugins` 衔接服务在运行时经 `ctx` 发现，并非注入项，因此即便缺少 glue，命令也能加载（此时会报告缺少该衔接服务）。

## 模型体验

斜杠输入与直接输出都不会进入模型请求，也不消耗模型 token。输出都是对已挂载插件注册表的纯读取；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **插件挂载内部逻辑由 glue 持有**：该命令只能枚举/重扫 `ccPlugins` 已跟踪的内容，无法挂载被发现步骤跳过的插件根目录。
- **无逐组件详情**：报告是计数，并在 loader 提供原因时附带原因；逐字组件正文不在范围内。
