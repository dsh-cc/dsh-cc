/**
 * Installed-plugin listing (plan §2.2 C9): one row per installed entry,
 * with effective enablement = first DEFINED boolean scanning local →
 * project → user (absent everywhere ⇒ disabled), an override note when
 * defined scopes disagree, and cwd visibility filtering — user-scope
 * entries always; project/local entries only when their `projectPath`
 * realpaths to the session cwd (entries missing `projectPath` are treated
 * user-scope).
 *
 * @module @dsh-cc/plugin-manager/list
 */

import { settingsFileForScope, canonicalizeExistingPath, type PathInputs } from './paths.ts'
import { loadMergedInstalledPlugins, loadMergedUserEnabledPlugins } from './merged-state.ts'
import { loadSettingsFile } from './state-store.ts'
import type { EnabledPlugins, Scope, ScopeSettingsFile } from './types.ts'

export interface PluginListEntry {
  id: string
  version: string
  scope: Scope
  installPath: string
  installedAt: string
  lastUpdated: string
  projectPath?: string
  effectiveEnabled: boolean
  enabledByScope: { user?: boolean; project?: boolean; local?: boolean }
  overrideNote?: string
}

const SCOPES: readonly Scope[] = ['user', 'project', 'local']

/** Effective enablement per C9: scan local → project → user, first DEFINED boolean wins; absent everywhere ⇒ false. */
function effectiveEnabled(enabledByScope: { user?: boolean; project?: boolean; local?: boolean }): boolean {
  for (const scope of [...SCOPES].reverse()) {
    const value = enabledByScope[scope]
    if (value !== undefined) return value
  }
  return false
}

/** Override note exists iff defined values disagree across scopes: `user=false, project=true` style. */
function overrideNote(enabledByScope: { user?: boolean; project?: boolean; local?: boolean }): string | undefined {
  const defined = SCOPES
    .map(scope => ({ scope, value: enabledByScope[scope] }))
    .filter((item): item is { scope: Scope; value: boolean } => item.value !== undefined)
  if (defined.length <= 1) return undefined
  const first = defined[0]!.value
  if (defined.every(item => item.value === first)) return undefined
  return defined.map(item => `${item.scope}=${item.value}`).join(', ')
}

/** Visibility: user-scope entries always; project/local only when `projectPath` realpaths to cwd. */
function isVisible(entryScope: Scope, entryProjectPath: string | undefined, canonicalCwd: string): boolean {
  if (entryScope === 'user') return true
  if (entryProjectPath === undefined) return true
  try {
    return canonicalizeExistingPath(entryProjectPath) === canonicalCwd
  } catch {
    return false
  }
}

/**
 * List installed plugins visible from `cwd`, one row per install entry,
 * with C9 effective enablement and per-scope enablement maps.
 */
export async function listInstalled(deps: PathInputs): Promise<PluginListEntry[]> {
  // Merged installed map (§3.4): a dsh entry list — including empty — shadows
  // the claude list per id; empty-list ids contribute no rows.
  const installed = (await loadMergedInstalledPlugins(deps)).file
  const canonicalCwd = canonicalizeExistingPath(deps.cwd)

  // User slot = merged user value (§3.3: dsh ?? claude per key); project/local
  // scope files are unchanged per-repo Claude-Code parity surfaces.
  const scopeSettings = new Map<Scope, EnabledPlugins>()
  scopeSettings.set('user', await loadMergedUserEnabledPlugins(deps))
  for (const scope of ['project', 'local'] as const) {
    const settings: ScopeSettingsFile = await loadSettingsFile(settingsFileForScope(scope, deps))
    scopeSettings.set(scope, settings['enabledPlugins'] ?? {})
  }

  const rows: PluginListEntry[] = []
  for (const [id, entries] of Object.entries(installed.plugins)) {
    const enabledByScope: { user?: boolean; project?: boolean; local?: boolean } = {}
    for (const scope of SCOPES) {
      const value = scopeSettings.get(scope)![id]
      if (value !== undefined) enabledByScope[scope] = value
    }
    for (const entry of entries) {
      if (!isVisible(entry.scope, entry.projectPath, canonicalCwd)) continue
      const row: PluginListEntry = {
        id,
        version: entry.version,
        scope: entry.scope,
        installPath: entry.installPath,
        installedAt: entry.installedAt,
        lastUpdated: entry.lastUpdated,
        effectiveEnabled: effectiveEnabled(enabledByScope),
        enabledByScope,
      }
      if (entry.projectPath !== undefined) row.projectPath = entry.projectPath
      const note = overrideNote(enabledByScope)
      if (note !== undefined) row.overrideNote = note
      rows.push(row)
    }
  }
  return rows
}
