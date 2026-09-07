/**
 * Marketplace operations (plan §2.2 C1/C6/C8): add (directory / github
 * shorthand / git URL), list, update, remove — against fake git runners
 * recording calls, and real tmp state files in C1 byte shape.
 *
 * @module @dsh-cc/plugin-manager/test-marketplace
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GitRunner } from '../src/git.ts'
import { addMarketplace, listMarketplaces, removeMarketplace, updateMarketplaces } from '../src/marketplace.ts'
import { createCcPluginManager } from '../src/index.ts'
import { PluginManagerError } from '../src/errors.ts'
import { canonicalizeExistingPath } from '../src/paths.ts'
import type { MarketplaceSource } from '../src/types.ts'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

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
  marketplacesDir: string
  knownFile: string
}

async function rig(): Promise<Rig> {
  const claudeHome = await tempDir('pm-mkt-home-')
  const cwd = await tempDir('pm-mkt-cwd-')
  const marketplacesDir = join(claudeHome, 'plugins', 'marketplaces')
  await mkdir(marketplacesDir, { recursive: true })
  return { claudeHome, cwd, marketplacesDir, knownFile: join(claudeHome, 'plugins', 'known_marketplaces.json') }
}

interface GitCall {
  args: string[]
  cwd: string
}

interface FakeGit {
  runGit: GitRunner
  calls: GitCall[]
}

/** Fake git: records calls; materializes a marketplace.json at the clone dest; can be made to fail. */
function fakeGit(opts?: { fail?: boolean; stderr?: string; name?: string }): FakeGit {
  const calls: GitCall[] = []
  const runGit: GitRunner = async (args, runnerOpts) => {
    calls.push({ args, cwd: runnerOpts.cwd })
    if (opts?.fail) return { code: 128, stdout: '', stderr: opts.stderr ?? 'fatal: repository not found' }
    const cloneIdx = args.indexOf('clone')
    if (cloneIdx >= 0) {
      const dest = args[cloneIdx + 2]!
      await mkdir(join(dest, '.claude-plugin'), { recursive: true })
      await writeFile(
        join(dest, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: opts?.name ?? 'remote-mkt', plugins: [{ name: 'p1' }, { name: 'p2' }] }),
        'utf8',
      )
    }
    return { code: 0, stdout: 'Already up to date.', stderr: '' }
  }
  return { runGit, calls }
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function expectError(fn: () => Promise<unknown>): Promise<PluginManagerError> {
  return fn().then(
    () => {
      throw new Error('expected to throw')
    },
    error => error as PluginManagerError,
  )
}

const deps = (r: Rig): any => ({ claudeHome: r.claudeHome, cwd: r.cwd })

describe('marketplace add — directory source (C1)', () => {
  it('writes the known_marketplaces entry AND the user-scope settings declaration, preserving unrelated keys', async () => {
    const r = await rig()
    const settingsFile = join(r.claudeHome, 'settings.json')
    await writeFile(settingsFile, JSON.stringify({ theme: 'dark' }, null, 2) + '\n', 'utf8')
    const source = join(fixtureDir, 'dir-marketplace')

    const result = await addMarketplace(deps(r), source, { now: () => new Date('2026-09-06T10:00:00.000Z') })

    expect(result).toEqual({ name: 'local-tools', sourceKind: 'directory', pluginCount: 2 })
    const known = await readJson(r.knownFile)
    expect(known['local-tools']).toEqual({
      source: { source: 'directory', path: source },
      installLocation: source,
      lastUpdated: '2026-09-06T10:00:00.000Z',
    })
    const settings = await readJson(settingsFile)
    expect(settings['theme']).toBe('dark')
    expect(settings['extraKnownMarketplaces']).toEqual({ 'local-tools': { source: { source: 'directory', path: source } } })
  })

  it('honors an explicit project scope for the settings declaration', async () => {
    const r = await rig()
    const source = join(fixtureDir, 'dir-marketplace')
    await addMarketplace(deps(r), source, { scope: 'project' })
    const settings = await readJson(join(r.cwd, '.claude', 'settings.json'))
    expect(Object.keys(settings['extraKnownMarketplaces'])).toEqual(['local-tools'])
    const userSettingsRaw = await readFile(join(r.claudeHome, 'settings.json'), 'utf8').catch(() => undefined)
    expect(userSettingsRaw).toBeUndefined()
  })
})

describe('marketplace add — github shorthand + git URL', () => {
  it('classifies owner/repo, clones via fake git with the right url, tmp-then-rename into marketplaces dir', async () => {
    const r = await rig()
    const git = fakeGit()
    const result = await addMarketplace(deps(r), 'o/r', { runGit: git.runGit, now: () => new Date('2026-09-06T11:00:00.000Z') })

    expect(result).toEqual({ name: 'remote-mkt', sourceKind: 'github', pluginCount: 2 })
    expect(git.calls).toHaveLength(1)
    const call = git.calls[0]!
    expect(call.args[0]).toBe('clone')
    expect(call.cwd).toBe(r.marketplacesDir)
    const url = call.args.find(arg => arg === 'https://github.com/o/r.git')!
    expect(url).toBe('https://github.com/o/r.git')
    const dest = call.args[call.args.indexOf(url) + 1]!
    expect(dest.startsWith(join(r.marketplacesDir, '.tmp-clone-'))).toBe(true)
    // tmp gone, final clone present under the marketplace name from its manifest
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(join(r.marketplacesDir, 'remote-mkt', '.claude-plugin', 'marketplace.json'))).toBe(true)

    const known = await readJson(r.knownFile)
    expect(known['remote-mkt']).toEqual({
      source: { source: 'github', repo: 'o/r' },
      installLocation: join(r.marketplacesDir, 'remote-mkt'),
      lastUpdated: '2026-09-06T11:00:00.000Z',
    })
  })

  it('classifies https and git@ URLs as git sources', async () => {
    const r = await rig()
    const git = fakeGit({ name: 'from-https' })
    await addMarketplace(deps(r), 'https://example.com/x/y.git', { runGit: git.runGit })
    const git2 = fakeGit({ name: 'from-ssh' })
    await addMarketplace(deps(r), 'git@example.com:x/y.git', { runGit: git2.runGit })
    const known = await readJson(r.knownFile)
    expect(known['from-https']['source']).toEqual({ source: 'git', url: 'https://example.com/x/y.git' })
    expect(known['from-ssh']['source']).toEqual({ source: 'git', url: 'git@example.com:x/y.git' })
    expect(git2.calls[0]!.args).toContain('git@example.com:x/y.git')
  })

  it('rejects an unknown source shape with the exact error string', async () => {
    const r = await rig()
    const error = await expectError(() => addMarketplace(deps(r), 'definitely not a source'))
    expect(error.message).toBe('Marketplace source "definitely not a source" is not a readable directory, owner/repo, or git URL.')
  })

  it('rejects an existing directory without a readable marketplace.json', async () => {
    const r = await rig()
    const badDir = canonicalizeExistingPath(await tempDir('pm-mkt-baddir-'))
    const error = await expectError(() => addMarketplace(deps(r), badDir))
    expect(error.message).toBe(`Marketplace at ${badDir} has no readable .claude-plugin/marketplace.json (ENOENT).`)
  })

  it('rejects a directory whose marketplace.json has no name field (fixture)', async () => {
    const r = await rig()
    const badDir = join(r.marketplacesDir, 'bad')
    await mkdir(join(badDir, '.claude-plugin'), { recursive: true })
    const manifest = await readFile(join(fixtureDir, 'marketplace.missing-name.json'), 'utf8')
    await writeFile(join(badDir, '.claude-plugin', 'marketplace.json'), manifest, 'utf8')
    const canonical = canonicalizeExistingPath(badDir)
    const error = await expectError(() => addMarketplace(deps(r), badDir))
    expect(error.message).toBe(`Marketplace at ${canonical} has no readable .claude-plugin/marketplace.json (missing "name").`)
  })

  it('a clone failure leaves no tmp residue and no state mutation, with the git error string', async () => {
    const r = await rig()
    const git = fakeGit({ fail: true, stderr: 'fatal: could not read from remote repository\n' })
    const error = await expectError(() => addMarketplace(deps(r), 'o/r', { runGit: git.runGit }))
    expect(error.message).toBe('git clone failed for https://github.com/o/r.git: fatal: could not read from remote repository')
    // no tmp-clone residue and no known_marketplaces.json written
    const residue = existsSync(r.marketplacesDir) ? await readdir(r.marketplacesDir) : []
    expect(residue.filter(entry => entry.startsWith('.tmp-clone-'))).toEqual([])
    const entries = await readFile(r.knownFile, 'utf8').catch(() => undefined)
    expect(entries).toBeUndefined()
  })

  it('same source re-add is idempotent; same name from a different source conflicts', async () => {
    const r = await rig()
    const source = join(fixtureDir, 'dir-marketplace')
    await addMarketplace(deps(r), source)
    const again = await addMarketplace(deps(r), source)
    expect(again.name).toBe('local-tools')
    const known = await readJson(r.knownFile)
    expect(Object.keys(known)).toEqual(['local-tools'])

    // same NAME, different source (a github clone named local-tools)
    const git = fakeGit({ name: 'local-tools' })
    const error = await expectError(() => addMarketplace(deps(r), 'o/other', { runGit: git.runGit }))
    expect(error.message).toBe('Marketplace "local-tools" is already registered from a different source (directory).')
    expect(existsSync(join(r.marketplacesDir, 'local-tools'))).toBe(false)
  })
})

describe('marketplace list', () => {
  it('returns name/source/installLocation/lastUpdated with autoUpdate passthrough', async () => {
    const r = await rig()
    await writeFile(
      r.knownFile,
      JSON.stringify({
        dir: {
          source: { source: 'directory', path: '/tmp/cc-probe/marketplace' },
          installLocation: '/tmp/cc-probe/marketplace',
          lastUpdated: '2026-09-05T08:00:00.000Z',
        },
        gh: {
          source: { source: 'github', repo: 'anthropics/claude-code' },
          installLocation: join(r.marketplacesDir, 'gh'),
          lastUpdated: '2026-09-05T08:05:00.000Z',
          autoUpdate: true,
        },
      }, null, 2) + '\n',
      'utf8',
    )
    const rows = await listMarketplaces(deps(r))
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.name)).toEqual(['dir', 'gh'])
    expect(rows[1]).toEqual({
      name: 'gh',
      source: { source: 'github', repo: 'anthropics/claude-code' } satisfies MarketplaceSource,
      installLocation: join(r.marketplacesDir, 'gh'),
      lastUpdated: '2026-09-05T08:05:00.000Z',
      autoUpdate: true,
    })
  })
})

describe('marketplace update (C8)', () => {
  it('updates all: directory bumps only lastUpdated, git runs pull --ff-only', async () => {
    const r = await rig()
    const dirLoc = await tempDir('pm-mkt-dirloc-')
    await mkdir(join(dirLoc, '.claude-plugin'), { recursive: true })
    await writeFile(join(dirLoc, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'dir' }), 'utf8')
    const ghLoc = join(r.marketplacesDir, 'gh')
    await mkdir(ghLoc, { recursive: true })
    await writeFile(r.knownFile, JSON.stringify({
      zdir: { source: { source: 'directory', path: dirLoc }, installLocation: dirLoc, lastUpdated: '2026-09-05T08:00:00.000Z' },
      gh: { source: { source: 'github', repo: 'o/r' }, installLocation: ghLoc, lastUpdated: '2026-09-05T08:00:00.000Z' },
    }, null, 2) + '\n', 'utf8')
    const git = fakeGit()

    const updated = await updateMarketplaces({ ...deps(r), runGit: git.runGit, now: () => new Date('2026-09-06T12:00:00.000Z') })

    expect(updated).toEqual(['gh', 'zdir'])
    expect(git.calls).toEqual([{ args: ['-C', ghLoc, 'pull', '--ff-only'], cwd: ghLoc }])
    const known = await readJson(r.knownFile)
    expect(known['zdir']['lastUpdated']).toBe('2026-09-06T12:00:00.000Z')
    expect(known['gh']['lastUpdated']).toBe('2026-09-06T12:00:00.000Z')
  })

  it('updates a named marketplace only', async () => {
    const r = await rig()
    await writeFile(r.knownFile, JSON.stringify({
      a: { source: { source: 'github', repo: 'o/a' }, installLocation: join(r.marketplacesDir, 'a'), lastUpdated: 'T0' },
      b: { source: { source: 'github', repo: 'o/b' }, installLocation: join(r.marketplacesDir, 'b'), lastUpdated: 'T0' },
    }, null, 2) + '\n', 'utf8')
    const git = fakeGit()
    const updated = await updateMarketplaces({ ...deps(r), runGit: git.runGit }, 'a')
    expect(updated).toEqual(['a'])
    expect(git.calls).toHaveLength(1)
    const known = await readJson(r.knownFile)
    expect(known['b']['lastUpdated']).toBe('T0')
  })

  it('unknown name errors with the known list', async () => {
    const r = await rig()
    const error = await expectError(() => updateMarketplaces(deps(r), 'nope'))
    expect(error.message).toBe('Unknown marketplace "nope". Known: (none)')
  })

  it('a pull failure surfaces the git error string and keeps lastUpdated', async () => {
    const r = await rig()
    await writeFile(r.knownFile, JSON.stringify({
      gh: { source: { source: 'github', repo: 'o/r' }, installLocation: join(r.marketplacesDir, 'gh'), lastUpdated: 'T0' },
    }, null, 2) + '\n', 'utf8')
    const git = fakeGit({ fail: true, stderr: 'error: cannot pull\n' })
    const error = await expectError(() => updateMarketplaces({ ...deps(r), runGit: git.runGit }, 'gh'))
    expect(error.message).toBe(`git pull failed for ${join(r.marketplacesDir, 'gh')}: error: cannot pull`)
    expect((await readJson(r.knownFile))['gh']['lastUpdated']).toBe('T0')
  })
})

describe('marketplace remove (C6)', () => {
  it('removes known key, declarations at every scope where present, and the git clone dir', async () => {
    const r = await rig()
    const cloneDir = join(r.marketplacesDir, 'gh')
    await mkdir(cloneDir, { recursive: true })
    await writeFile(r.knownFile, JSON.stringify({
      gh: { source: { source: 'github', repo: 'o/r' }, installLocation: cloneDir, lastUpdated: 'T0' },
    }, null, 2) + '\n', 'utf8')
    const userSettingsFile = join(r.claudeHome, 'settings.json')
    const projectDir = join(r.cwd, '.claude')
    await mkdir(projectDir, { recursive: true })
    await writeFile(userSettingsFile, JSON.stringify({ keepMe: 1, extraKnownMarketplaces: { gh: { source: { source: 'github', repo: 'o/r' } }, other: { source: { source: 'directory', path: '/d' } } } }, null, 2) + '\n', 'utf8')
    await writeFile(join(projectDir, 'settings.json'), JSON.stringify({ extraKnownMarketplaces: { gh: { source: { source: 'github', repo: 'o/r' } } } }, null, 2) + '\n', 'utf8')

    const result = await removeMarketplace(deps(r), 'gh')

    expect(result).toEqual({ name: 'gh', removedPlugins: [] })
    expect(existsSync(cloneDir)).toBe(false)
    const known = await readJson(r.knownFile)
    expect(known).toEqual({})
    const userSettings = await readJson(userSettingsFile)
    expect(userSettings['keepMe']).toBe(1)
    expect(userSettings['extraKnownMarketplaces']).toEqual({ other: { source: { source: 'directory', path: '/d' } } })
    const projectSettings = await readJson(join(projectDir, 'settings.json'))
    expect(projectSettings['extraKnownMarketplaces']).toEqual({})
  })

  it('never deletes a directory source installLocation', async () => {
    const r = await rig()
    const dirLoc = await tempDir('pm-mkt-keepme-')
    await writeFile(join(dirLoc, 'precious.txt'), 'keep', 'utf8')
    await writeFile(r.knownFile, JSON.stringify({
      dir: { source: { source: 'directory', path: dirLoc }, installLocation: dirLoc, lastUpdated: 'T0' },
    }, null, 2) + '\n', 'utf8')

    await removeMarketplace(deps(r), 'dir')

    expect(existsSync(join(dirLoc, 'precious.txt'))).toBe(true)
    expect(existsSync(dirLoc)).toBe(true)
    expect((await readJson(r.knownFile))).toEqual({})
  })

  it('unknown name errors with the known list', async () => {
    const r = await rig()
    await writeFile(r.knownFile, JSON.stringify({
      a: { source: { source: 'github', repo: 'o/a' }, installLocation: '/x', lastUpdated: 'T0' },
    }, null, 2) + '\n', 'utf8')
    const error = await expectError(() => removeMarketplace(deps(r), 'zzz'))
    expect(error.message).toBe('Unknown marketplace "zzz". Known: a')
  })
})

describe('manager factory marketplace methods', () => {
  it('exposes listMarketplaces / addMarketplace / updateMarketplaces / removeMarketplace with injected runGit', async () => {
    const r = await rig()
    const git = fakeGit()
    const mgr = createCcPluginManager({ claudeHome: r.claudeHome, cwd: r.cwd, runGit: git.runGit })
    await mgr.addMarketplace('o/r')
    expect(git.calls).toHaveLength(1)
    expect((await mgr.listMarketplaces()).map(row => row.name)).toEqual(['remote-mkt'])
    expect(await mgr.updateMarketplaces('remote-mkt')).toEqual(['remote-mkt'])
    expect(await mgr.removeMarketplace('remote-mkt')).toEqual({ name: 'remote-mkt', removedPlugins: [] })
    expect((await mgr.listMarketplaces())).toEqual([])
  })
})
