# @dsh-cc/acp

English | [中文](README.zh.md)

Agent Client Protocol (ACP, v1) server that lets an ACP client (e.g. Zed) drive dsh-cc agents over JSON-RPC on stdio. This package is a verbatim vendor of `@deepseek-ai/dsh-acp` (`packages/acp/acp`, deepseek-harness, MIT — see `LICENSE-harness`), pinned at `2f97f60455605e915b8176d9170cae337bfedcc6` (@deepseek-ai/dsh-acp 0.2.2-rc.1); every ported file carries a provenance header and CC-specific divergences must be recorded in `DIVERGENCE.md`. The vendoring and extension plan is described in `docs/plans/2026-10-09-acp-m2-own-plugin.md`.

## Configuration

`Config` (`src/index.ts:105`) has four keys: `provider`, `model`, `presetId`, and `sessionListPageSize`.

| Key | Default | Meaning |
|---|---|---|
| `provider` | none | Provider route used for each agent the server creates. |
| `model` | none | Model name used for each agent the server creates. |
| `presetId` | `'cc'` | Agent preset composed into every fresh session. |
| `sessionListPageSize` | `100` | Maximum session summaries in one `session/list` page. |

The plugin's identity is `name = 'acp-cc'` with `inject = ['agents', 'llm', 'sessionPersistence', 'sessions']` (`src/index.ts:70,79`).

## Shipped features

- **MCP server passthrough.** `mountAcpMcpServers` (`src/mcp.ts`) turns a session's standard `mcpServers` declarations into Agent-scoped DSH MCP clients, supporting the stdio and HTTP transports and rejecting any other transport, a duplicate name, a relative stdio `command`, or a non-HTTP URL with `AcpMcpConfigError` before the agent is published.
- **Per-use preset roster resolution.** `presetRosterResolver` (`src/preset-roster.ts`) resolves the agent-preset roster at each use, behind a loader-settlement gate, so an asynchronously mounting registry is observed at its final state and a registry restart does not re-apply this plugin.
- **Model control.** `AcpModelControl` (`src/model-control.ts`) projects the session's provider/model selection and the provider's reasoning efforts onto ACP config options, and a client change applies from the agent's next model step.
- **Session-list paging.** `session/list` returns at most `sessionListPageSize` summaries per request with an opaque keyset `nextCursor`.
- **Committed-update projection.** `src/updates.ts` projects committed session events onto ACP updates, with assistant blocks becoming thought and message chunks plus an optional usage update, and one tool call becoming a `tool_call` then `tool_call_update` lifecycle.
