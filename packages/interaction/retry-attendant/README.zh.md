# @dsh-cc/retry-attendant

[English](README.md) | 中文

重试前置校验随从（verify-before-retry attendant）：一个可选的 post-execute 监听器，针对结果含糊的**变更类工具调用**（超时、沙箱拒绝、部分写入、git/包管理变更失败）。做两件事（设计文档 [docs/plans/2026-10-09-verify-before-retry.md](../../../docs/plans/2026-10-09-verify-before-retry.md)）：

- **M1 — 含糊结果指引**：命中分类时，以 `additionalContexts` 条目（source kind `retry-attendant`）追加一行按类别的建议：“重跑之前先核实预期后置条件”。
- **M2 — 相同重试升级**：按会话记录调用效果的摘要；`expire-minutes` 内相同效果的重试（忽略改写过的 `description`/`timeoutMs`）被升级为权限**询问**而非直接放行。

**默认关闭**（`retry-attendant.enabled: false`，先内部试用）。

## 设置（仅用户层）

用户层 `settings.json` 中的 `retry-attendant` 键：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，**需主动开启**。 |
| `guidance` | 启用时为 `true` | M1 建议行。 |
| `escalate` | 启用时为 `true` | M2 相同重试询问。 |
| `expire-minutes` | `10` | 摘要表过期时间。 |

## 状态

已完整实现：失败分类表（`data/classes.json` + `classify`）、效果字段摘要投影、pre-execute 相同重试升级与 M1/M2 接线均已落地，组合位置由 `packages/preset/cc` 钉死。特性默认关闭，待 dogfood（设计文档 §5）；可用 `escalate` 键调节拦截/只观察档。
