/**
 * update (C7): version-bump cache layout, per-scope entry rewrite, old-dir
 * orphaning, up-to-date no-op.
 *
 * @module @dsh-cc/plugin-manager/test-update
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installPlugin } from '../src/install.ts'
import { updatePlugin } from '../src/update.ts'
import { PluginManagerError } from '../src/errors.ts'
import { cleanupTemps, expectError, readJson, rig, type Rig } from './helpers.ts'

afterEach(cleanupTemps)

const NOW = () => new Date('2026-09-06T10:00:00.000Z')

function deps(r: Rig): any {
  return { claudeHome: r.claudeHome, cwd: r.cwd, now: NOW }
}

/** Bump the marketplace's formatter to `version`. */
async function bump(r: Rig, version: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(r.marketplaceDir, 'plugins', 'formatter', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'formatter', version }), 'utf8')
}

describe('update (C7)', () => {
  it('version bump materializes the new cache dir alongside the old and rewrites only the targeted entry', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    await installPlugin(deps(r), 'formatter', { scope: 'project' })
    await bump(r, '2.0.0')

    const result = await updatePlugin(deps(r), 'formatter', { scope: 'project' })
    expect(result).toEqual({ upToDate: false, id: 'formatter@internal', fromVersion: '1.0.0', toVersion: '2.0.0', scope: 'project' })

    const oldDir = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
    const newDir = join(r.cacheDir, 'internal', 'formatter', '2.0.0')
    expect(existsSync(oldDir)).toBe(true)
    expect(existsSync(join(newDir, 'skill.md'))).toBe(true)

    const installed = await readJson(r.installedFile)
    const entries = installed.plugins['formatter@internal']
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ scope: 'user', version: '1.0.0', installPath: oldDir })
    expect(entries[1]).toMatchObject({ scope: 'project', version: '2.0.0', installPath: newDir, installedAt: '2026-09-06T10:00:00.000Z', lastUpdated: '2026-09-06T10:00:00.000Z' })
    // old dir still referenced by the user entry → not orphaned
    expect(existsSync(join(oldDir, '.orphaned_at'))).toBe(false)
  })

  it('old dir orphaned when the updated scope was the only reference', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    await bump(r, '2.0.0')
    await updatePlugin(deps(r), 'formatter')
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '1.0.0', '.orphaned_at'))).toBe(true)
  })

  it('up-to-date → no-op flag result, file untouched', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    const before = await readJson(r.installedFile)
    const result = await updatePlugin(deps(r), 'formatter')
    expect(result).toEqual({ upToDate: true, id: 'formatter@internal', version: '1.0.0', scope: 'user' })
    expect(await readJson(r.installedFile)).toEqual(before)
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '2.0.0'))).toBe(false)
  })

  it('no installation at scope → same no-installation-at-scope error', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter', { scope: 'project' })
    const error = await expectError(() => updatePlugin(deps(r), 'formatter'))
    expect((error as PluginManagerError).message).toBe('Plugin "formatter@internal" has no installation at scope user (installed at: project).')
  })

  it('unknown marketplace in the installed id → unknown-marketplace error', async () => {
    const r = await rig()
    const { writeFile } = await import('node:fs/promises')
    await installPlugin(deps(r), 'formatter')
    await writeFile(r.installedFile, JSON.stringify({ version: 2, plugins: { 'formatter@ghost': [{ scope: 'user', installPath: '/x', version: '1.0.0', installedAt: 'x', lastUpdated: 'x' }] } }), 'utf8')
    const error = await expectError(() => updatePlugin(deps(r), 'formatter@ghost'))
    expect((error as PluginManagerError).message).toBe('Unknown marketplace "ghost". Known: internal')
  })

  it('missing marketplace manifest version → toVersion unknown', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    await bump(r, '2.0.0')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(r.marketplaceDir, 'plugins', 'formatter', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'formatter' }), 'utf8')
    const result = await updatePlugin(deps(r), 'formatter')
    expect(result).toMatchObject({ upToDate: false, toVersion: 'unknown' })
  })
})
