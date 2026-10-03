/**
 * enabledPlugins folding helpers shared by the plugin loader (discovery-time
 * cascade fold) and the plugin manager (merged-state reads). IO and error
 * policy stay per-caller: the loader reads synchronously and swallows
 * malformed files; the manager reads async with strict typed errors.
 * @module @dsh-cc/plugin-loader/enabled-plugins
 */

/**
 * Fold a raw `enabledPlugins` block into target, last-wins, no validation.
 * Raw values pass through unchanged (the manager's merged-state semantics).
 */
export function foldEnabledPluginsRaw(target: Record<string, unknown>, block: unknown): void {
  Object.assign(target, block ?? {})
}

/**
 * Fold a settings document's `enabledPlugins` block into target keeping only
 * boolean values, last-wins. When `warn` is provided, keys lacking '@' are
 * dropped with a warning; without `warn` they are kept so the caller can
 * apply its own final drop policy.
 */
export function extractEnabledPluginKeys(target: Record<string, boolean>, block: unknown, warn?: (msg: string) => void): void {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return
  const enabled = (block as Record<string, unknown>)['enabledPlugins']
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return
  for (const [key, value] of Object.entries(enabled)) {
    if (typeof value !== 'boolean') continue
    if (warn !== undefined && !key.includes('@')) {
      warn(`cc-plugin-loader: skipping bare enabledPlugins key "${key}" (expected name@marketplace)`)
      continue
    }
    target[key] = value
  }
}
