/**
 * Connection supervisor: owns the MCP client/transport generations for one
 * plugin instance, keeps the harness registries (tools, resources-as-tools,
 * and prompt-skills) in sync with the live generation, and — when the
 * connection drops — restarts the configured server with bounded exponential
 * backoff.
 *
 * One outage shares one attempt budget (`maxAttempts` consecutive failed
 * attempts, delays doubling from `initialDelayMs` up to `maxDelayMs`). A
 * connection that stays up past the stability window closes the outage, so
 * the next disconnect starts a fresh budget while a crash-looping server —
 * even one whose connects briefly succeed — still exhausts the cap instead of
 * restarting forever. Exhaustion unregisters the server's tools and stops;
 * disposal (including HMR) is the only way back from that state.
 *
 * Capability branching follows the server's declared `ServerCapabilities`:
 * `tools`, `resources`, and `prompts` each contribute a disposer map that is
 * kept live across an outage (last-good wins) and removed on give-up or
 * disposal. Every swap runs on one serialized chain so generations can never
 * interleave a dispose-previous/register-next swap.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createTransport, buildAuthProvider } from './transport.ts'
import type { TransportContext } from './transport.ts'
import { formatStdioStderrForWarn, stdioStderrTail } from './stdio-stderr.ts'
import { callToolUncached, DEFAULT_DEFER_TOOL_THRESHOLD, emptyToolGeneration, syncTools } from './tools.ts'
import type { ToolBridgeOptions, ToolGeneration } from './tools.ts'
import { syncResources } from './resources.ts'
import type { ResourceDisposers } from './resources.ts'
import { syncPrompts } from './prompts.ts'
import type { PromptDisposers } from './prompts.ts'
import type { Config } from './index.ts'

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

// The SDK's stdio transport owns two two-second termination grace periods.
// Keep one additional second for the process-close event that proves the old
// generation is gone; timing out fails closed instead of overlapping children.
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * supervisor runs. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here — misconfiguration
 * fails the plugin instance at load.
 *
 * @param config - Raw `reconnect` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  /* jscpd:ignore-start — domain-specific delay validation parallels llm retry-policy; not extractable */
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  /* jscpd:ignore-end */
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle {
  /**
   * Settles when the first connection attempt completes (success or failure).
   * The supervisor enters its reconnect loop regardless; the caller decides
   * whether a failed startup is fatal via `failOnStartupError`.
   */
  ready: Promise<ConnectionOutcome>
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued capability syncs to quiesce, then unregister every tool,
   * resource bridge, and prompt skill this server still owns.
   */
  dispose(): Promise<void>
  /**
   * How many capabilities this server currently publishes to the tool
   * registries: bridged MCP tools (deferred reservations included — they are
   * invisible in the model-facing schema but this server owns them) plus the
   * resource-bridge tools. Prompts are skills and do not count.
   */
  toolCount(): number
  /**
   * Eager/deferred split of {@link toolCount}: eager counts listed tools
   * registered visibly plus the always-eager resource-bridge tools; deferred
   * counts listed tools hidden behind ToolSearch. `eager + deferred === toolCount()`.
   */
  toolBreakdown(): { eager: number; deferred: number }
  /** One UNCACHED `tools/call` on the live client, bypassing the tools waterfall (read-only inspection tools only); throws when disconnected or on MCP `isError`. */
  callTool(rawName: string, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>
}

/** All registrations owned by one server generation, keyed by swap target. */
interface GenerationRegistrations {
  tools: ToolGeneration
  resources: ResourceDisposers
  prompts: PromptDisposers
}

/** Dispose one disposer map or tool generation and return the emptied value. */
function clear(entry: ToolGeneration): ToolGeneration
function clear(entry: Map<string, () => void>): Map<string, () => void>
function clear(entry: ToolGeneration | Map<string, () => void>): ToolGeneration | Map<string, () => void> {
  const disposers = entry instanceof Map ? entry.values() : entry.disposers.values()
  for (const dispose of disposers) dispose()
  return entry instanceof Map ? new Map() : emptyToolGeneration()
}

/**
 * Start the supervised connection for one MCP server and keep it alive per
 * the reconnect policy.
 *
 * @param ctx - Cordis context providing the `tools` registry and logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
export function startConnection(ctx: Context, config: Config, policy: ResolvedReconnectPolicy): ConnectionHandle {
  const label = `mcp-client(${config.serverName})`
  // OAuth provider shared by the transport and the 401-retry hook.
  const authProvider = config.transport !== 'stdio' && config.oauth !== undefined
    && ctx.get('credentials') !== undefined
    ? buildAuthProvider(ctx, config.serverName, config.oauth)
    : undefined
  const transportCtx: TransportContext = { ctx, ...authProvider !== undefined ? { authProvider } : {} }
  const opts: ToolBridgeOptions = {
    registrationFailure: 'contain',
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    deferToolThreshold: DEFAULT_DEFER_TOOL_THRESHOLD,
    ...authProvider !== undefined ? { onUnauthorized: () => authProvider.invalidateCredentials('tokens') } : {},
  }
  // The initial sync uses 'throw' when failOnStartupError is configured, so
  // a registration conflict propagates to the startup-await path. Re-syncs
  // and reconnect syncs always contain conflicts.
  const startupOpts: ToolBridgeOptions = config.failOnStartupError
    ? { ...opts, registrationFailure: 'throw' }
    : opts

  let disposed = false
  /** Current generation: the connecting or connected client; undefined during backoff waits and after final failure. */
  let client: Client | undefined
  /** Close signal paired with {@link client}; captured by dispose before current ownership is cleared. */
  let clientClosed: Promise<void> | undefined
  /** Live registrations owned by this server; each map is swapped by its own sync task or clear. */
  let registrations: GenerationRegistrations = { tools: emptyToolGeneration(), resources: new Map(), prompts: new Map() }
  let reconnectTimer: NodeJS.Timeout | undefined
  /** Consecutive failed connection attempts within the current outage. */
  let failedAttempts = 0
  /** When the current generation finished connect + initial sync; undefined while down. */
  let connectedAt: number | undefined
  /** The real error from the first connection attempt, for startup-await diagnostics. */
  let firstAttemptError: unknown
  /** Most recent stdio transport; snapshotted at warn time after stdio has flushed. */
  let lastTransport: ReturnType<typeof createTransport> | undefined

  /** One-line `; stderr: …` suffix, omitted when the ring is empty. */
  function stderrWarnSuffix(): string {
    if (lastTransport === undefined) return ''
    const formatted = formatStdioStderrForWarn(stdioStderrTail(lastTransport))
    return formatted === undefined ? '' : `; stderr: ${formatted}`
  }

  /** A generation may act only while it is the current one on a live plugin. */
  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /**
   * Serializes every registration swap — tool syncs, resource registration,
   * and prompt syncs, initial and notification-driven, across all generations —
   * so two swaps can never interleave their dispose-previous/register-next
   * phase (which would double-dispose one generation and leak another).
   */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueue(task: () => Promise<void> | void): Promise<void> {
    const run = syncChain.then(task)
    // The chain tail must survive a failed sync; the enqueuing caller owns reporting.
    syncChain = run.catch(() => {})
    return run
  }

  /** Swap the tool generation on connect / tools-list-changed / reconnect. */
  function syncToolGeneration(generation: Client, syncOpts: ToolBridgeOptions = opts): Promise<void> {
    return enqueue(async () => {
      if (!isCurrent(generation)) return
      const next = await syncTools(generation, ctx, syncOpts, registrations.tools)
      registrations = { ...registrations, tools: next }
    })
  }

  /** Register the resource bridge once the server declares the capability. */
  function syncResourceGeneration(generation: Client): Promise<void> {
    return enqueue(() => {
      if (!isCurrent(generation)) return
      const next = syncResources(generation, ctx, config.serverName)
      const old = registrations.resources
      registrations = { ...registrations, resources: next }
      for (const dispose of old.values()) dispose()
    })
  }

  /** Sync prompt-skills once the server declares the capability. */
  function syncPromptGeneration(generation: Client): Promise<void> {
    return enqueue(async () => {
      if (!isCurrent(generation)) return
      const next = await syncPrompts(generation, ctx, config.serverName)
      for (const dispose of registrations.prompts.values()) dispose()
      registrations = { ...registrations, prompts: next }
    })
  }

  /** One disconnect decision per generation: the isCurrent guard makes racing close/error signals idempotent. */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = undefined
    clientClosed = undefined
    scheduleReconnect()
  }

  /** Wait for the transport-owned close signal without letting a broken transport wedge teardown forever. */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      ctx.logger.error(`${label}: ${message}${stderrWarnSuffix()}`)
      return
    }
    // A connection that stayed up past the stability window (= maxDelayMs, the
    // longest backoff spacing) ended the previous outage: start a fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      // Enqueue the give-up disposal so it cannot race an in-flight sync's
      // swap (which checks isCurrent inside the queue).
      void enqueue(() => {
        registrations = {
          tools: clear(registrations.tools),
          resources: clear(registrations.resources),
          prompts: clear(registrations.prompts),
        }
      })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})${stderrWarnSuffix()}`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration(false)
    }, delayMs)
    // An armed reconnect timer must never hold the process open on its own.
    reconnectTimer.unref()
  }

  /**
   * One connection attempt: fresh transport + client (the MCP SDK binds a
   * Protocol to one transport for life), connect, then queue the capability
   * syncs for the declared server capabilities. The startup flag belongs to the
   * attempt rather than the shared sync queue, so an early notification cannot
   * consume strict startup semantics. Every failure funnels through
   * {@link generationDown}; success arms the onclose-driven disconnect path.
   * Never rejects.
   *
   * @param startup - Whether this is the plugin's activation attempt.
   */
  async function connectGeneration(startup: boolean): Promise<void> {
    const generation = new Client(
      { name: 'dsh-mcp-client', version: '0.0.1' },
      { capabilities: {} },
    )
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generation
    clientClosed = closed.promise
    generation.onclose = () => {
      closeObserved = true
      closed.resolve()
      // A failed connect owns its close barrier in the catch path below. An
      // established generation can transition down directly from this signal.
      if (attemptSettled) generationDown(generation)
    }
    // Registered before connect so a list change during an initial sync is
    // queued behind it rather than dropped.
    generation.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: tool list changed, re-syncing`)
        try {
          await syncToolGeneration(generation)
        } catch (error) {
          // Fetch-phase failure: the previous generation is still registered
          // and `registrations.tools` still owns it — keep serving the last good list.
          if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
        }
      },
    )
    generation.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: resource list changed, re-syncing resources`)
        await syncResourceGeneration(generation)
      },
    )
    generation.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: prompt list changed, re-syncing prompts`)
        await syncPromptGeneration(generation)
      },
    )
    try {
      const transport = createTransport(config, transportCtx)
      lastTransport = transport
      await generation.connect(transport)
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      const caps = typeof generation.getServerCapabilities === 'function'
        ? generation.getServerCapabilities()
        : undefined
      // Tools are bridged unconditionally (the long-standing behavior); only
      // the optional resource and prompt bridges are capability-gated.
      await syncToolGeneration(generation, startup ? startupOpts : opts)
      if (caps?.resources !== undefined) await syncResourceGeneration(generation)
      if (caps?.prompts !== undefined) await syncPromptGeneration(generation)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      // Disposal clears current ownership before it closes the generation, so
      // only a live supervisor reports an attempt failure.
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}${stderrWarnSuffix()}`)
      try { await generation.close() } catch { /* transport already gone */ }
      const quiesced = hasClosed() || await waitForClose(closed.promise)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = undefined
        clientClosed = undefined
        ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`)
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  /** The in-flight (or last settled) connection attempt; dispose awaits it for quiescence. */
  let settling = connectGeneration(true)

  // The ready promise settles when the first attempt finishes (regardless of
  // success). If the first attempt fails and reconnect is enabled, the
  // supervisor is already scheduling a retry — ready just reports the outcome.
  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    // After settling: if client is set the initial connect+sync succeeded.
    // If not, the supervisor either scheduled a retry (error logged) or gave
    // up (error logged). Either way the outcome is reported with the real error.
    if (client !== undefined) return {}
    /* v8 ignore next -- defensive: firstAttemptError is always set when connect/sync fails */
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) }
  })

  return {
    ready,
    toolCount(): number {
      return registrations.tools.disposers.size + registrations.resources.size
    },
    toolBreakdown(): { eager: number; deferred: number } {
      return {
        eager: registrations.tools.eagerCount + registrations.resources.size,
        deferred: registrations.tools.deferredCount,
      }
    },
    async callTool(rawName, args, options) {
      const generation = client
      if (generation === undefined) {
        throw new Error(`${label}: no established connection — callTool unavailable`)
      }
      const result = await callToolUncached(
        generation, rawName, args,
        options.signal ?? new AbortController().signal,
        options.timeoutMs ?? opts.toolCallTimeoutMs,
      )
      // MCP isError → throw, preserved from the executor path (tools.ts).
      if (result.isError === true) {
        const text = (Array.isArray(result.content) ? result.content : [])
          .map((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
          .filter((t) => t.length > 0).join('\n')
        throw new Error(text || `mcp tool "${rawName}" failed`)
      }
      return result
    },
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      const currentClosed = clientClosed
      client = undefined
      clientClosed = undefined
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
        if (currentClosed !== undefined && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
        }
      }
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // syncs before settling, so awaiting both leaves `registrations` final.
      await settling
      await syncChain
      registrations = {
        tools: clear(registrations.tools),
        resources: clear(registrations.resources),
        prompts: clear(registrations.prompts),
      }
    },
  }
}
