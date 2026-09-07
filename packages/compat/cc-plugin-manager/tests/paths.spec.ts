import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { findGitMainRoot, pluginsStatePaths, settingsFileForScope } from '../src/paths.ts'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtempCanonical(prefix)
  temps.push(dir)
  return dir
}

async function mkdtempCanonical(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  const raw = await mkdtemp(join(tmpdir(), prefix))
  // normalize through the same canonicalization the code applies
  const { canonicalizeExistingPath } = await import('../src/paths.ts')
  return canonicalizeExistingPath(raw)
}

describe('pluginsStatePaths', () => {
  it('returns the CC state layout under <claudeHome>/plugins', () => {
    const home = join('/some', 'home')
    const paths = pluginsStatePaths({ claudeHome: home, cwd: '/cwd' })
    expect(paths.stateDir).toBe(join(home, 'plugins'))
    expect(paths.knownMarketplacesFile).toBe(join(home, 'plugins', 'known_marketplaces.json'))
    expect(paths.installedPluginsFile).toBe(join(home, 'plugins', 'installed_plugins.json'))
    expect(paths.marketplacesDir).toBe(join(home, 'plugins', 'marketplaces'))
    expect(paths.cacheDir).toBe(join(home, 'plugins', 'cache'))
    expect(paths.dataDir).toBe(join(home, 'plugins', 'data'))
  })

  it('canonicalizes cwd-derived paths for /tmp-style aliases', async () => {
    const home = await tempDir('pm-home-')
    const cwd = await tempDir('pm-cwd-')
    const paths = pluginsStatePaths({ claudeHome: home, cwd })
    expect(paths.stateDir.startsWith(home)).toBe(true)
    // project settings path canonicalizes like the state paths
    const project = settingsFileForScope('project', { claudeHome: home, cwd })
    expect(project.startsWith(cwd)).toBe(true)
  })
})

describe('settingsFileForScope', () => {
  it('user scope → <claudeHome>/settings.json', async () => {
    const home = await tempDir('pm-usr-')
    const cwd = await tempDir('pm-pwd-')
    expect(settingsFileForScope('user', { claudeHome: home, cwd })).toBe(join(home, 'settings.json'))
    expect(settingsFileForScope('project', { claudeHome: home, cwd })).toBe(join(cwd, '.claude', 'settings.json'))
  })

  it('local scope in a plain repo → <cwd>/.claude/settings.local.json', async () => {
    const repo = await tempDir('pm-repo-')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, '.claude'), { recursive: true })
    expect(settingsFileForScope('local', { claudeHome: '/unused', cwd: repo })).toBe(
      join(repo, '.claude', 'settings.local.json'))
  })

  it('local scope from a linked worktree → main checkout settings.local.json (C1)', async () => {
    const main = await tempDir('pm-main-')
    const wt1 = await tempDir('pm-wt1-')
    // main checkout: a real .git directory
    await mkdir(join(main, '.git', 'worktrees', 'wt1'), { recursive: true })
    await mkdir(join(main, '.claude'), { recursive: true })
    // linked worktree: .git is a FILE containing a gitdir: pointer
    const gitdirAbs = join(main, '.git', 'worktrees', 'wt1')
    await writeFile(join(wt1, '.git'), `gitdir: ${gitdirAbs}\n`, 'utf8')
    const resolved = settingsFileForScope('local', { claudeHome: '/unused', cwd: wt1 })
    expect(resolved).toBe(join(main, '.claude', 'settings.local.json'))
  })

  it('non-existent nested paths still return canonicalized absolute strings', async () => {
    const repo = await tempDir('pm-nx-')
    const deep = join(repo, 'a', 'b', 'does-not-exist')
    const file = settingsFileForScope('local', { claudeHome: '/unused', cwd: deep })
    expect(file.startsWith(sep)).toBe(true)
    expect(file.endsWith(join('does-not-exist', '.claude', 'settings.local.json'))).toBe(true)
    // no /tmp-vs-/private/tmp style aliasing remains
    expect(file.includes(deep.split(sep)[1]!)).toBe(true)
  })
})

describe('findGitMainRoot', () => {
  it('returns the cwd itself when .git is a directory there', async () => {
    const repo = await tempDir('pm-gr-')
    await mkdir(join(repo, '.git'), { recursive: true })
    expect(findGitMainRoot(repo)).toBe(repo)
  })

  it('walks up to the nearest .git directory', async () => {
    const repo = await tempDir('pm-gr2-')
    const nested = join(repo, 'src', 'deep')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(findGitMainRoot(nested)).toBe(repo)
  })

  it('resolves a gitdir: pointer in a linked worktree to the main checkout', async () => {
    const main = await tempDir('pm-gm-')
    const wt1 = await tempDir('pm-gw-')
    await mkdir(join(main, '.git', 'worktrees', 'wt1'), { recursive: true })
    await writeFile(join(wt1, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt1')}\n`, 'utf8')
    expect(findGitMainRoot(wt1)).toBe(main)
  })

  it('accepts a symlinked .git pointer file', async () => {
    const main = await tempDir('pm-sl-')
    const wt1 = await tempDir('pm-sw-')
    await mkdir(join(main, '.git', 'worktrees', 'wt1'), { recursive: true })
    await symlink(join(main, '.git', 'worktrees', 'wt1'), join(wt1, '.git'))
    expect(findGitMainRoot(wt1)).toBe(main)
  })

  it('returns null outside any git tree', () => {
    expect(findGitMainRoot('/definitely/not/a/repo/at/all')).toBeNull()
  })
})
