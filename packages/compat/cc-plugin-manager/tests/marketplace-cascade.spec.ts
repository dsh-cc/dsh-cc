/**
 * C6 marketplace remove cascade (S4 hook): plugins of the marketplace are
 * uninstalled at all their scopes, with the C5 pre-flight refusing the whole
 * remove before any mutation.
 *
 * @module @dsh-cc/plugin-manager/test-marketplace-cascade
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installPlugin } from '../src/install.ts'
import { removeMarketplace } from '../src/marketplace.ts'
import { disablePlugin } from '../src/toggles.ts'
import { PluginManagerError } from '../src/errors.ts'
import { cleanupTemps, expectError, readJson, rig, type Rig } from './helpers.ts'

afterEach(cleanupTemps)

const NOW = () => new Date('2026-09-06T10:00:00.000Z')

function deps(r: Rig): any {
  return { claudeHome: r.claudeHome, cwd: r.cwd, now: NOW }
}

describe('marketplace remove cascade (C6)', () => {
  it('uninstalls two plugins at mixed scopes, clearing settings keys at all scopes', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    await installPlugin(deps(r), 'linter', { scope: 'project' })
    // C5: the project-scope flag must be disabled before removal can proceed.
    await disablePlugin(deps(r), 'linter', { scope: 'project' })

    const result = await removeMarketplace(deps(r), 'internal')
    expect(result).toEqual({ name: 'internal', removedPlugins: ['formatter@internal', 'linter@internal'] })

    expect(await readJson(r.installedFile)).toEqual({ version: 2, plugins: {} })
    // C4: empty enabledPlugins objects remain after key removal
    expect(await readJson(join(r.claudeHome, 'settings.json'))).toEqual({ enabledPlugins: {} })
    expect(await readJson(join(r.cwd, '.claude', 'settings.json'))).toEqual({ enabledPlugins: {} })
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '1.0.0'))).toBe(true)
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '1.0.0', '.orphaned_at'))).toBe(true)
  })

  it('C5 pre-flight refusal leaves EVERYTHING untouched (project-enabled plugin)', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    await installPlugin(deps(r), 'linter', { scope: 'project' })

    const before = await readJson(r.installedFile)
    const error = await expectError(() => removeMarketplace(deps(r), 'internal'))
    expect((error as PluginManagerError).code).toBe('PLUGIN_ENABLED_AT_PROJECT')
    expect(error.message).toBe('Plugin "linter@internal" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: /plugin disable linter@internal --scope local')
    expect(await readJson(r.installedFile)).toEqual(before)
    expect(await readJson(join(r.claudeHome, 'settings.json'))).toEqual({ enabledPlugins: { 'formatter@internal': true } })
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '1.0.0'))).toBe(true)
  })

  it('marketplace with no installed plugins → empty removedPlugins, known key still removed', async () => {
    const r = await rig()
    const result = await removeMarketplace(deps(r), 'internal')
    expect(result).toEqual({ name: 'internal', removedPlugins: [] })
    expect(await readJson(r.knownFile)).toEqual({})
  })
})
