/**
 * S2 merged readers (plan §3.2–§3.5): per-key dsh-wins over the two homes;
 * dsh `null` tombstones a claude marketplace entry; a dsh entry list —
 * including an empty one — shadows the claude list per plugin id; per-key
 * origin tracking; single-root dedupe.
 *
 * @module @dsh-cc/plugin-manager/merged-state
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadMergedInstalledPlugins,
  loadMergedKnownMarketplaces,
  loadMergedUserEnabledPlugins,
  resolutionIds,
} from '../src/merged-state.ts'
import type { InstallEntry, KnownMarketplaceEntry } from '../src/types.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

function entry(name: string, installLocation = `/mkts/${name}`): KnownMarketplaceEntry {
  return { source: { source: 'github', repo: `acme/${name}` }, installLocation, lastUpdated: '2026-09-06T09:00:00.000Z' }
}

function install(scope: 'user' | 'project', path: string, lastUpdated = '2026-09-06T10:00:00.000Z'): InstallEntry {
  return { scope, installPath: path, version: '1.0.0', installedAt: '2026-09-06T10:00:00.000Z', lastUpdated }
}

describe('loadMergedKnownMarketplaces', () => {
  it('dsh entries win per name; claude-only names pass through with origin', async () => {
    const claudeHome = await tempDir('ms-kc-')
    const dshHome = await tempDir('ms-kd-')
    await writeJson(join(claudeHome, 'plugins', 'known_marketplaces.json'), { alpha: entry('alpha'), beta: entry('beta') })
    await writeJson(join(dshHome, 'plugins', 'known_marketplaces.json'), { beta: entry('beta', '/dsh/mkts/beta') })
    const merged = await loadMergedKnownMarketplaces({ claudeHome, dshHome, cwd: claudeHome })
    expect(merged.entries['alpha']!.installLocation).toBe('/mkts/alpha')
    expect(merged.entries['beta']!.installLocation).toBe('/dsh/mkts/beta')
    expect(merged.origin).toEqual({ alpha: 'claude', beta: 'dsh' })
  })

  it('a dsh null tombstone removes the name from the merged view', async () => {
    const claudeHome = await tempDir('ms-tc-')
    const dshHome = await tempDir('ms-td-')
    await writeJson(join(claudeHome, 'plugins', 'known_marketplaces.json'), { alpha: entry('alpha') })
    await writeJson(join(dshHome, 'plugins', 'known_marketplaces.json'), { alpha: null })
    const merged = await loadMergedKnownMarketplaces({ claudeHome, dshHome, cwd: claudeHome })
    expect(merged.entries).toEqual({})
    expect(merged.origin).toEqual({})
  })

  it('single-root mode reads only the one home', async () => {
    const home = await tempDir('ms-ks-')
    await writeJson(join(home, 'plugins', 'known_marketplaces.json'), { alpha: entry('alpha') })
    const merged = await loadMergedKnownMarketplaces({ claudeHome: home, cwd: home })
    expect(merged.entries['alpha']).toEqual(entry('alpha'))
    expect(merged.origin).toEqual({ alpha: 'dsh' })
  })
})

describe('loadMergedInstalledPlugins', () => {
  it('a dsh entry list shadows the claude list per id (origin dsh)', async () => {
    const claudeHome = await tempDir('ms-ic-')
    const dshHome = await tempDir('ms-id-')
    await writeJson(join(claudeHome, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'a@mp': [install('user', '/claude/cache/a')], 'b@mp': [install('user', '/claude/cache/b')] },
    })
    await writeJson(join(dshHome, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'b@mp': [install('user', '/dsh/cache/b')] },
    })
    const merged = await loadMergedInstalledPlugins({ claudeHome, dshHome, cwd: claudeHome })
    expect(merged.file.plugins['a@mp']![0]!.installPath).toBe('/claude/cache/a')
    expect(merged.file.plugins['b@mp']![0]!.installPath).toBe('/dsh/cache/b')
    expect(merged.origin).toEqual({ 'a@mp': 'claude', 'b@mp': 'dsh' })
  })

  it('an empty dsh entry list shadows claude and drops the id from the resolution view', async () => {
    const claudeHome = await tempDir('ms-ec-')
    const dshHome = await tempDir('ms-ed-')
    await writeJson(join(claudeHome, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'a@mp': [install('user', '/claude/cache/a')], 'keep@mp': [install('user', '/claude/cache/k')] },
    })
    await writeJson(join(dshHome, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'a@mp': [] },
    })
    const merged = await loadMergedInstalledPlugins({ claudeHome, dshHome, cwd: claudeHome })
    expect(merged.file.plugins['a@mp']).toEqual([])
    expect(merged.file.plugins['keep@mp']).toHaveLength(1)
    expect(resolutionIds(merged.file)).toEqual(['keep@mp'])
  })

  it('single-root mode reads only the one home', async () => {
    const home = await tempDir('ms-is-')
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'a@mp': [install('user', '/claude/cache/a')] },
    })
    const merged = await loadMergedInstalledPlugins({ claudeHome: home, cwd: home })
    expect(Object.keys(merged.file.plugins)).toEqual(['a@mp'])
  })
})

describe('loadMergedUserEnabledPlugins', () => {
  it('merges claude → dsh with dsh winning per key (false masks true)', async () => {
    const claudeHome = await tempDir('ms-uc-')
    const dshHome = await tempDir('ms-ud-')
    await writeJson(join(claudeHome, 'settings.json'), { enabledPlugins: { 'a@mp': true, 'b@mp': true } })
    await writeJson(join(dshHome, 'settings.json'), { enabledPlugins: { 'a@mp': false, 'c@mp': true } })
    const merged = await loadMergedUserEnabledPlugins({ claudeHome, dshHome, cwd: claudeHome })
    expect(merged).toEqual({ 'a@mp': false, 'b@mp': true, 'c@mp': true })
  })

  it('single-root mode dedupes to one read', async () => {
    const home = await tempDir('ms-us-')
    await writeJson(join(home, 'settings.json'), { enabledPlugins: { 'a@mp': true } })
    expect(await loadMergedUserEnabledPlugins({ claudeHome: home, cwd: home })).toEqual({ 'a@mp': true })
  })
})
