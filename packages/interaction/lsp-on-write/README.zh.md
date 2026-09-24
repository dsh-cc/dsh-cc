# @dsh-cc/lsp-on-write

English | [中文](README.zh.md)

（中文说明，与英文版实质等价。）

LSP 诊断随写入返回：在 `edit`/`write`/`NotebookEdit` 成功之后，插件通过 `mcpConnections` 注册表（一次未缓存的 `tools/call`）从**正在运行的 serena 语言服务器**拉取被编辑文件的当前诊断，并把紧凑的 `[lsp]` 块**追加**到**同一条**工具结果上——模型立即看到"argument of type X is not assignable"，下一步即自我纠正，而不用等到测试时才发现。**默认关闭**（`cc-lsp-on-write.enabled: false`，需主动开启）。

## 工作方式

插件注册一个 `tools/post-execute` 监听器（普通插件，无 Service、无 isolate key），监听器注册时**不带 prepend**，因此组合在 context-crusher 的最外层 post-execute 监听器之内。每次接受编辑类工具结果时，监听器重新读取用户层原始配置文件（热加载，仅几 KB），若已启用则每次编辑只发起**一次** MCP 调用（`get_diagnostics_for_file`，路径按会话 cwd 计算相对路径），经由 `mcpConnections` 注册表——绝不经过工具瀑布，因此没有递归、也没有权限门控往返。任何失败（服务器不存在、超出 `timeout-ms` 预算的超时、MCP 错误、响应结构漂移）都降级为带调试计数的静默丢弃；追加块最多 `max-diagnostics` 条目、4 KB 上限，带可对账的 `… (N more)` 后缀。同一服务器连续 3 次丢弃后，监听器在本会话内自动停用（一条调试日志）。

诊断来自 serena 的 `get_diagnostics_for_file`，它按需查询其语言服务器。已知限制：serena 以自己的项目根解析 `relative_path`，该根通常等于会话 cwd；若两者不同，调用返回空或被丢弃。

## 配置（仅用户层）

用户层 `settings.json`（harness-home 文件）中的 `cc-lsp-on-write` 键。**永不读取**项目作用域。

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，**需主动开启**（默认暗发布）。 |
| `server-name` | `serena` | 要调用的 MCP 连接名；serena 挂载改名后诊断为零（一次惰性警告）。 |
| `timeout-ms` | `1500` | 每次调用的硬延迟预算；超时即丢弃，绝不会让工具结果失败。 |
| `max-diagnostics` | `8` | 渲染条目上限（错误在前，警告在后）。 |
| `min-severity` | `warning` | `warning` = 错误 + 警告；`error` = 仅错误。 |
| `tool-names` | （内置） | 可选覆盖，整体替换匹配的工具集合（`edit`、`write`、`NotebookEdit`）。 |

## 形态

普通 cordis 插件（无 Service、无 isolate key）。由 `packages/preset/cc` 在 cc-services 组内挂载，位于 edit-recovery-hint 之后。全部失败路径软降级为透传——用户的工具结果绝不会变成错误。
