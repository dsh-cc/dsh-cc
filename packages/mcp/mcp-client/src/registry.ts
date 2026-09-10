/**
 * Central MCP connection registry for the mcp-client package.
 *
 * Each mcp-client plugin instance bridges one MCP server, and previously
 * nothing central could enumerate them. This module defines an optional
 * `mcpConnections` service that gathers every live instance under one roof so
 * host plugins (slash commands such as `/mcp`) can list servers, their
 * connection state, and drive disconnect/reconnect. The service is provided by
 * mcp-client itself; an instance running standalone provides it lazily, while
 * instances sharing a scope reuse the first-provided one, so the registry stays
 * optional (mcp-client keeps working without a consumer).
 *
 * @module
 */

import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The live MCP connection registry, when an mcp-client instance provided it. */
    mcpConnections: McpConnectionsService
  }
}

/** The connection lifecycle state of one MCP server instance. */
export type McpConnectionState = 'connecting' | 'ready' | 'error' | 'disconnected'

/** A public snapshot of one registered MCP server. */
export interface McpConnectionEntry {
  /** The mcp-client `serverName` this instance bridges. */
  name: string
  /** Current connection lifecycle state. */
  state: McpConnectionState
  /** The last error message, when the state is `error`. */
  error?: string
  /** The number of tools this server currently exposes, when known. */
  toolCount?: number
  /** Number of tools registered eagerly (including resource-bridge tools), when known. */
  eagerCount?: number
  /** Number of tools registered deferred (hidden until ToolSearch activation), when known. */
  deferredCount?: number
  /** Whether interacting with this server requires OAuth authorization. */
  authRequired?: boolean
}

/** Per-instance control surface the owning mcp-client plugin wires to its supervisor. */
export interface McpConnectionControl {
  /** Stop the current connection and unregister its tools; the entry is marked `disconnected`. */
  disconnect(): Promise<void>
  /** Tear down the current connection and establish a fresh one; the entry is marked `connecting` then `ready`/`error`. */
  reconnect(): Promise<void>
}

/** Live bookkeeping for one registered server instance. */
interface Managed {
  entry: McpConnectionEntry
  control: McpConnectionControl
}

/** Listener invoked with a snapshot copy whenever a registry entry mutates. */
export type McpConnectionChangeListener = (entry: McpConnectionEntry) => void

/** The `mcpConnections` service: enumerate and drive the registered MCP servers. */
export class McpConnectionsService extends Service {
  /** Live instances keyed by `serverName`. */
  private readonly managed = new Map<string, Managed>()

  private readonly listeners = new Set<McpConnectionChangeListener>()

  /**
   * Subscribe to entry mutations (register / report / unregister). Each event
   * delivers a snapshot COPY of the entry (mutating it does not affect the
   * registry). Listener exceptions are contained and logged.
   * @returns a disposer that stops delivery.
   */
  onDidChange(listener: McpConnectionChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(entry: McpConnectionEntry): void {
    const snapshot: McpConnectionEntry = { ...entry }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.ctx.logger.warn(`mcpConnections: onDidChange listener failed: ${String(error)}`)
      }
    }
  }

  constructor(ctx: Context) {
    super(ctx, 'mcpConnections')
  }

  /**
   * Register a live mcp-client instance's control surface, initially `connecting`.
   * @param name - the instance `serverName`.
   * @param control - the disconnect/reconnect control the instance wires.
   * @throws when `name` is already registered (a live duplicate is a config error).
   */
  register(name: string, control: McpConnectionControl, authRequired?: boolean): void {
    if (this.managed.has(name)) {
      throw new Error(`mcpConnections: server "${name}" is already registered by another mcp-client instance`)
    }
    this.managed.set(name, { entry: { name, state: 'connecting', ...authRequired === undefined ? {} : { authRequired } }, control })
    this.notify(this.managed.get(name)!.entry)
  }

  /** Remove an instance (on teardown / full disconnect). */
  unregister(name: string): void {
    const managed = this.managed.get(name)
    if (managed) this.notify(managed.entry)
    this.managed.delete(name)
  }

  /** Report a lifecycle transition for a registered instance. */
  report(name: string, state: McpConnectionState, info: { error?: string } = {}): void {
    const managed = this.managed.get(name)
    if (!managed) return
    managed.entry.state = state
    if (info.error !== undefined) managed.entry.error = info.error
    if (state === 'ready' || state === 'connecting') delete managed.entry.error
    this.notify(managed.entry)
  }

  /** Record the current tool count for a registered instance. */
  setToolCount(name: string, toolCount: number): void {
    const managed = this.managed.get(name)
    if (managed) managed.entry.toolCount = toolCount
  }

  /**
   * Record the eager/deferred tool breakdown for a registered instance.
   * Also overwrites `toolCount` with `eager + deferred`, keeping the
   * invariant `eagerCount + deferredCount === toolCount`.
   */
  setToolBreakdown(name: string, breakdown: { eager: number; deferred: number }): void {
    const managed = this.managed.get(name)
    if (!managed) return
    managed.entry.eagerCount = breakdown.eager
    managed.entry.deferredCount = breakdown.deferred
    managed.entry.toolCount = breakdown.eager + breakdown.deferred
  }

  /** A snapshot of every registered server today. */
  entries(): McpConnectionEntry[] {
    return Array.from(this.managed.values()).map(({ entry }) => ({ ...entry }))
  }

  /**
   * Disconnect a registered server: stop its connection and unregister its
   * tools, leaving the entry marked `disconnected`.
   * @param name - the instance `serverName`.
   * @throws when no such server is registered or its control rejects.
   */
  async disconnect(name: string): Promise<void> {
    const managed = this.require(name)
    await managed.control.disconnect()
    this.report(name, 'disconnected')
  }

  /**
   * Reconnect a registered server: tear down and establish a fresh connection.
   * @param name - the instance `serverName`.
   * @throws when no such server is registered or its control rejects.
   */
  async reconnect(name: string): Promise<void> {
    const managed = this.require(name)
    this.report(name, 'connecting')
    await managed.control.reconnect()
  }

  private require(name: string): Managed {
    const managed = this.managed.get(name)
    if (!managed) throw new Error(`mcpConnections: no server "${name}" is registered`)
    return managed
  }
}
