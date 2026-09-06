# @dsh-cc/mcp-client

English | [中文](README.zh.md)

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools under server-qualified names (`mcp__<serverName>__<rawName>`).

## Usage

One plugin instance per MCP server in `cordis.yml`:

```yaml
- id: mcp-github
  name: '@dsh-cc/mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@dsh-cc/mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'

- id: mcp-feed
  name: '@dsh-cc/mcp-client'
  config:
    serverName: feed
    transport: sse
    url: http://localhost:3001/sse
    oauth:
      redirectUrl: http://localhost:8787/callback
```

The model sees `mcp__github__create_issue`, `mcp__web__search`, … — the same server-qualified shape Claude Code and Codex use. HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart; an unchanged `serverName` reproduces identical tool names.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"`, `"streamable-http"`, or `"sse"` |
| `serverName` | both | yes | Namespace for this server's model-facing tool names; `[A-Za-z0-9_-]{1,32}`, unique across live instances |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `oauth` | http | no | OAuth flow options (see below) |
| `toolCallTimeoutMs` | both | no | Timeout per `callTool` invocation (default 60000) |
| `failOnStartupError` | both | no | Reject plugin activation when initial connection or tool synchronization fails (default `false`) |
| `reconnect.enabled` | both | no | Reconnect automatically after a lost connection (default `true`) |
| `reconnect.initialDelayMs` | both | no | First reconnect delay in ms; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | both | no | Backoff ceiling in ms; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | both | no | Consecutive failed attempts per outage before giving up for good (default 10) |

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in `tools/call`) and the public name `mcp__<serverName>__<rawName>` registered on `ctx.tools`. Public names are normalized to the DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes the name, a deterministic 12-hex-char hash of `(serverName, rawName)` is appended so distinct tools never collapse into one name. Names are pure functions of `(serverName, rawName)` — connection order, re-syncs, and other servers never rename a tool.

- Two servers publishing the same raw name (e.g. `search`) coexist under their namespaces.
- A duplicate `serverName` across live instances fails the later plugin instance at load.
- A server listing the same tool name twice is rejected as an invalid tool list.
- A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error.

## Behavior

- On connect: plugin activation awaits `listTools()` and publishes each tool under its public name before the composition starts its first turn — eagerly via `ctx.tools.register()`, or deferred through `ctx.toolSearch.registerDeferred` when that seam is mounted and the server lists at least `deferToolThreshold` tools (default 8). Initial connection, discovery, or registration failure is always logged; it rejects activation when `failOnStartupError` is true and otherwise activates with no tools.
- Listens for `notifications/tools/list_changed` → re-syncs; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and leaves no tools from that server.
- Tool execute: `client.callTool({ name: rawName, arguments }, { signal })` with timeout + abort support—the public name is never sent to the server.
- Canonical success is `{ content: JsonValue[], structuredContent? }`; complete JSON MCP blocks survive for programmatic callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`.
- Native/model rendering keeps the existing text projection: text blocks join with newlines while image, audio, resource, and unsupported blocks become placeholders.
- On disconnect/crash: the supervisor restarts the original server config with exponential backoff (`reconnect.initialDelayMs` doubling up to `reconnect.maxDelayMs`) and re-runs discovery on success — the recovered generation replaces the previous one, so tools neither duplicate nor leak. During the outage the last good generation stays registered; calls against it fail until recovery.
- Reconnection is budgeted per outage: after `reconnect.maxAttempts` consecutive failures the server's tools are unregistered and reconnection stops until an HMR reload or Host restart. A connection that survives past `maxDelayMs` resets the budget, so an occasionally-crashing server recovers indefinitely while a crash-looping one — even with briefly successful connects — still exhausts the cap instead of restarting forever.
- Reconnect states are user-visible in logs: reconnecting (warn, with attempt count and delay), recovered (info), final failure and disabled-loss (error). Disposal cancels any pending reconnect. With `reconnect.enabled: false`, a lost connection keeps tools registered but failing until a reload — the manual-recovery behavior.
- Stdio server stderr is piped, never inherited, so it cannot paint a TUI. The stream is appended to `$DSH_HOME/mcp-logs/<serverName>.log`, rotated at 4 MiB with one `.log.1` backup generation and a trimmed tail is attached to connection-failure / connection-lost warns. Headless users no longer see live server stderr on the terminal.

## Capabilities

Beyond tools, the bridge exposes a server's other MCP capabilities when the server declares them:

- **Resources** — exposed as two server-qualified model tools, `mcp__<serverName>__list_mcp_resources` and `mcp__<serverName>__read_mcp_resource`, which call `resources/list` and `resources/read`. The `ctx.fs` seam (a real-filesystem abstraction over `FsTarget`/`readBytes`) cannot represent virtual MCP resources, so these bridge tools are the fallback the capability seam prescribes. Resource-list-change notifications re-register the bridge.
- **Prompts** — each MCP prompt is registered as a skill on `ctx.skills` when the prompt capability is declared. Skill names map the `mcp__<server>__<prompt>` shape onto the registry's lowercase-kebab grammar (`mcp-<server>-<prompt>`). Argumentless prompts are resolved via `prompts/get` and their rendered text becomes the skill body; prompts that require arguments are documented with their argument contract instead. MCP-sourced skills are inert prose — never executable shell. Prompt-list-change notifications re-register the skills. Prompt bridging requires the `ctx.skills` service; without it the bridge is a no-op.
- **OAuth** — network transports (`streamable-http`, `sse`) accept an `oauth` block. Tokens, registered-client information, the PKCE code verifier, and discovery state are persisted through the `ctx.credentials` reference seam (stored under derived credential references, never inline). The MCP SDK drives RFC 9728 → RFC 8414 metadata discovery, dynamic client registration, scheme-code PKCE, and token refresh through the provider; a mid-session `401` is retried once after dropping the stale token state. OAuth requires the `ctx.credentials` service.

The supervisor keeps each capability's registrations live across an outage (last-good wins) and removes them on give-up or disposal, all through one serialized swap chain.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register/unregister MCP tools and the resource bridge |
| `ctx.toolSearch` | Optional: defer over-threshold listed tools (duck-typed; never a required inject) |
| `ctx.skills` | Optional: register MCP prompt skills |
| `ctx.credentials` | Optional: persist OAuth tokens and related state |

## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, each advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

When the `ctx.toolSearch` seam is mounted and this server lists at least **8 tools** (the default `deferToolThreshold`; counts the `tools/list` length including alwaysLoad tools), deferrable tools register **deferred** instead: they contribute name + description + a server-qualified search hint to the ToolSearch pool and stay out of the model-visible schema until a ToolSearch hit activates them (`activate` performs the real registration, callable exactly like any top-of-prompt tool afterward). A tool advertising `_meta['anthropic/alwaysLoad'] === true` registers eagerly even on a deferred server. Resource-bridge tools (`mcp__<server>__list_mcp_resources` / `read_mcp_resource`) always stay eager. Without the toolSearch seam — standalone deployments, other presets — every tool registers eagerly at any threshold.

A generation swap (reconnect or `tools/list_changed`) disposes the previous generation first, which also unloads tools the model had activated via ToolSearch: after the swap those names are searchable again, and the model must search (or the session must re-activate) before calling them. Identical re-syncs on the same client are skipped by fingerprint and re-publish nothing.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered — deferred tools pay it only after activation, replacing their schema cost with one ToolSearch tool plus per-hit activations. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the discovered tool set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable. The first deferred registration also inserts the ToolSearch tool into the model-visible set (one-time prefix change; it stays registered afterward — hysteresis).

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. Text result blocks are joined with newlines into one retained Native text result; image, audio, resource, and unsupported blocks become short placeholders there. Their full JSON blocks and optional structured content remain in the execution-local canonical value, and MCP `isError` rejects the call through the registry's error path.

#### Token effect

Arguments and mapped text are retained until compaction. Binary and resource payloads are discarded rather than added to context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The defer threshold is per-server tool count, not context size** — a percentage-of-context or cross-server aggregate rule (Claude Code's ~10%) would defer more aggressively; three small servers of five tools each all stay eager. The threshold is also not configurable via plugin Config yet (tests pass it into `syncTools` directly).
- **ToolSearch activation is process-global** — loading a deferred MCP tool makes it visible to every agent whose tool restriction admits the name, and there is no per-conversation discovery history (see the `dsh-tool-search` README).
- **Programmatic `ctx.tools.execute` on a reserved-but-unactivated MCP name fails as unknown** — the definition does not exist until a ToolSearch hit activates it; no in-repo caller relies on this.
- **Exact frontmatter MCP names must match the public (possibly hashed) name** — server-prefix wildcards sidestep most of that.

- **Dynamic OAuth client registration is delegated to the MCP SDK** — the SDK owns RFC 9728/8414 metadata discovery, PKCE, dynamic client registration, and token refresh; this package supplies the credentials-backed persistence half of the `OAuthClientProvider` seam and the single 401 retry. An interactive `redirectToAuthorization` logs the URL for a headless host rather than driving a browser; completing the flow still requires an operator.
- **Startup timeout is inherited from the MCP SDK** — DSH does not yet expose a connection/discovery timeout. Each initialize or paginated `tools/list` request uses the SDK's 60-second default, so an unresponsive server or cursor chain can delay both activation and teardown while the initial synchronization settles.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request and through the SDK transport's own SSE-stream recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Native non-text rendering is lossy** — image, audio, and resource payloads become placeholders in model context even though the execution-local canonical value preserves their JSON blocks. Richer Native multimedia projection is deferred.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
- **Resource bridging uses the two-tool fallback, not a filesystem provider** — the `ctx.fs` seam cannot represent virtual MCP resources; the ListMcpResources/ReadMcpResource model tools are the current surface.
