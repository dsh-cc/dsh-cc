# @dsh-cc/command-tasks

[English](README.md) | 中文

面向用户的 `/tasks` 命令：列出当前调用方可见的后台任务及其状态。它读取注入的 `jobs` 服务。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/tasks` | 列出每个调用方可见任务的 id（`<kind>-N`）、类型、生命周期状态、开始时间与生产者标签。可见集合为空时渲染一个友好的占位提示。 |

该命令注入 `commands` 与 `jobs`，因此需要运行后台任务的组合。任何形式都不消耗模型 token。

## 组合

生产方注入 `commands` 与 `jobs`。自定义应用会挂载任务注册表（例如 `@deepseek-ai/dsh-jobs-local`）与此插件：

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: command-tasks
  name: '@dsh-cc/command-tasks'
```

## 模型体验

斜杠输入与直接输出都不会进入模型请求，也不消耗模型 token。输出都是对 jobs 服务的纯读取；呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **Todo 不在范围内**：该命令只渲染后台任务；todo 类条目存在于后台任务注册表之外，被有意不予以呈现。
- **只读**：该命令仅列出任务；取消经由任务控制器（`kill`）完成，此处未接入。
