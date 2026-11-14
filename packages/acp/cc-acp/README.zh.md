# @dsh-cc/acp

[English](README.md) | 中文

Agent Client Protocol（ACP，v1）服务器，让 ACP 客户端（如 Zed）通过 stdio 上的 JSON-RPC 驱动 dsh-cc agent。本包是 `@deepseek-ai/dsh-acp`（deepseek-harness 的 `packages/acp/acp`，MIT — 见 `LICENSE-harness`）的逐字 vendor，固定于 `2f97f60455605e915b8176d9170cae337bfedcc6`（@deepseek-ai/dsh-acp 0.2.2-rc.1）；每个移植文件都带出处头，CC 侧的分歧必须记录在 `DIVERGENCE.md`。vendor 与扩展计划见 `docs/plans/2026-10-09-acp-m2-own-plugin.md`。

## 配置

`Config`（`src/index.ts:105`）有四个键：`provider`、`model`、`presetId`、`sessionListPageSize`。

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | 无 | 服务器为每个新建 agent 使用的 provider 路由。 |
| `model` | 无 | 服务器为每个新建 agent 使用的模型名。 |
| `presetId` | `'cc'` | 每个新会话都会合成的 agent preset。 |
| `sessionListPageSize` | `100` | 单次 `session/list` 分页返回的会话摘要上限。 |

插件的身份为 `name = 'acp-cc'`，`inject = ['agents', 'llm', 'sessionPersistence', 'sessions']`（`src/index.ts:70,79`）。

## 已交付特性

- **MCP server 透传。** `mountAcpMcpServers`（`src/mcp.ts`）把会话的标准 `mcpServers` 声明转为 Agent scope 的 DSH MCP 客户端，支持 stdio 与 HTTP 两种 transport；其它 transport、重名、相对的 stdio `command`、非 HTTP URL 都会在 agent 发布前以 `AcpMcpConfigError` 拒绝。
- **按使用解析 preset roster。** `presetRosterResolver`（`src/preset-roster.ts`）在每次使用时才解析 agent preset 注册表，并位于 loader 结算门之后，因此能观测到异步挂载的注册表的最终状态，注册表重启也不会重新 apply 本插件。
- **模型控制。** `AcpModelControl`（`src/model-control.ts`）把会话的 provider/model 选择与该 provider 的 reasoning effort 投影为 ACP config option，客户端改动从 agent 的下一次模型步生效。
- **会话列表分页。** `session/list` 每次请求最多返回 `sessionListPageSize` 条摘要，并带不透明的 keyset `nextCursor`。
- **已提交更新投影。** `src/updates.ts` 把已提交的会话事件投影为 ACP update：assistant block 变为 thought 与 message chunk（可附带一条 usage 更新），一次工具调用则变为 `tool_call` 到 `tool_call_update` 的生命周期。
