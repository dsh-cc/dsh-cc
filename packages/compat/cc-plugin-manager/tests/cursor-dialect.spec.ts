/**
 * S6 — manager dialect: marketplace add/update/install/enable/disable/
 * update/uninstall over a directory marketplace repo laid out in Cursor
 * style (`.cursor-plugin/marketplace.json`, plugin dirs holding
 * `.cursor-plugin/plugin.json` + components), via the shared candidate-dir
 * helpers from `@dsh-cc/plugin-loader`. State-file byte shapes are asserted
 * invariant (snapshotTree + C1/v2 shapes); the materialized install tree
 * must keep its `.cursor-plugin` manifest intact for the loader.
 *
 * @module @dsh-cc/plugin-manager/test-cursor-dialect
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMarketplace, listMarketplaces, updateMarketplaces } from '../src/marketplace.ts'
import { installPlugin, readPluginManifest } from '../src/install.ts'
import { enablePlugin, disablePlugin } from '../src/toggles.ts'
import { uninstallPlugin } from '../src/uninstall.ts'
import { updatePlugin } from '../src/update.ts'
import { snapshotTree } from './helpers.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** deps for the pure core: claude read home, dsh write home, shared cwd. */
function deps(claudeHome: string, dshHome: string, cwd: string): any {
  return { claudeHome, dshHome, cwd }
}

/** A cursor-layout marketplace repo: repo-level `.cursor-plugin/marketplace.json`
 * listing one plugin whose source dir holds `.cursor-plugin/plugin.json` +
 * a skill. Returns the marketplace dir and the plugin source dir. */
async function cursorMarketplace(): Promise<{ dir: string, pluginDir: string }> {
  const dir = await tempDir('pm-s6-mkt-')
  await mkdir(join(dir, '.cursor-plugin'), { recursive: true })
  await writeFile(
    join(dir, '.cursor-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'cursor-mkt', plugins: [{ name: 'alpha', source: 'plugins/alpha' }] }),
    'utf8',
  )
  const pluginDir = join(dir, 'plugins', 'alpha')
  await mkdir(join(pluginDir, '.cursor-plugin'), { recursive: true })
  await mkdir(join(pluginDir, 'skills', 'greet'), { recursive: true })
  await writeFile(join(pluginDir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }), 'utf8')
  await writeFile(
    join(pluginDir, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: "says hi"\n---\n\nhello from alpha',
    'utf8',
  )
  return { dir, pluginDir }
}

/** Full rig: empty dsh write home + the cursor marketplace under an external path. */
async function rig(): Promise<{ claudeHome: string, dshHome: string, cwd: string, mkt: string, pluginDir: string }> {
  const claudeHome = await tempDir('pm-s6-home-')
  const dshHome = await tempDir('pm-s6-dsh-')
  const cwd = await tempDir('pm-s6-cwd-')
  const { dir, pluginDir } = await cursorMarketplace()
  return { claudeHome, dshHome, cwd, mkt: dir, pluginDir }
}

describe('S6 manager cursor dialect', () => {
  it('marketplace add with a directory source reads .cursor-plugin/marketplace.json', async () => {
    const r = await rig()
    const added = await addMarketplace(deps(r.claudeHome, r.dshHome, r.cwd), r.mkt)
    expect(added).toEqual({ name: 'cursor-mkt', sourceKind: 'directory', pluginCount: 1 })
    expect(listMarketplaces(deps(r.claudeHome, r.dshHome, r.cwd)).then(rows => rows.map(r => r.name))).resolves.toEqual(['cursor-mkt'])
   })
  it('marketplace update re-validates the cursor manifest', async () => {
    const r = await rig()
    await addMarketplace(deps(r.claudeHome, r.dshHome, r.cwd), r.mkt)
    await expect(updateMarketplaces(deps(r.claudeHome, r.dshHome, r.cwd), 'cursor-mkt')).resolves.toEqual(['cursor-mkt'])
  })

  it('install + enable over the cursor marketplace: cache keeps .cursor-plugin intact, claude home byte-invariant', async () => {
    const r = await rig()
    await addMarketplace(deps(r.claudeHome, r.dshHome, r.cwd), r.mkt)
    const before = snapshotTree(r.claudeHome)
    const result = await installPlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha@cursor-mkt')
    const cacheRoot = join(r.dshHome, 'plugins', 'cache', 'cursor-mkt', 'alpha', '1.0.0')
    expect(result).toEqual({ id: 'alpha@cursor-mkt', version: '1.0.0', scope: 'user', installPath: cacheRoot })
    // The claude home (read side) is byte-identical after the mutation.
    expect(snapshotTree(r.claudeHome)).toEqual(before)
    // The installed tree keeps its cursor manifest intact for the loader.
    expect(existsSync(join(cacheRoot, '.cursor-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(cacheRoot, 'skills', 'greet', 'SKILL.md'))).toBe(true)
    // installed_plugins.json keeps its v2 byte shape (no new keys).
    const installed = JSON.parse(await readFile(join(r.dshHome, 'plugins', 'installed_plugins.json'), 'utf8')) as any
    expect(Object.keys(installed)).toEqual(['version', 'plugins'])
    expect(installed.version).toBe(2)
    expect(Object.keys(installed.plugins)).toEqual(['alpha@cursor-mkt'])
    expect(Object.keys(installed.plugins['alpha@cursor-mkt'][0]).sort()).toEqual(
      ['installPath', 'installedAt', 'lastUpdated', 'scope', 'version'].sort())
  })

  it('disable + enable land in the dsh write root', async () => {
    const r = await rig()
    await addMarketplace(deps(r.claudeHome, r.dshHome, r.cwd), r.mkt)
    await installPlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha@cursor-mkt')
    const disabled = await disablePlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha')
    expect(disabled).toEqual({ id: 'alpha@cursor-mkt', scope: 'user', enabled: false })
    const enabled = await enablePlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha')
    expect(enabled).toEqual({ id: 'alpha@cursor-mkt', scope: 'user', enabled: true })
   })

  it('update materializes a bumped version while the old tree keeps its manifest', async () => {
    const r = await rig()
    await addMarketplace(deps(r.claudeHome, r.dshHome, r.cwd), r.mkt)
    await installPlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha@cursor-mkt')
    // Bump the version in the source plugin dir.
    await writeFile(join(r.pluginDir, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', version: '2.0.0' }), 'utf8')
    const result = await updatePlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha')
    expect(result).toEqual({ upToDate: false, id: 'alpha@cursor-mkt', fromVersion: '1.0.0', toVersion: '2.0.0', scope: 'user' })
    const newRoot = join(r.dshHome, 'plugins', 'cache', 'cursor-mkt', 'alpha', '2.0.0')
    expect(existsSync(join(newRoot, '.cursor-plugin', 'plugin.json'))).toBe(true)
  })

  it('uninstall removes the installed entry and the tree keeps its manifest until deletion', async () => {
    const r = await rig()
    await addMarketplace(deps(r.claudeHome, r.dshHome, r.cwd), r.mkt)
    await installPlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha@cursor-mkt')
    const before = snapshotTree(r.claudeHome)
    const result = await uninstallPlugin(deps(r.claudeHome, r.dshHome, r.cwd), 'alpha')
    expect(result.id).toBe('alpha@cursor-mkt')
    expect(snapshotTree(r.claudeHome)).toEqual(before)
    const installed = JSON.parse(await readFile(join(r.dshHome, 'plugins', 'installed_plugins.json'), 'utf8')) as any
    // Dual-home materialization-on-write (§3.4): the id stays as an empty
    // dsh-side list shadowing the (absent) claude id.
    expect(installed.plugins['alpha@cursor-mkt']).toEqual([])
  })

  it('readPluginManifest records flavor cursor for cursor-layout dirs', async () => {
    const r = await rig()
    const manifest = await readPluginManifest(r.pluginDir, 'alpha')
    expect(manifest).toMatchObject({ name: 'alpha', version: '1.0.0', flavor: 'cursor' })
  })
})
