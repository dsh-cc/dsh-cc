/**
 * Duck-typed, optional consumption of the cc-shell `ccPlugins` service. The
 * service may be absent (behavior identical to before); when present it
 * exposes plugin commands under colon names like `codex:review` that the
 * harness command registry cannot host.
 * @module @dsh-cc/command-help/plugins
 */

import type { Context } from '@deepseek-ai/cordis'

/** Info exposed by the `ccPlugins` service for one plugin command. */
export interface PluginCommandInfo {
  /** Display form `plugin:command`, e.g. `codex:review`. */
  name: string
  plugin: string
  description: string
  argumentHint?: string
}

interface CcPluginsService {
  listPluginCommands(): readonly PluginCommandInfo[]
}

/**
 * Read plugin commands from the optional `ccPlugins` service.
 * @param ctx - cordis context that may carry the service.
 * @returns the plugin command list, empty when the service is absent or
 *   malformed.
 */
export function listPluginCommands(ctx: Context): readonly PluginCommandInfo[] {
  // Cordis proxies ctx property access and throws when a service is absent;
  // the service is optional, so absence must degrade to an empty list.
  let service: CcPluginsService | undefined
  try {
    service = (ctx as { ccPlugins?: CcPluginsService }).ccPlugins
  } catch {
    return []
  }
  if (service === undefined || typeof service.listPluginCommands !== 'function') return []
  const listed = service.listPluginCommands()
  return Array.isArray(listed) ? listed : []
}

/**
 * Look up one plugin command by name (already lowercased by the caller).
 * @param ctx - cordis context that may carry the service.
 * @param name - exact `plugin:command` name, lowercase.
 * @returns the matching info, or `undefined`.
 */
export function findPluginCommand(
  ctx: Context,
  name: string,
): PluginCommandInfo | undefined {
  return listPluginCommands(ctx).find(cmd => cmd.name === name)
}
