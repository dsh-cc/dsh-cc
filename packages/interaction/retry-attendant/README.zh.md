# @dsh-cc/retry-attendant

[English](README.md) | 中文

重试前置校验随从（verify-before-retry attendant）：一个可选的 post-execute 监听器，针对结果含糊的**变更类工具调用**（超时、沙箱拒绝、部分写入、git/包管理变更失败）。做两件事（设计文档 [docs/plans/2026-10-09-verify-before-retry.md](../../../docs/plans/2026-10-09-verify-before-retry.md)）：

- **M1 — 含糊结果指引**：命中分类时，以 `additionalContexts` 条目（source kind `retry-attendant`）追加一行按类别的建议——"重跑之前先核实预期后置条件"。
- **M2 — 相同重试升级**：按会话记录调用效果的摘要；`expireMinutes` 内相同效果的重试（忽略改写过的 `description`/`timeoutMs`）被升级为权限**询问**而非直接放行。

**默认关闭**（`retry-attendant.enabled: false`，先内部试用）。

## 设置（仅用户层）

用户层 `settings.json` 中的 `retry-attendant` 键：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，**需主动开启**。 |
| `guidance` | 启用时为 `true` | M1 建议行。 |
| `escalate` | 启用时为 `true` | M2 相同重试询问。 |
| `expireMinutes` | `10` | 摘要表过期时间。 |

## 状态

切片 1（检测核心）：失败分类表（`data/classes.json` + `classify`）、摘要投影（`digestKey`）、模块增强。监听器/接线属于后续切片。完整契约见设计文档。
