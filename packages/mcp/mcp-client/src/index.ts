/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @dsh-cc/mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ConnectionHandle, ConnectionOutcome, ReconnectConfig } from './connection.ts'
import type { OAuthConfig } from './auth.ts'
import { McpConnectionsService, type McpConnectionControl } from './registry.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@dsh-cc/tools'

export type { McpResult } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy, ConnectionHandle } from './connection.ts'
export type { OAuthConfig } from './auth.ts'
export { McpConnectionsService } from './registry.ts'
export type { McpConnectionState, McpConnectionEntry, McpConnectionControl } from './registry.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per app, keyed off `ctx.root` (multiple apps
 * in one process — tests — must not see each other's names). A duplicate
 * namespace is a configuration error surfaced at plugin load, never silent
 * shadowing.
 */
const activeServerNames = new WeakMap<Context, Set<string>>()

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /**
   * Return from `apply` without awaiting the initial connect: the handshake
   * and tool discovery settle in the background. Ignored (fully blocking)
   * when `failOnStartupError` is true.
   */
  deferStartupConnect?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Optional OAuth flow; wires a credentials-backed client provider. */
  oauth?: OAuthConfig
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /**
   * Return from `apply` without awaiting the initial connect: the handshake
   * and tool discovery settle in the background. Ignored (fully blocking)
   * when `failOnStartupError` is true.
   */
  deferStartupConnect?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over legacy HTTP + SSE. */
export interface SseConfig {
  /** Selects the SSE transport. */
  transport: 'sse'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP SSE endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Optional OAuth flow; wires a credentials-backed client provider. */
  oauth?: OAuthConfig
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /**
   * Return from `apply` without awaiting the initial connect: the handshake
   * and tool discovery settle in the background. Ignored (fully blocking)
   * when `failOnStartupError` is true.
   */
  deferStartupConnect?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio, Streamable HTTP, or SSE MCP server. */
export type Config = StdioConfig | StreamableHttpConfig | SseConfig

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

const OAuth: z<OAuthConfig> = z.object({
  redirectUrl: z.string().required(false),
  clientName: z.string().required(false),
  credentialPrefix: z.string().required(false),
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    deferStartupConnect: z.boolean().default(false),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    oauth: OAuth.required(false),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    deferStartupConnect: z.boolean().default(false),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('sse'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    oauth: OAuth.required(false),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    deferStartupConnect: z.boolean().default(false),
    reconnect: Reconnect,
  }),
]) as unknown as z<Config>

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    let names = activeServerNames.get(ctx.root)
    if (!names) {
      names = new Set()
      activeServerNames.set(ctx.root, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp-client.serverName')

  // The MCP registry is an optional seam: provide one when the scope lacks it,
  // otherwise reuse the shared instance so every mcp-client under one scope
  // reports into a single service. Standalone (no consumer) still connects.
  let registry = ctx.get('mcpConnections') as McpConnectionsService | undefined
  if (registry === undefined) {
    registry = new McpConnectionsService(ctx)
  }
  const authRequired = config.transport !== 'stdio' && config.oauth !== undefined

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  let current: ConnectionHandle | undefined

  /** Dispose whatever supervisor is live (idempotent; used by disconnect & teardown). */
  async function disposeConnection(): Promise<void> {
    const handle = current
    current = undefined
    if (handle) await handle.dispose()
  }

  /**
   * Establish a fresh connection: dispose any prior supervisor, kick off a new
   * one, and settle the startup/blocking outcome. Reports state transitions to
   * the registry and refreshes the tool count on success.
   */
  async function connect(): Promise<ConnectionOutcome> {
    await disposeConnection()
    registry!.report(config.serverName, 'connecting')
    const handle = startConnection(ctx, config, reconnect)
    current = handle
    const outcome = await handle.ready
    // Settle guard: a deferred continuation whose supervisor was already
    // replaced (a newer connect) or disposed (the effect teardown unregistered
    // the entry) must not write into the registry after the fact.
    if (current !== handle) return outcome
    if (outcome.error !== undefined) {
      registry!.report(config.serverName, 'error', { error: String(outcome.error) })
    } else {
      registry!.report(config.serverName, 'ready')
      registry!.setToolCount(config.serverName, handle.toolCount())
      registry!.setToolBreakdown(config.serverName, handle.toolBreakdown())
    }
    return outcome
  }

  const control: McpConnectionControl = {
    async disconnect() {
      await disposeConnection()
      registry!.report(config.serverName, 'disconnected')
    },
    async reconnect() {
      const outcome = await connect()
      if (outcome.error !== undefined) throw outcome.error
    },
  }
  registry.register(config.serverName, control, authRequired)

  ctx.effect(() => {
    return async () => {
      await disposeConnection()
      registry!.unregister(config.serverName)
    }
  }, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  //
  // With `deferStartupConnect`, activation returns right after the namespace
  // reservation and registry.register above; the connect is kicked un-awaited
  // and its settle continuation (guarded in `connect`) updates the registry
  // and tools. `failOnStartupError` wins: deferral is ignored so the entire
  // startup-options path stays blocking — that flag also flips the initial
  // sync's `registrationFailure` to 'throw' (connection.ts), so a partial
  // deferral would produce a fiber rollback nobody awaits.
  if (config.deferStartupConnect === true && !config.failOnStartupError) {
    // An unhandled rejection would kill the Node process; contain it loudly.
    void connect().catch((error: unknown) => {
      ctx.logger.warn(`mcp-client(${config.serverName}): deferred initial connect failed: ${String(error)}`)
    })
    return
  }
  const outcome = await connect()
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
