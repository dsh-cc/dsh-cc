/**
 * enable/disable (plan §2.2 C3): write `enabledPlugins["<id>"] = true|false`
 * into exactly one scope's settings file. The key is kept on disable; the
 * write is allowed even at a scope where the plugin has no install entry.
 * Default scope is auto-detected: the unique scope where the plugin is
 * installed; multiple ⇒ typed error, zero ⇒ not-installed error.
 *
 * @module @dsh-cc/plugin-manager/toggles
 */

import { ambiguousPluginScopes, pluginNotInstalled, unknownScope } from './errors.ts'
import { loadMergedInstalledPlugins, resolutionIds } from './merged-state.ts'
import { settingsFileForScope, type PathInputs } from './paths.ts'
import { loadSettingsFile, saveJsonFileAtomic } from './state-store.ts'
import { resolveInstalledPluginId } from './resolve-id.ts'
import type { Scope, ScopeSettingsFile } from './types.ts'

export interface ToggleOptions {
  scope?: string
}

export interface ToggleResult {
  id: string
  scope: Scope
  enabled: boolean
}

const SCOPES: readonly Scope[] = ['user', 'project', 'local']

/**
 * Determine the target scope: an explicit `--scope` override (validated) or
 * auto-detect over the installed entries (unique scope wins).
 */
async function resolveScope(
  id: string,
  installedScopes: Scope[],
  opts?: ToggleOptions,
): Promise<Scope> {
  if (opts?.scope !== undefined) {
    const scope = opts.scope
    if (!SCOPES.includes(scope as Scope)) throw unknownScope(scope)
    return scope as Scope
  }
  if (installedScopes.length === 0) throw pluginNotInstalled(id)
  if (installedScopes.length > 1) {
    throw ambiguousPluginScopes(id, SCOPES.filter(scope => installedScopes.includes(scope)))
  }
  return installedScopes[0]!
}

/**
 * Core toggle: resolve the id against installed keys, pick the scope, then
 * write `enabledPlugins[id]` into exactly that scope's settings file,
 * preserving all other keys (C11).
 */
export async function togglePlugin(deps: PathInputs, arg: string, enabled: boolean, opts?: ToggleOptions): Promise<ToggleResult> {
  // Auto-detect over the MERGED installed lists (§4.2): an id installed only
  // claude-side is toggleable; the flag lands where the resolved scope's file
  // lives (user → dsh settings, §3.3).
  const merged = await loadMergedInstalledPlugins(deps)
  const id = resolveInstalledPluginId(arg, resolutionIds(merged.file))
  const installedScopes = (merged.file.plugins[id] ?? []).map(entry => entry.scope)
  const scope = await resolveScope(id, installedScopes, opts)
  const settingsFile = settingsFileForScope(scope, deps)
  const settings = await loadSettingsFile(settingsFile)
  const next: ScopeSettingsFile = { ...settings }
  next['enabledPlugins'] = { ...settings['enabledPlugins'], [id]: enabled }
  await saveJsonFileAtomic(settingsFile, next)
  return { id, scope, enabled }
}

/** `enable <idOrName> [--scope s]` core (C3). */
export async function enablePlugin(deps: PathInputs, arg: string, opts?: ToggleOptions): Promise<ToggleResult> {
  return togglePlugin(deps, arg, true, opts)
}

/** `disable <idOrName> [--scope s]` core (C3) — the key is kept with `false`. */
export async function disablePlugin(deps: PathInputs, arg: string, opts?: ToggleOptions): Promise<ToggleResult> {
  return togglePlugin(deps, arg, false, opts)
}
