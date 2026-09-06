# @dsh-cc/command-mcp

English | [中文](README.zh.md)

Human-facing `/mcp` command: list the registered MCP servers and their connection state, or reconnect/disconnect one by name. It reads and drives the optional `mcpConnections` service that an mcp-client instance mounts. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md).

## Command contract

| Input | Result |
|---|---|
| `/mcp` | List each registered server's name, connection state, tool count (when known), and OAuth-auth requirement. |
| `/mcp reconnect <name>` | Tear down and establish a fresh connection for the named server. |
| `/mcp disconnect <name>` | Stop the connection and unregister its tools for the named server. |
| `/mcp <anything else>` | Print usage text. |

All forms read/drive the optional `mcpConnections` seam. A composition without an mcp-client reports the seam gracefully. No form consumes model tokens.

## Composition

The producer injects `commands`. A custom app mounts mcp-client (which provides the seam) plus this plugin:

```yaml
- id: mcp-client
  name: '@dsh-cc/mcp-client'
- id: command-mcp
  name: '@dsh-cc/command-mcp'
```

The `mcpConnections` seam is discovered via `ctx` at run time; it is not injected, so the command loads even when mcp-client is absent (and then reports the missing seam).

## Model Experience

The slash input and the direct outputs are absent from model requests and consume no model tokens. Outputs are reads/drives over the connection registry; presentation text is never logged.

## Known Limitations and Deferred Work

- **Send/disconnect semantics are mcp-client-owned** — the command forwards `reconnect`/`disconnect` to the seam; it cannot configure OAuth or tune transport settings.
- **State is a snapshot** — entries reflect the last reported lifecycle transition; transient `connecting` states may render mid-flight.
