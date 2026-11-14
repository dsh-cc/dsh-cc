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

- The server **name** becomes `serverName`, the public namespace for the model-facing tool names (`mcp__<serverName>__*`). It is normalized to the mcp-client tool-prefix contract `[A-Za-z0-9_-]{1,32}`: runs of other characters collapse to `-`, leading and trailing `-` are trimmed, the result is capped at 32 chars, and a name with no valid character becomes `-`. Policy hooks still see the original name.
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
- `normalizeServerEntry(entry)` — one raw entry → its transport half (`McpTransport`: transport fields only; no `serverName`, no env expansion), validating required fields. `serverName` is added later by `buildRegistrations`.
- `applyEnv(config, env?)` — expand `${...}` substitutions in one normalized config.
- `expandEnv(value, env)` — expand one string's substitutions.
- `normalizeServerName(name)` collapses a Claude Code server name into the mcp-client `[A-Za-z0-9_-]{1,32}` tool-prefix contract: invalid runs become `-`, edges are trimmed, the result is capped at 32 chars, and an all-invalid name becomes `-`.
- `resolveDefaultMcpPaths({ env?, cwd?, home? })` classifies the default config paths into the dsh-native, Claude Code, and migration-target buckets. It is pure when all three inputs are given.
- `readMcpServerNames(path)` returns the raw declared names of one config file and never throws: `{ kind: 'absent' }`, `{ kind: 'invalid', error }`, or `{ kind: 'ok', names }`.
- `claudeOnlyServers(paths)` reports, per Claude Code file, the declared names that no dsh-native file declares.
- `migrateMcpServers({ sources, target })` is the package's only file-writing surface. It copies raw server entries into the target with an atomic write, existing target names win, and a `.bak` backup is made only when an existing target is overwritten.
- `buildRegistrations(body, { env?, policy?, deferStartupConnect? })` runs the full pipeline to mcp-client registrations. With `deferStartupConnect: true` the emitted configs also set `failOnStartupError: false`, so the two flags never contradict each other.
