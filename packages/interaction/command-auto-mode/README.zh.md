# @dsh-cc/command-auto-mode

[English](README.md) | 中文

面向用户的 `/auto-mode` 命令：`auto` 模式 LLM 风险分类器配置的检查入口。该插件通过 [`ctx.commands`](../../commands/README.md) 注册一个全局命令，所有已组合的命令适配器无需模型回合即可发现并执行它。回答时不发起模型调用、不消耗 token。

分类器的策略面是 `permissions.autoMode` 设置节，包含三个槽位列表——`soft_deny`、`allow`（例外）和 `environment`（信任边界）。每个列表都支持字面量 `"$defaults"` 条目，在消费时按位置原样展开。设置级联组装 `autoMode` 键时只使用受信任的层（用户层、`--settings` 旗标、托管策略）——project 和 local（随仓库携带）层对该键一律忽略，因此克隆来的仓库永远无法替分类器划定它自己的信任边界。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/auto-mode defaults` | 以 JSON 打印内置槽位列表（仅 `$defaults` 展开后的内置项），键为 `soft_deny`、`allow`、`environment`。 |
| `/auto-mode config` | 打印 permission-rules 引擎所见的有效 `permissions.autoMode` 切片：受信任范围的取值、每个槽位列表的展开结果（`configured` 与 `expanded`；`configured: null` 表示采用内置默认）、解析后的 classifier 子配置，以及 `classifyAllShell` 标志。 |
| `/auto-mode help` | 渲染含子命令行的命令帮助。 |

未知子命令报用法错误。所有源自设置文本的输出都经过控制字符消毒器（C0（换行/制表符除外）、DEL、C1），设置携带的文本无法把终端转义序列走私进会话记录。

## 配置

本命令没有自己的 `Config`；它读取实时设置节。请通过设置文件的 `permissions.autoMode` 节（`soft_deny`、`allow`、`environment`、`classifyAllShell`、`classifier`）配置分类器——仅受信任层生效。
