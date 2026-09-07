/**
 * enabledPlugins writes shared by install/uninstall (plan §2.2 C2/C4):
 * scope-surgical, preserving all other settings keys (C11).
 *
 * @module @dsh-cc/plugin-manager/settings-write
 */

import { settingsFileForScope, type PathInputs } from './paths.ts'
import { loadSettingsFile, saveJsonFileAtomic } from './state-store.ts'
import type { Scope, ScopeSettingsFile } from './types.ts'

/**
 * Set (`true`/`false`) or remove (`null`) the `enabledPlugins[id]` key in
 * exactly one scope's settings file. Removal keeps the `enabledPlugins`
 * object in place even when it becomes empty (C4: an empty
 * `enabledPlugins: {}` object remains).
 */
export async function applyEnabledFlag(deps: PathInputs, scope: Scope, id: string, value: boolean | null): Promise<void> {
  const file = settingsFileForScope(scope, deps)
  const settings = await loadSettingsFile(file)
  const next: ScopeSettingsFile = { ...settings }
  if (value === null) {
    const existing = settings['enabledPlugins']
    if (existing === undefined) return
    const enabled = { ...existing }
    delete enabled[id]
    next['enabledPlugins'] = enabled
  } else {
    next['enabledPlugins'] = { ...settings['enabledPlugins'], [id]: value }
  }
  await saveJsonFileAtomic(file, next)
}
