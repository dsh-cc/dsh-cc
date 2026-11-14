# @dsh-cc/retry-attendant

[English](README.md) | 中文

重试前置校验随从（verify-before-retry attendant）：一个 post-execute 监听器，针对结果含糊的**变更类工具调用**（超时、沙箱拒绝、部分写入、git/包管理/MCP 变更失败）。做两件事（设计文档 [docs/plans/2026-10-09-verify-before-retry.md](../../../docs/plans/2026-10-09-verify-before-retry.md)）：

- **M1 — 含糊结果指引**：命中分类时，以 `additionalContexts` 条目（source kind `retry-attendant`）追加一行按类别的建议：“重跑之前先核实预期后置条件”。建议只在全新摘要时追加：会话中同一摘要仍有存活条目时会被去重，不再追加。
- **M2 — 相同重试升级**：按会话为每个已分类类别记录调用效果摘要，`mcp-mutation` 除外（该类别只有 M1，永不升级）；`expire-minutes` 内相同效果的重试（忽略改写过的 `description`/`timeoutMs`）被升级为权限**询问**，不再直接放行。指定的只读核验会把对应条目标记为已解决，并改写询问理由以指明该核验：`git status`/`log`/`diff`/`show` 解决待决的 `git-mutation` 条目，对已记录路径的 `read` 解决待决的 `write-partial` 条目。未挂载审批接缝时，升级标记会被释放，下游决定保持不变：下游的询问原样保留，放行或透传则变为放行并直接注入该类别指引。

**默认开启**（2026-10-16 起 `retry-attendant.enabled: true`；经生产 dogfood 由暗发布转正）。

## 设置（仅用户层）

用户层 `settings.json` 中的 `retry-attendant` 键：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（2026-10-16 起默认开）。 |
| `guidance` | `true` | M1 建议行。 |
| `escalate` | `true` | M2 相同重试询问。 |
| `expire-minutes` | `10` | 摘要表过期时间。 |

## 状态

已完整实现：失败分类表（`src/classes.json` + `classify`）、效果字段摘要投影、pre-execute 相同重试升级与 M1/M2 接线均已落地，组合位置由 `packages/preset/cc` 钉死。2026-10-16 生产 dogfood 通过设计文档 §5 门后转默认开启；可用 `escalate` 键调节拦截/只观察档。
