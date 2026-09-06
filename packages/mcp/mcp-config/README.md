# @dsh-cc/mcp-config

English | [中文](README.zh.md)

Claude Code-style MCP workspace-configuration loader: parses a `.mcp.json` document, validates it, expands environment substitutions, applies an enterprise allow/deny policy, and translates the accepted servers into `@dsh-cc/mcp-client` registrations ready to mount.

This package owns the file→config *reading and validation* surface only. It performs no network I/O and mounts nothing; consumers feed its output to `@dsh-cc/mcp-client` instances.

## Usage

```ts
import { buildRegistrations, type McpConfigPolicy } from '@dsh-cc/mcp-config'
import { readFileSync } from 'node:fs'

const body = JSON.parse(readFileSync('.mcp.json', 'utf8'))
const policy: McpConfigPolicy = {
  deny: (name) => name === 'blocked-saas',
  allow: (name) => name !== 'experimental',
}
// registrations: mcp-client Config objects (with serverName), in stable config order
const registrations = buildRegistrations(body, { env: process.env, policy })

for (const config of registrations) {
  await ctx.plugin(mcpClient, config)
}
```

A typical `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "web": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    },
    "feed": {
      "type": "sse",
      "url": "https://sse.example.com/events"
    }
  }
}
```

## Server definition types

A `.mcp.json` `mcpServers` map values are the Claude Code server definitions:

| Shape | `type` | Required | Notes |
|---|---|---|---|
| `stdio` | omitted or `"stdio"` | `command` | `args`, `env`, `cwd` optional |
| `http` | `"http"` (also accepts legacy `"streamable-http"`) | `url` | `headers` optional |
| `sse` | `"sse"` | `url` | `headers` optional |

`mcpServers` may be an object keyed by server name, or an array of such objects (the array form rejects a name that appears twice).

## Config mapping

Each accepted server translates to one `@dsh-cc/mcp-client` `Config`:

- The server **name** becomes `serverName`, the public namespace for the model-facing tool names (`mcp__<serverName>__*`).
- `command`-based definitions map to the `stdio` transport.
- `http` / `streamable-http` definitions map to the `streamable-http` transport.
- `sse` definitions map to the `sse` transport.
- Registrations default `toolCallTimeoutMs` to 60000 and `failOnStartupError` to `true` (a malformed or unreachable server fails the load loudly rather than silently activating without tools).

## Environment expansion

Strings in `command`, `args`, `cwd`, `env` values, `url`, and `headers` support:

- `${VAR}` — substituted with the environment value; **throws at load** when the variable is not set.
- `${VAR:-default}` — falls back to `default` when the variable is unset or empty.
- `$$` — a literal `$`.

Expansion reads `process.env` by default or the `env` option passed to `buildRegistrations` / `applyEnv`.

## Enterprise allow/deny policy

Pass a `McpConfigPolicy` to `buildRegistrations` to gate servers before translation:

- `deny(name, entry)` — returning `true` drops the server (runs first, wins).
- `allow(name, entry)` — when present, only servers where it returns `true` are kept.

Hooks receive the raw `McpServerEntry`; they must be synchronous and total. Policy happens after parsing and validation but before translation, in stable config order, and rejected servers never reach the client.

## Errors

Malformed configuration throws at load — a non-object body, a missing or non-map `mcpServers`, a duplicated name, an unknown transport type, a missing required `command`/`url`, or an unset environment variable. Fail loud beats silently skipping a missing referent.

## API

- `parseMcpServers(body)` — validate the `mcpServers` map and return it; throws on malformed input.
- `dedupServers(map)` — normalize a parsed map into a stable `McpServerSpec[]`; throws on a duplicated name.
- `normalizeServerEntry(entry)` — one raw entry → an mcp-client `Config` (no env expansion), validating required fields.
- `applyEnv(config, env?)` — expand `${...}` substitutions in one normalized config.
- `expandEnv(value, env)` — expand one string's substitutions.
- `buildRegistrations(body, { env?, policy? })` — full pipeline to mcp-client registrations.
