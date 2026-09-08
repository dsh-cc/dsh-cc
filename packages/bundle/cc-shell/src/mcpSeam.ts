/**
 * The plugin MCP seam host: bridges CC plugin `mcpServers` entries into
 * `@dsh-cc/mcp-client` instances through the loader's `McpSeam` guest
 * contract. Provided by the cc-shell-glue composition via a child plugin
 * (a direct provide on the LOADING glue fiber is invisible to strict
 * `ctx.get`), so the loader's `mountMcpServers` finds it under the `mcp` key.
 *
 * Registration behavior (docs/plans/2026-09-07-plugin-mcp-seam.md §3.1):
 * - config errors SKIP the server with a warn (D1) — never throw;
 * - `deferStartupConnect: true` so plugin servers never block boot (D5);
 * - a pending-release ledger keyed on dispose-settle promises serializes
 *   same-name (re)registrations (D8), and a deferred attach carries a
 *   cancellation flag so dispose-before-attach never leaks a zombie fiber.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import * as CcMcpClient from '@dsh-cc/mcp-client'
import { buildRegistrations, type Config } from '@dsh-cc/mcp-config'
import type { McpSeam } from '@dsh-cc/plugin-loader'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The plugin MCP seam, when cc-shell-glue is composed. */
    mcp: McpSeam
  }
}

/** Options for `createPluginMcpSeam`. */
export interface PluginMcpSeamOptions {
  /** Injectable plugin reference for tests; default: CcMcpClient. */
  plugin?: unknown
  /** Injectable env lookup for expansion tests; default: process.env. */
  env?: Record<string, string | undefined>
  /** Boot pending-notice feed: called with the normalized serverName. */
  onRegistered?: (serverName: string) => void
}

/** The dispose-carrying shape cordis's `ctx.plugin` returns. */
interface PluginFiber {
  dispose(): unknown
}

export function createPluginMcpSeam(ctx: Context, opts: PluginMcpSeamOptions = {}): McpSeam {
  const plugin = opts.plugin ?? CcMcpClient
  // Pending-release ledger (D8): serverName → the promise whose settle makes
  // the name free again. Attach writes the activation-settle entry; the
  // DISPOSER overwrites it with the dispose-settle promise BEFORE disposing
  // (that side is the one that guards the async `_unload` namespace release a
  // remount would otherwise race). Entries are deleted on every settle branch
  // — the map holds pending-only.
  const ledger = new Map<string, Promise<void>>()
  const release = (serverName: string, pending: Promise<void>): void => {
    ledger.set(serverName, pending)
    void pending.then(() => {
      if (ledger.get(serverName) === pending) ledger.delete(serverName)
    })
  }
  const mount = (p: unknown, config: unknown): PluginFiber =>
    (ctx.plugin as (p: unknown, c: unknown) => PluginFiber)(p, config)

  return {
    registerServer(name: string, rawConfig: Record<string, unknown>): () => void {
      let registrations: Config[]
      try {
        registrations = buildRegistrations(
          { mcpServers: { [name]: rawConfig } },
          { env: opts.env ?? process.env, deferStartupConnect: true },
        )
      } catch (cause) {
        ctx.logger.warn(`cc-shell-glue: skipped plugin MCP server "${name}": ${String(cause)}`)
        return () => {}
      }
      if (registrations.length !== 1) {
        ctx.logger.warn(`cc-shell-glue: skipped plugin MCP server "${name}": dropped by config policy`)
        return () => {}
      }
      const config = registrations[0]!
      const serverName = config.serverName

      const attach = (): (() => void) => {
        const fiber = mount(plugin, config)
        // The activation thenable is always consumed: settle on success, warn
        // on rejection (e.g. a duplicate-namespace reservation), so no
        // unhandled rejection ever escapes the seam.
        const active = Promise.resolve(fiber as unknown as PromiseLike<void>).then(
          () => {},
          error => {
            ctx.logger.warn(`cc-shell-glue: MCP server ${serverName} failed to activate: ${String(error)}`)
          },
        )
        release(serverName, active)
        opts.onRegistered?.(serverName)
        return () => {
          const disposed = Promise.resolve(fiber.dispose()).then(
            () => {},
            error => {
              ctx.logger.warn(`cc-shell-glue: MCP server ${serverName} teardown failed: ${String(error)}`)
            },
          )
          // Written BEFORE disposing: a same-name remount chains behind this
          // dispose-settle promise, not behind the (long-settled) activation.
          release(serverName, disposed)
          void fiber.dispose()
        }
      }

      const pending = ledger.get(serverName)
      if (pending === undefined) return attach()

      // Same-name attach while a previous release is pending: defer behind it,
      // carrying a cancellation flag their disposer sets — dispose-before-attach
      // disposes the freshly created fiber immediately instead of leaking it.
      let cancelled = false
      let attached: (() => void) | undefined
      void pending.then(() => {
        if (cancelled) {
          attach()()
          return
        }
        attached = attach()
      })
      return () => {
        if (attached !== undefined) {
          attached()
          return
        }
        cancelled = true
      }
    },
  }
}
