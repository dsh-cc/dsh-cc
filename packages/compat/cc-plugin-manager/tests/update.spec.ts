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
import { cleanupTemps, dualDeps, expectError, readJson, rig, snapshotTree, tempDir, type Rig } from './helpers.ts'

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

describe('update (dual-home, S3 §4.4)', () => {
  it('claude-owned install + stale version: new version materializes into the DSH cache; claude tree byte-identical; claude installPath never orphan-marked', async () => {
    const r = await rig()
    const dshHome = await tempDir('pm-dsh-')
    const { writeFile, mkdir } = await import('node:fs/promises')
    // claude-owned install whose recorded version is stale vs the marketplace manifest (1.0.0)
    const claudeCachePath = join(r.cacheDir, 'internal', 'formatter', '0.9.0')
    await mkdir(claudeCachePath, { recursive: true })
    await mkdir(join(r.claudeHome, 'plugins'), { recursive: true })
    await writeFile(r.installedFile, JSON.stringify({ version: 2, plugins: { 'formatter@internal': [{ scope: 'user', installPath: claudeCachePath, version: '0.9.0', installedAt: '2026-09-05T08:00:00.000Z', lastUpdated: '2026-09-05T08:00:00.000Z' }] } }), 'utf8')
    const before = snapshotTree(r.claudeHome)

    const result = await updatePlugin(dualDeps(r, dshHome, { now: NOW }), 'formatter')
    expect(result).toEqual({ upToDate: false, id: 'formatter@internal', fromVersion: '0.9.0', toVersion: '1.0.0', scope: 'user' })

    const dshCachePath = join(dshHome, 'plugins', 'cache', 'internal', 'formatter', '1.0.0')
    expect(existsSync(join(dshCachePath, 'skill.md'))).toBe(true)
    // §3.4/§4.4: the dsh installed file carries the rewritten merged list
    const dshInstalled = await readJson(join(dshHome, 'plugins', 'installed_plugins.json'))
    const entries = dshInstalled.plugins['formatter@internal']
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ scope: 'user', version: '1.0.0', installPath: dshCachePath, installedAt: '2026-09-06T10:00:00.000Z' })
    // W3: old claude-owned installPath untouched, never orphan-marked
    expect(existsSync(claudeCachePath)).toBe(true)
    expect(existsSync(join(claudeCachePath, '.orphaned_at'))).toBe(false)
    expect(snapshotTree(r.claudeHome)).toEqual(before)
  })

  it('a dsh-owned old install dir IS orphan-marked under the dsh cache; claude tree byte-identical (marketplace bump excluded)', async () => {
    const r = await rig()
    const dshHome = await tempDir('pm-dsh-')
    await installPlugin(dualDeps(r, dshHome, { now: NOW }), 'formatter')
    await bump(r, '2.0.0')
    const before = snapshotTree(r.claudeHome)
    await updatePlugin(dualDeps(r, dshHome, { now: NOW }), 'formatter')
    expect(existsSync(join(dshHome, 'plugins', 'cache', 'internal', 'formatter', '1.0.0', '.orphaned_at'))).toBe(true)
    expect(existsSync(join(dshHome, 'plugins', 'cache', 'internal', 'formatter', '2.0.0', 'skill.md'))).toBe(true)
    expect(snapshotTree(r.claudeHome)).toEqual(before)
  })

  it('up-to-date claude-owned install → no-op, no dsh writes', async () => {
    const r = await rig()
    const dshHome = await tempDir('pm-dsh-')
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(r.claudeHome, 'plugins'), { recursive: true })
    await writeFile(r.installedFile, JSON.stringify({ version: 2, plugins: { 'formatter@internal': [{ scope: 'user', installPath: '/x', version: '1.0.0', installedAt: 'x', lastUpdated: 'x' }] } }), 'utf8')
    const before = snapshotTree(r.claudeHome)
    const result = await updatePlugin(dualDeps(r, dshHome, { now: NOW }), 'formatter')
    expect(result).toEqual({ upToDate: true, id: 'formatter@internal', version: '1.0.0', scope: 'user' })
    expect(existsSync(join(dshHome, 'plugins', 'installed_plugins.json'))).toBe(false)
    expect(snapshotTree(r.claudeHome)).toEqual(before)
  })
})
