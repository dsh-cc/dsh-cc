import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disablePlugin, enablePlugin } from '../src/toggles.ts'
import { createCcPluginManager } from '../src/index.ts'
import { PluginManagerError } from '../src/errors.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

interface Rig {
  claudeHome: string
  cwd: string
}

async function rig(): Promise<Rig> {
  const claudeHome = await tempDir('pm-tgl-home-')
  const cwd = await tempDir('pm-tgl-cwd-')
  await mkdir(join(claudeHome, 'plugins'), { recursive: true })
  await writeFile(
    join(claudeHome, 'plugins', 'installed_plugins.json'),
    JSON.stringify(
      {
        version: 2,
        plugins: {
          'formatter@internal': [
            { scope: 'user', installPath: '/p/cache/f/1.0.0', version: '1.0.0', installedAt: '2026-09-05T08:10:00.000Z', lastUpdated: '2026-09-05T08:10:00.000Z' },
          ],
          'multi@internal': [
            { scope: 'user', installPath: '/p/cache/m/1.0.0', version: '1.0.0', installedAt: '2026-09-05T08:10:00.000Z', lastUpdated: '2026-09-05T08:10:00.000Z' },
            { scope: 'project', installPath: '/p/cache/m/1.0.0', version: '1.0.0', installedAt: '2026-09-05T08:11:00.000Z', lastUpdated: '2026-09-05T08:11:00.000Z', projectPath: cwd },
          ],
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  return { claudeHome, cwd }
}

async function userSettings(r: Rig): Promise<any> {
  const raw = await readFile(join(r.claudeHome, 'settings.json'), 'utf8')
  return JSON.parse(raw)
}

async function idOf(fn: () => Promise<unknown>): Promise<PluginManagerError> {
  return fn().then(
    () => {
      throw new Error('expected to throw')
    },
    error => error as PluginManagerError,
  )
}

describe('enable/disable (C3)', () => {
  it('disable auto-detects the unique installed scope and keeps the key with false', async () => {
    const r = await rig()
    const result = await disablePlugin(r, 'formatter')
    expect(result).toEqual({ id: 'formatter@internal', scope: 'user', enabled: false })
    const settings = await userSettings(r)
    expect(settings['enabledPlugins']).toEqual({ 'formatter@internal': false })
    expect(Object.keys(settings)).toEqual(['enabledPlugins'])
  })

  it('enable writes true at the resolved scope', async () => {
    const r = await rig()
    expect(await enablePlugin(r, 'formatter@internal')).toEqual({ id: 'formatter@internal', scope: 'user', enabled: true })
    expect((await userSettings(r))['enabledPlugins']).toEqual({ 'formatter@internal': true })
  })

  it('explicit --scope override wins over auto-detect and is allowed without an install entry', async () => {
    const r = await rig()
    const result = await enablePlugin(r, 'formatter', { scope: 'local' })
    expect(result).toEqual({ id: 'formatter@internal', scope: 'local', enabled: true })
    const localRaw = await readFile(join(r.cwd, '.claude', 'settings.local.json'), 'utf8')
    expect(JSON.parse(localRaw)).toEqual({ enabledPlugins: { 'formatter@internal': true } })
  })

  it('other settings keys survive toggles (C11)', async () => {
    const r = await rig()
    await writeFile(
      join(r.claudeHome, 'settings.json'),
      JSON.stringify({ enabledPlugins: {}, statusLine: { type: 'command', command: 'dsh statusline' }, zIndex: 3 }, null, 2) + '\n',
      'utf8',
    )
    await disablePlugin(r, 'formatter', { scope: 'user' })
    const settings = await userSettings(r)
    expect(Object.keys(settings)).toEqual(['enabledPlugins', 'statusLine', 'zIndex'])
    expect(settings['statusLine']).toEqual({ type: 'command', command: 'dsh statusline' })
    expect(settings['enabledPlugins']).toEqual({ 'formatter@internal': false })
  })

  it('auto-detect with multiple installed scopes → exact error', async () => {
    const r = await rig()
    const error = await idOf(() => disablePlugin(r, 'multi@internal'))
    expect(error).toBeInstanceOf(PluginManagerError)
    expect(error.message).toBe('Plugin "multi@internal" is installed at multiple scopes (user, project); pass --scope.')
  })

  it('auto-detect with zero installed scopes → exact error', async () => {
    const r = await rig()
    const error = await idOf(() => enablePlugin(r, 'ghost@nowhere'))
    expect(error.message).toBe('Plugin "ghost@nowhere" is not installed.')
  })

  it('invalid scope → exact error', async () => {
    const r = await rig()
    const error = await idOf(() => enablePlugin(r, 'formatter', { scope: 'repo' }))
    expect(error.message).toBe('Unknown scope "repo". Expected user, project, or local.')
  })

  it('unknown plugin → resolution catalog string', async () => {
    const r = await rig()
    const error = await idOf(() => enablePlugin(r, 'nope'))
    expect(error.message).toBe('Unknown plugin "nope". Installed: formatter@internal, multi@internal')
  })

  it('two concurrent disables land one consistent file (queue serialization smoke)', async () => {
    const r = await rig()
    const manager = createCcPluginManager({ claudeHome: r.claudeHome, cwd: r.cwd })
    await Promise.all([
      manager.disable('formatter', { scope: 'user' }),
      manager.disable('formatter@internal', { scope: 'user' }),
    ])
    const settings = await userSettings(r)
    expect(settings['enabledPlugins']).toEqual({ 'formatter@internal': false })
  })
})
