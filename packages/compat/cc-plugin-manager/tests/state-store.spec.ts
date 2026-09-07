import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadInstalledPlugins,
  loadJsonFile,
  loadKnownMarketplaces,
  loadSettingsFile,
  saveJsonFileAtomic,
} from '../src/state-store.ts'
import { PluginManagerError } from '../src/errors.ts'
import { fixture, fixtureJson, fixturePath } from './fixtures.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-store-'))
  temps.push(dir)
  return dir
}

describe('missing-file defaults', () => {
  it('loadJsonFile → fallback', async () => {
    const dir = await tempDir()
    expect(await loadJsonFile(join(dir, 'nope.json'), { fallback: true })).toEqual({ fallback: true })
  })

  it('loadKnownMarketplaces → {}', async () => {
    const dir = await tempDir()
    expect(await loadKnownMarketplaces(join(dir, 'known_marketplaces.json'))).toEqual({})
  })

  it('loadInstalledPlugins → v2 shape', async () => {
    const dir = await tempDir()
    expect(await loadInstalledPlugins(join(dir, 'installed_plugins.json'))).toEqual({ version: 2, plugins: {} })
  })

  it('loadSettingsFile → {}', async () => {
    const dir = await tempDir()
    expect(await loadSettingsFile(join(dir, 'settings.json'))).toEqual({})
  })

  it('real fixtures parse into typed shapes', async () => {
    const known = await loadKnownMarketplaces(fixturePath('known_marketplaces.real-home.json'))
    expect(Object.keys(known).sort()).toEqual(['anthropics', 'internal'])
    expect(known['anthropics']).toMatchObject({ autoUpdate: true })
    expect(known['internal']!.source).toEqual({ source: 'directory', path: '/tmp/cc-probe/marketplace' })
    const installed = await loadInstalledPlugins(fixturePath('installed_plugins.multi-scope.json'))
    const entries = installed.plugins['formatter@internal']!
    expect(entries.map(e => e.scope)).toEqual(['user', 'project'])
    expect(entries[1]!.projectPath).toBe('/tmp/cc-probe/project')
    expect(installed.version).toBe(2)
  })
})

describe('round-trip preservation (C11)', () => {
  it('preserves unrelated keys and key order across read-modify-write', async () => {
    const dir = await tempDir()
    const file = join(dir, 'settings.json')
    await writeFile(file, fixture('settings.after-disable.json'), 'utf8')
    const settings = await loadSettingsFile(file)
    // mutate only enabledPlugins, add an unrelated sibling
    settings['enabledPlugins'] = { 'dark-mode@anthropics': true }
    settings['newKey'] = { nested: 1 }
    await saveJsonFileAtomic(file, settings)
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['enabledPlugins', 'extraKnownMarketplaces', 'statusLine', 'newKey'])
    expect(parsed['statusLine']).toEqual({ type: 'command', command: 'dsh statusline' })
    expect(parsed['extraKnownMarketplaces']).toEqual((fixtureJson('settings.after-disable.json') as Record<string, unknown>)['extraKnownMarketplaces'])
  })

  it('installed plugins entry with and without optional fields typechecks + round-trips', async () => {
    const dir = await tempDir()
    const file = join(dir, 'installed_plugins.json')
    const original = await loadInstalledPlugins(fixturePath('installed_plugins.multi-scope.json'))
    await saveJsonFileAtomic(file, original)
    expect(await loadInstalledPlugins(file)).toEqual(original)
  })
})

describe('malformed JSON', () => {
  it('throws PluginManagerError with the catalog prefix', async () => {
    const dir = await tempDir()
    const file = join(dir, 'known_marketplaces.json')
    await writeFile(file, '{ not json', 'utf8')
    const err = await loadKnownMarketplaces(file).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PluginManagerError)
    expect((err as Error).message).toMatch(new RegExp(`^State file .*known_marketplaces\\.json is malformed JSON: `))
  })

  it('loadSettingsFile reports malformed the same way', async () => {
    const dir = await tempDir()
    const file = join(dir, 'settings.json')
    await writeFile(file, '[1,', 'utf8')
    await expect(loadSettingsFile(file)).rejects.toThrow(/^State file .* is malformed JSON: /)
  })
})

describe('saveJsonFileAtomic', () => {
  it('serializes with 2-space indent + trailing newline (exact bytes)', async () => {
    const dir = await tempDir()
    const file = join(dir, 'settings.json')
    const value = { enabledPlugins: { 'a@b': true } }
    await saveJsonFileAtomic(file, value)
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(value, null, 2) + '\n')
  })

  it('matches the after-disable fixture byte-for-byte when re-saved', async () => {
    const dir = await tempDir()
    const file = join(dir, 'settings.json')
    await writeFile(file, fixture('settings.after-disable.json'), 'utf8')
    const settings = await loadSettingsFile(file)
    await saveJsonFileAtomic(file, settings)
    expect(await readFile(file, 'utf8')).toBe(fixture('settings.after-disable.json'))
  })

  it('creates parent directories and leaves no *.tmp-* residue', async () => {
    const dir = await tempDir()
    const file = join(dir, 'nested', 'deep', 'installed_plugins.json')
    await saveJsonFileAtomic(file, { version: 2, plugins: {} })
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify({ version: 2, plugins: {} }, null, 2) + '\n')
    const left = (await readdir(join(dir, 'nested', 'deep'))).filter(name => name.includes('.tmp-'))
    expect(left).toEqual([])
  })

  it('residue check across a directory that had prior saves', async () => {
    const dir = await tempDir()
    const file = join(dir, 'f.json')
    for (let i = 0; i < 3; i++) await saveJsonFileAtomic(file, { i })
    expect((await readdir(dir)).filter(n => /\.tmp-/.test(n))).toEqual([])
    await mkdir(join(dir, 'sub'), { recursive: true })
  })
})
