/**
 * §4.C injected-failure invariants: saveJsonFileAtomic failures at each
 * commit step must leave state consistent (no partial commits, no deleted
 * cache dirs). Uses vi.mock to inject failures into the state-store seam.
 *
 * @module @dsh-cc/plugin-manager/test-commit-order
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const failureState = vi.hoisted(() => ({ failFor: null as null | ((file: string) => boolean) }))

vi.mock('../src/state-store.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/state-store.ts')>()
  return {
    ...actual,
    saveJsonFileAtomic: async (file: string, value: unknown) => {
      if (failureState.failFor?.(file)) throw new Error('injected save failure')
      return actual.saveJsonFileAtomic(file, value)
    },
  }
})

import { installPlugin } from '../src/install.ts'
import { uninstallPlugin } from '../src/uninstall.ts'
import { cleanupTemps, expectError, readJson, rig, type Rig } from './helpers.ts'

afterEach(() => {
  failureState.failFor = null
  return cleanupTemps()
})

const NOW = () => new Date('2026-09-06T10:00:00.000Z')

function deps(r: Rig): any {
  return { claudeHome: r.claudeHome, cwd: r.cwd, now: NOW }
}

describe('§4.C install commit order', () => {
  it('step 1 failure (cache copy) → no settings or installed mutation', async () => {
    const r = await rig()
    const { mkdir, writeFile } = await import('node:fs/promises')
    // make `<cacheDir>/internal` a file so the recursive copy fails
    await mkdir(r.cacheDir, { recursive: true })
    await writeFile(join(r.cacheDir, 'internal'), 'not a dir', 'utf8')
    await expectError(() => installPlugin(deps(r), 'formatter'))
    expect(existsSync(r.installedFile)).toBe(false)
    expect(existsSync(join(r.claudeHome, 'settings.json'))).toBe(false)
  })

  it('step 2 failure (settings save) → cache dir exists, no installed entry, settings untouched', async () => {
    const r = await rig()
    failureState.failFor = file => file === join(r.claudeHome, 'settings.json')
    await expectError(() => installPlugin(deps(r), 'formatter'))
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '1.0.0', 'skill.md'))).toBe(true)
    expect(existsSync(r.installedFile)).toBe(false)
  })

  it('step 3 failure (installed save) → enabled flag + cache written, no installed entry (benign residue)', async () => {
    const r = await rig()
    failureState.failFor = file => file === r.installedFile
    await expectError(() => installPlugin(deps(r), 'formatter'))
    expect(await readJson(join(r.claudeHome, 'settings.json'))).toEqual({ enabledPlugins: { 'formatter@internal': true } })
    expect(existsSync(join(r.cacheDir, 'internal', 'formatter', '1.0.0'))).toBe(true)
    expect(existsSync(r.installedFile)).toBe(false)
  })
})

describe('§4.C uninstall commit order', () => {
  it('installed save failure → flag removed, entry intact, cache dir never deleted, no marker', async () => {
    const r = await rig()
    const cachePath = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
    await installPlugin(deps(r), 'formatter')
    failureState.failFor = file => file === r.installedFile
    await expectError(() => uninstallPlugin(deps(r), 'formatter'))
    expect(await readJson(join(r.claudeHome, 'settings.json'))).toEqual({ enabledPlugins: {} })
    expect(await readJson(r.installedFile).then(data => data.plugins['formatter@internal'])).toHaveLength(1)
    expect(statSync(cachePath).isDirectory()).toBe(true)
    expect(existsSync(join(cachePath, '.orphaned_at'))).toBe(false)
  })
})
