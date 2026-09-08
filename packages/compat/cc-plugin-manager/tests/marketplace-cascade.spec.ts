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
import { cleanupTemps, dualDeps, expectError, readJson, rig, snapshotTree, tempDir, type Rig } from './helpers.ts'

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

describe('marketplace remove cascade (dual-home, S4 §4.6)', () => {
  it('claude-installed plugins are cascade-uninstalled per §4.3: dsh shadow, claude byte-identical, orphan markers only under the dsh cache', async () => {
    const r = await rig()
    const dshHome = await tempDir('pm-dsh-')
    // seed a claude-owned install of formatter (cache copy inside the claude home)
    const { writeFile, mkdir } = await import('node:fs/promises')
    const claudeCachePath = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
    await mkdir(join(claudeCachePath, '.claude-plugin'), { recursive: true })
    await writeFile(join(claudeCachePath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'formatter', version: '1.0.0' }), 'utf8')
    await mkdir(join(r.claudeHome, 'plugins'), { recursive: true })
    await writeFile(r.installedFile, JSON.stringify({ version: 2, plugins: { 'formatter@internal': [{ scope: 'user', installPath: claudeCachePath, version: '1.0.0', installedAt: '2026-09-05T08:00:00.000Z', lastUpdated: '2026-09-05T08:00:00.000Z' }] } }), 'utf8')
    await writeFile(join(r.claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'formatter@internal': true } }, null, 2) + '\n', 'utf8')
    const before = snapshotTree(r.claudeHome)

    const result = await removeMarketplace(dualDeps(r, dshHome, { now: NOW }), 'internal')
    expect(result).toEqual({ name: 'internal', removedPlugins: ['formatter@internal'] })

    // dsh shadow: empty list materialized
    const dshInstalled = await readJson(join(dshHome, 'plugins', 'installed_plugins.json'))
    expect(dshInstalled.plugins['formatter@internal']).toEqual([])
    // §4.3 conditional shadow in the dsh user file
    expect((await readJson(join(dshHome, 'settings.json')))['enabledPlugins']).toEqual({ 'formatter@internal': false })
    // dsh tombstone
    const dshKnown = await readJson(join(dshHome, 'plugins', 'known_marketplaces.json'))
    expect(dshKnown['internal']).toBeNull()
    // W1/W3/W4: the claude home (installed file, settings, cache dir incl. no orphan marker) is byte-identical
    expect(snapshotTree(r.claudeHome)).toEqual(before)
    expect(existsSync(claudeCachePath)).toBe(true)
  })

  it('dsh-owned installs of the removed marketplace are uninstalled with orphan markers under the dsh cache', async () => {
    const r = await rig()
    const dshHome = await tempDir('pm-dsh-')
    await installPlugin(dualDeps(r, dshHome, { now: NOW }), 'formatter')
    const before = snapshotTree(r.claudeHome)

    const result = await removeMarketplace(dualDeps(r, dshHome, { now: NOW }), 'internal')
    expect(result).toEqual({ name: 'internal', removedPlugins: ['formatter@internal'] })
    expect(existsSync(join(dshHome, 'plugins', 'cache', 'internal', 'formatter', '1.0.0', '.orphaned_at'))).toBe(true)
    const dshKnown = await readJson(join(dshHome, 'plugins', 'known_marketplaces.json'))
    expect(dshKnown['internal']).toBeNull()
    expect(snapshotTree(r.claudeHome)).toEqual(before)
  })
})
