/**
 * Process-level MCP singletons for the cc-shell glue.
 *
 * With several agent presets standing-mounted in one runtime, the shared
 * `cc-services` body (and its `cc-shell-glue` row) is composed once per tree.
 * Both trees share one root, so the MCP resources must be runtime-scoped:
 *
 * - `ensureMcpConnections` publishes ONE `mcpConnections` registry from the
 *   root fiber (register-if-absent, same idiom as `CcPluginManagerService`),
 *   constructed inside an awaited child plugin because the service
 *   self-provides on its own fiber.
 * - `mountMcpServerOnce` mounts one mcp-client fiber per `serverName` under
 *   the root; a second preset tree reuses the in-flight mount instead of
 *   tripping the mcp-client `serverName` reservation.
 *
 * `mountedMcpServers` is module scope on purpose: both standing mounts run in
 * the same process and resolve the same root context.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { McpConnectionsService } from '@dsh-cc/mcp-client'

/** In-flight mounts per root, keyed by serverName. */
const mountedMcpServers = new WeakMap<Context, Map<string, Promise<void>>>()

/**
 * Return the root-realm `mcpConnections` registry, publishing it on first use.
 *
 * Async on purpose: the child fiber must be ACTIVE (and the service
 * self-provided) before any mcp-client mounts, otherwise mcp-client's lazy
 * `ctx.get('mcpConnections') ?? new McpConnectionsService(ctx)` fallback
 * provides from a preset fiber and trips leakedServices.
 */
export async function ensureMcpConnections(root: Context): Promise<McpConnectionsService> {
  const key = root[Context.isolate]['mcpConnections']
  const existing = key === undefined ? undefined : root.reflect.store[key]
  if (existing !== undefined) return existing.value as McpConnectionsService
  let mounted: McpConnectionsService | undefined
  await root.plugin({
    name: 'cc-mcp-connections',
    apply(c: Context) {
      mounted = new McpConnectionsService(c)
    },
  })
  return mounted!
}

/**
 * One-shot marks keyed on the shared registry instance, so a runtime-scoped
 * notice fires once even though every preset tree mounts the glue (design §D).
 * One WeakSet per notice kind: the boot "still connecting" notice and the
 * gating notice must each fire once, independently of each other.
 */
const noticeFired = new WeakSet<McpConnectionsService>()
const gatingNoticeFired = new WeakSet<McpConnectionsService>()

function markOnce(set: WeakSet<McpConnectionsService>, registry: McpConnectionsService): boolean {
  if (set.has(registry)) return false
  set.add(registry)
  return true
}

/** Mark the boot pending notice as fired for this registry. `false` = already fired (caller no-ops). */
export function markNoticeFired(registry: McpConnectionsService): boolean {
  return markOnce(noticeFired, registry)
}

/** Mark the MCP config gating notice as fired for this registry. `false` = already fired. */
export function markGatingNoticeFired(registry: McpConnectionsService): boolean {
  return markOnce(gatingNoticeFired, registry)
}

/**
 * Mount one mcp-client instance per `serverName` per root.
 *
 * The returned promise is the shared in-flight mount: concurrent and later
 * calls with the same name await it rather than mounting a duplicate. On
 * failure the entry is cleared so a retry can re-attempt. The mounted fiber
 * is owned by the root (runtime-scoped, not preset-scoped) — this helper only
 * tracks the mount promise.
 *
 * @param root - the runtime root context (shared by every preset tree)
 * @param plugin - the mcp-client namespace plugin
 * @param config - one registration from the mcp-config loader
 */
export async function mountMcpServerOnce(root: Context, plugin: unknown, config: unknown): Promise<void> {
  let perRoot = mountedMcpServers.get(root)
  if (perRoot === undefined) {
    perRoot = new Map()
    mountedMcpServers.set(root, perRoot)
  }
  const name = (config as { serverName: string }).serverName
  const inFlight = perRoot.get(name)
  if (inFlight !== undefined) return inFlight

  // ctx.plugin returns a Fiber (PromiseLike) with no `.catch`, so normalize
  // to a real Promise before attaching the rejection handler.
  const mount = Promise.resolve(root.plugin(plugin as never, config as never)).then(() => {})
  perRoot.set(name, mount)
  mount.catch(() => perRoot.delete(name))
  await mount
}
