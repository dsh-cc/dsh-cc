/**
 * uninstall (C4/C5): scope-surgical entry+flag removal, `.orphaned_at` only
 * when unreferenced, C5 project-scope guard.
 *
 * @module @dsh-cc/plugin-manager/test-uninstall
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installPlugin } from '../src/install.ts'
import { uninstallPlugin } from '../src/uninstall.ts'
import { disablePlugin } from '../src/toggles.ts'
import { PluginManagerError } from '../src/errors.ts'
import { cleanupTemps, expectError, readJson, rig, tempDir, type Rig } from './helpers.ts'

afterEach(cleanupTemps)

const NOW = () => new Date('2026-09-06T10:00:00.000Z')

function deps(r: Rig): any {
  return { claudeHome: r.claudeHome, cwd: r.cwd, now: NOW }
}

/** Install a plugin whose cache copy is pre-seeded: returns the rig + cache path. */
async function installedRig(scope: 'user' | 'project' | 'local' = 'user'): Promise<{ r: Rig, cachePath: string }> {
  const r = await rig()
  const cachePath = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
  await installPlugin(deps(r), 'formatter', { scope })
  return { r, cachePath }
}

describe('uninstall (C4)', () => {
  it('removes the flag (empty object kept) and the entry; drops the id key when the array empties', async () => {
    const { r, cachePath } = await installedRig()
    const result = await uninstallPlugin(deps(r), 'formatter')
    expect(result).toEqual({ id: 'formatter@internal', scope: 'user' })
    expect(await readJson(join(r.claudeHome, 'settings.json'))).toEqual({ enabledPlugins: {} })
    expect(await readJson(r.installedFile)).toEqual({ version: 2, plugins: {} })
    expect(existsSync(join(cachePath, '.orphaned_at'))).toBe(true)
    expect(existsSync(cachePath)).toBe(true)
  })

  it('`.orphaned_at` contains epoch millis as ASCII, no newline, from injected now', async () => {
    const { r, cachePath } = await installedRig()
    await uninstallPlugin(deps(r), 'formatter')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(cachePath, '.orphaned_at'), 'utf8')).toBe(String(new Date('2026-09-06T10:00:00.000Z').getTime()))
  })

  it('keeps the OTHER scope entry + settings untouched; no marker while the path is still referenced', async () => {
    const r = await rig()
    const cachePath = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
    await installPlugin(deps(r), 'formatter')
    await installPlugin(deps(r), 'formatter', { scope: 'project' })
    // C5 workflow: the project-scope flag must be disabled before uninstalling.
    await disablePlugin(deps(r), 'formatter', { scope: 'project' })
    await uninstallPlugin(deps(r), 'formatter', { scope: 'project' })

    const installed = await readJson(r.installedFile)
    expect(installed.plugins['formatter@internal']).toHaveLength(1)
    expect(installed.plugins['formatter@internal'][0]['scope']).toBe('user')
    // the project flag was removed by the uninstall; empty object remains (C4)
    expect(await readJson(join(r.cwd, '.claude', 'settings.json'))).toEqual({ enabledPlugins: {} })
    expect(await readJson(join(r.claudeHome, 'settings.json'))).toEqual({ enabledPlugins: { 'formatter@internal': true } })
    expect(existsSync(join(cachePath, '.orphaned_at'))).toBe(false)
  })

  it('second uninstall of a shared path (last reference gone) writes the marker', async () => {
    const r = await rig()
    const cachePath = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
    await installPlugin(deps(r), 'formatter')
    await installPlugin(deps(r), 'formatter', { scope: 'project' })
    await disablePlugin(deps(r), 'formatter', { scope: 'project' })
    await uninstallPlugin(deps(r), 'formatter', { scope: 'project' })
    await uninstallPlugin(deps(r), 'formatter', { scope: 'user' })
    expect(existsSync(join(cachePath, '.orphaned_at'))).toBe(true)
  })

  it('no entry at that scope → exact error with canonical scope list', async () => {
    const { r } = await installedRig('project')
    const error = await expectError(() => uninstallPlugin(deps(r), 'formatter'))
    expect((error as PluginManagerError).message).toBe('Plugin "formatter@internal" has no installation at scope user (installed at: project).')
  })

  it('key present with an empty entries array → installed at: none', async () => {
    const r = await rig()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(r.installedFile, JSON.stringify({ version: 2, plugins: { 'formatter@internal': [] } }), 'utf8')
    const error = await expectError(() => uninstallPlugin(deps(r), 'formatter@internal'))
    expect((error as PluginManagerError).message).toBe('Plugin "formatter@internal" has no installation at scope user (installed at: none).')
  })

  it('C5 guard: enabled at project scope → exact refusal, nothing mutated', async () => {
    const { r, cachePath } = await installedRig('project')
    const before = await readJson(r.installedFile)
    const error = await expectError(() => uninstallPlugin(deps(r), 'formatter', { scope: 'project' }))
    expect(error.message).toBe('Plugin "formatter@internal" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: /plugin disable formatter@internal --scope local')
    expect(await readJson(r.installedFile)).toEqual(before)
    expect(existsSync(join(cachePath, '.orphaned_at'))).toBe(false)
  })

  it('C5 refusal applies even when targeting user scope while project settings enable the plugin', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter', { scope: 'project' })
    await installPlugin(deps(r), 'formatter')
    const error = await expectError(() => uninstallPlugin(deps(r), 'formatter'))
    expect((error as PluginManagerError).code).toBe('PLUGIN_ENABLED_AT_PROJECT')
  })

  it('invalid scope → exact error', async () => {
    const { r } = await installedRig()
    const error = await expectError(() => uninstallPlugin(deps(r), 'formatter', { scope: 'repo' }))
    expect((error as PluginManagerError).message).toBe('Unknown scope "repo". Expected user, project, or local.')
  })

  it('nonexistent installPath → orphan marker skipped without crashing', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(r.installedFile, JSON.stringify({ version: 2, plugins: { 'formatter@internal': [{ scope: 'user', installPath: '/nonexistent/pm-path', version: '1.0.0', installedAt: 'x', lastUpdated: 'x' }] } }), 'utf8')
    const result = await uninstallPlugin(deps(r), 'formatter')
    expect(result.id).toBe('formatter@internal')
  })
})
