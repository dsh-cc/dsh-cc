# @dsh-cc/command-preset

中文 | [English](README.md)

面向用户的 `/preset` 命令，操作 agent-preset 注册表：列出部署的预设清单，并可通过 `/preset <id>` 切换当前会话和/或持久化的默认预设。插件通过 `ctx.commands` 注册一个全局命令，因此每个已组合的命令适配器无需消耗模型回合即可发现并执行它。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/preset` | 以展示文本打印清单：每个预设的 id、名称、顺序、描述和可用性；当前默认项带标记。 |
| `/preset <id>` | 切换事务（固定顺序）：对照清单校验 id；通过注册表的 `select` 尝试为零回合会话热切换；通过 settings provider 写入 `vwa-preset.selectedDefault`；仅在成功的动作分支之后，向模型注入以 `command-preset` 为来源的公告。 |
| `/preset help` | 渲染命令帮助及其参数提示。 |

### 部分成功三态

- 完全成功：会话已切换且默认项已写入。
- 锁定降级：会话已经启动（`agent-preset/locked`），因此只改变默认项——这不是错误。
- 设置写入失败：热切换（如有）保持生效，但新会话的热激活未达成（NOT achieved）；结果文本会说明失败原因和手动回退方式（在用户设置中设置 `vwa-preset.selectedDefault`）。

## 设置命名空间

`vwa-preset`，唯一键 `selectedDefault`（缺省时回退到部署默认值 `cc`）。命名空间在挂载时通过共享的 `registerNamespaceSafe` 助手注册；写入使用 settings provider 的 `update` 语义。

## 装配

agent-preset 注册表在 apply 时通过 `ctx.get('agentPresets')` 读取，缺失时大声抛错——刻意不用 `inject` 声明，否则会在预设作用域内重新组合注册表（cordis 陷阱）。命令行由 `packages/preset/cc/agent.cordis.yml` 和 `agent.vwa.cordis.yml` 共同挂载。
