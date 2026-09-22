# @dsh-cc/edit-recovery-hint

English | [中文](README.zh.md)

（中文说明，与英文版实质等价。）

编辑恢复提示：当 `edit` 工具因多行 `old_string` 未找到而失败时，插件向同一条工具结果以 `additionalContexts` 条目追加一条**固定、静态**的恢复建议消息——模型可见的旁路上下文（harness deferContext 循环在工具结果定稿后转发），不重写任何工具结果内容。**默认关闭**（`cc-edit-recovery-hint.enabled: false`，需主动开启）。

## 工作方式

插件注册一个 `tools/post-execute` 监听器（普通插件，无 Service、无 isolate key）。当编辑结果为错误时，监听器重新读取用户层原始配置文件（热加载，仅几 KB）；若失败的调用携带多行 `old_string` 且结果文本为未找到错误，则追加一条内容为常量 `RECOVERY_HINT` 的 `additionalContexts` 用户消息：改用单行锚点重试，或按 hunk 拆分为多次编辑；仅当锚点也失败时，才只读目标区域（offset/limit）。

提示文本**仅静态**——永不把工具输出、文件字节或参数片段插值进去，因此工具输出中的恶意负载无法操纵追加的消息。歧义失败（`old_string` 多次匹配）刻意不匹配：那里字符串其实匹配上了，锚点建议会误导。

## 配置（仅用户层）

用户层 `settings.json`（harness-home 文件）中的 `cc-edit-recovery-hint` 键。**永不读取**项目作用域——结构上不可见，并非"被拒绝"。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，**需主动开启**。 |

## 形态

普通 cordis 插件（无 Service、无 isolate key）。由 `packages/preset/cc` 挂载在 cc-services 组，紧跟 post-edit-verify 之后。全程 fail-soft：任何故障都退化为透传——用户的工具结果绝不会变成错误结果，决策内容也绝不被改动。
