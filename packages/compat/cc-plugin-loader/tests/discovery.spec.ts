import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCcPluginRoots } from '../src/discovery.ts'

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

async function writeAt(root: string, relative: string, contents: string): Promise<void> {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

/** A Claude-home shaped tree: settings + installed_plugins + one cache install. */
async function claudeHome(options: {
  enabled?: Record<string, boolean>
  installs?: Record<string, { path: string; lastUpdated?: string }[]>
}): Promise<{ home: string; cwd: string }> {
  const home = await tempDir('cc-plugin-home-')
  const cwd = await tempDir('cc-plugin-cwd-')
  await writeJson(join(home, 'settings.json'), { enabledPlugins: options.enabled ?? {} })
  await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(options.installs ?? {}).map(([key, entries]) => [
        key,
        entries.map(entry => ({
          scope: 'user',
          installPath: entry.path,
          ...entry.lastUpdated !== undefined ? { lastUpdated: entry.lastUpdated } : {},
        })),
      ]),
    ),
  })
  return { home, cwd }
}

describe('discoverCcPluginRoots default path (installed ∩ enabled)', () => {
  it('emits an enabled and installed plugin root with the name hint', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tavily' }))
    const { home, cwd } = await claudeHome({
      enabled: { 'tavily@claude-plugins-official': true },
      installs: { 'tavily@claude-plugins-official': [{ path: install }] },
    })
    const found = discoverCcPluginRoots({ claudeHome: home, cwd })
    expect(found).toEqual([{ root: install, nameHint: 'tavily' }])
  })

  it('skips a plugin that is installed but not enabled', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: {},
      installs: { 'tavily@official': [{ path: install }] },
    })
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([])
  })

  it('skips a plugin that is enabled but not installed', async () => {
    const { home, cwd } = await claudeHome({
      enabled: { 'ghost@official': true },
      installs: {},
    })
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([])
  })

  it('lets project-local enabledPlugins false override a user-scope true', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: install }] },
    })
    await writeAt(cwd, '.claude/settings.local.json', JSON.stringify({
      enabledPlugins: { 'tavily@official': false },
    }))
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([])
  })

  it('logs the cwd when project-scope enabledPlugins keys are present', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: {},
      installs: { 'tavily@official': [{ path: install }] },
    })
    await writeAt(cwd, '.claude/settings.json', JSON.stringify({
      enabledPlugins: { 'tavily@official': true },
    }))
    const messages: string[] = []
    discoverCcPluginRoots({ claudeHome: home, cwd, log: { info: message => { messages.push(message) }, warn: () => {} } })
    expect(messages.some(message => message.includes(cwd))).toBe(true)
  })

  it('lets project settings enable a plugin the user settings left off', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: {},
      installs: { 'tavily@official': [{ path: install }] },
    })
    await writeAt(cwd, '.claude/settings.json', JSON.stringify({
      enabledPlugins: { 'tavily@official': true },
    }))
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([
      { root: install, nameHint: 'tavily' },
    ])
  })

  it('skips a missing installPath without throwing', async () => {
    const { home, cwd } = await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: join(tmpdir(), 'cc-plugin-missing-root-does-not-exist') }] },
    })
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([])
  })

  it('skips unreadable enabled/installed JSON without throwing', async () => {
    const home = await tempDir('cc-plugin-home-')
    const cwd = await tempDir('cc-plugin-cwd-')
    await writeAt(home, 'settings.json', '{not json')
    await writeAt(home, 'plugins/installed_plugins.json', '{also not')
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([])
  })

  it('uses installPath and ignores an orphaned cache sibling', async () => {
    const cache = await tempDir('cc-plugin-cache-')
    const current = join(cache, 'unknown')
    const orphan = join(cache, 'ed404106fcd8')
    await mkdir(current, { recursive: true })
    await mkdir(orphan, { recursive: true })
    await writeAt(current, '.claude-plugin/plugin.json', JSON.stringify({ name: 'skill-creator' }))
    await writeAt(orphan, '.claude-plugin/plugin.json', JSON.stringify({ name: 'skill-creator' }))
    const { home, cwd } = await claudeHome({
      enabled: { 'skill-creator@official': true },
      installs: { 'skill-creator@official': [{ path: current }] },
    })
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([
      { root: current, nameHint: 'skill-creator' },
    ])
  })

  it('picks the install entry with the latest lastUpdated, then the later array element', async () => {
    const older = await tempDir('cc-plugin-old-')
    const newer = await tempDir('cc-plugin-new-')
    const { home, cwd } = await claudeHome({
      enabled: { 'alpha@mp': true },
      installs: {
        'alpha@mp': [
          { path: older, lastUpdated: '2026-01-01T00:00:00.000Z' },
          { path: newer, lastUpdated: '2026-06-01T00:00:00.000Z' },
        ],
      },
    })
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([
      { root: newer, nameHint: 'alpha' },
    ])
  })

  it('skips a bare enabled key that does not exactly match an installed name@marketplace', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: { tavily: true },
      installs: { 'tavily@official': [{ path: install }] },
    })
    const warnings: string[] = []
    expect(discoverCcPluginRoots({
      claudeHome: home,
      cwd,
      log: { info: () => {}, warn: message => { warnings.push(message) } },
    })).toEqual([])
    expect(warnings.some(message => message.includes('tavily'))).toBe(true)
  })

  it('deduplicates two enabled keys that resolve to the same installPath', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: { 'alpha@one': true, 'alpha@two': true },
      installs: {
        'alpha@one': [{ path: install }],
        'alpha@two': [{ path: install }],
      },
    })
    expect(discoverCcPluginRoots({ claudeHome: home, cwd })).toEqual([
      { root: install, nameHint: 'alpha' },
    ])
  })
})

describe('discoverCcPluginRoots pluginDirs override', () => {
  it('returns empty when pluginDirs is []', async () => {
    const install = await tempDir('cc-plugin-install-')
    const { home, cwd } = await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: install }] },
    })
    expect(discoverCcPluginRoots({ pluginDirs: [], claudeHome: home, cwd })).toEqual([])
  })

  it('returns empty when pluginDirs is null', () => {
    expect(discoverCcPluginRoots({ pluginDirs: null })).toEqual([])
  })

  it('flattens children that hold .claude-plugin/plugin.json', async () => {
    const parent = await tempDir('cc-plugin-dirs-')
    await writeAt(parent, 'alpha/.claude-plugin/plugin.json', JSON.stringify({ name: 'alpha' }))
    await writeAt(parent, 'beta/plugin.json', JSON.stringify({ name: 'beta' }))
    const found = discoverCcPluginRoots({ pluginDirs: [parent] })
    expect(found.map(entry => entry.nameHint).sort()).toEqual(['alpha', 'beta'])
  })

  it('does not treat a marketplace-only directory as a flatten root', async () => {
    const parent = await tempDir('cc-plugin-dirs-')
    await writeAt(parent, 'docs/.claude-plugin/marketplace.json', JSON.stringify({
      name: 'skills',
      plugins: [{ name: 'document-skills', source: './', skills: ['./skills/xlsx'] }],
    }))
    expect(discoverCcPluginRoots({ pluginDirs: [parent] })).toEqual([])
  })

  it('accepts the pluginDirs entry itself when it is a plugin root', async () => {
    const root = await tempDir('cc-plugin-root-')
    await writeAt(root, 'plugin.json', JSON.stringify({ name: 'solo' }))
    expect(discoverCcPluginRoots({ pluginDirs: [root] })).toEqual([
      { root, nameHint: 'solo' },
    ])
  })
})

describe('local settings hoist (worktree / subdirectory)', () => {
  /** A real git main checkout with one empty commit and a linked worktree. */
  async function gitRepoWithWorktree(): Promise<{ main: string; wt: string }> {
    const base = await tempDir('cc-plugin-git-')
    const main = join(base, 'main')
    const wt = join(base, 'wt')
    await mkdir(main, { recursive: true })
    const git = (argv: string[], cwd: string): void => {
      execFileSync('git', argv, { cwd, stdio: 'ignore' })
    }
    git(['init', '-q'], main)
    git(['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], main)
    git(['worktree', 'add', '-b', 'feat', wt, 'HEAD'], main)
    return { main, wt }
  }

  it('reads enabledPlugins from the main checkout local file when cwd is a worktree', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'from-main' }))
    const { main, wt } = await gitRepoWithWorktree()
    const { home } = await claudeHome({
      installs: { 'from-main@official': [{ path: install }] },
    })
    await writeJson(join(main, '.claude', 'settings.local.json'), { enabledPlugins: { 'from-main@official': true } })

    const found = discoverCcPluginRoots({ claudeHome: home, cwd: wt })
    expect(found).toEqual([{ root: install, nameHint: 'from-main' }])
  })

  it('silently ignores a worktree-local settings.local.json (main still wins)', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'from-main' }))
    const { main, wt } = await gitRepoWithWorktree()
    const { home } = await claudeHome({
      installs: { 'from-main@official': [{ path: install }] },
    })
    await writeJson(join(main, '.claude', 'settings.local.json'), { enabledPlugins: { 'from-main@official': true } })
    await writeJson(join(wt, '.claude', 'settings.local.json'), { enabledPlugins: { 'from-wt@official': true } })

    expect(discoverCcPluginRoots({ claudeHome: home, cwd: wt }).map(entry => entry.nameHint))
      .toEqual(['from-main'])

  })

  it('still applies project settings.json from the worktree itself (not hoisted)', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'wt-project' }))
    const { wt } = await gitRepoWithWorktree()
    const { home } = await claudeHome({
      installs: { 'wt-project@official': [{ path: install }] },
    })
    await writeJson(join(wt, '.claude', 'settings.json'), { enabledPlugins: { 'wt-project@official': true } })

    expect(discoverCcPluginRoots({ claudeHome: home, cwd: wt }).map(entry => entry.nameHint))
      .toEqual(['wt-project'])
  })
})

describe('discoverCcPluginRoots dual-home (dshHome, S2)', () => {
  const cwd = process.cwd() // no repo-level .claude settings exist; project/local stay empty
  /** A dsh-home shaped tree mirroring the claude-home layout. */
  async function dshHome(options: {
    enabled?: Record<string, boolean>
    installs?: Record<string, { path: string; lastUpdated?: string }[]>
  }): Promise<string> {
    const home = await tempDir('cc-plugin-dsh-')
    await writeJson(join(home, 'settings.json'), { enabledPlugins: options.enabled ?? {} })
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(options.installs ?? {}).map(([key, entries]) => [
          key,
          entries.map(entry => ({
            scope: 'user',
            installPath: entry.path,
            ...entry.lastUpdated !== undefined ? { lastUpdated: entry.lastUpdated } : {},
          })),
        ]),
      ),
    })
    return home
  }

  it('discovers a claude-only install enabled in the claude settings', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tavily' }))
    const home = (await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: install }] },
    })).home
    const dsh = await dshHome({})
    expect(discoverCcPluginRoots({ claudeHome: home, dshHome: dsh, cwd })).toEqual([
      { root: install, nameHint: 'tavily' },
    ])
  })

  it('a dsh false masks a claude true (plugin does not mount)', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tavily' }))
    const home = (await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: install }] },
    })).home
    const dsh = await dshHome({ enabled: { 'tavily@official': false } })
    expect(discoverCcPluginRoots({ claudeHome: home, dshHome: dsh, cwd })).toEqual([])
  })

  it('a dsh true enables a claude-installed plugin', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tavily' }))
    const home = (await claudeHome({
      enabled: {},
      installs: { 'tavily@official': [{ path: install }] },
    })).home
    const dsh = await dshHome({ enabled: { 'tavily@official': true } })
    expect(discoverCcPluginRoots({ claudeHome: home, dshHome: dsh, cwd })).toEqual([
      { root: install, nameHint: 'tavily' },
    ])
  })

  it('an empty dsh installed list hides the id even when enabled', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tavily' }))
    const home = (await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: install }] },
    })).home
    const dsh = await dshHome({ enabled: { 'tavily@official': true }, installs: { 'tavily@official': [] } })
    expect(discoverCcPluginRoots({ claudeHome: home, dshHome: dsh, cwd })).toEqual([])
  })

  it('a dsh-installed plugin (own cache path) is discovered', async () => {
    const dshInstall = await tempDir('cc-plugin-dsh-install-')
    await writeAt(dshInstall, '.claude-plugin/plugin.json', JSON.stringify({ name: 'dshside' }))
    const home = (await claudeHome({})).home
    const dsh = await dshHome({
      enabled: { 'dshside@official': true },
      installs: { 'dshside@official': [{ path: dshInstall }] },
    })
    expect(discoverCcPluginRoots({ claudeHome: home, dshHome: dsh, cwd })).toEqual([
      { root: dshInstall, nameHint: 'dshside' },
    ])
  })

  it('treats a symlinked dshHome equal to claudeHome as single-root (no double read)', async () => {
    const install = await tempDir('cc-plugin-install-')
    await writeAt(install, '.claude-plugin/plugin.json', JSON.stringify({ name: 'tavily' }))
    const home = (await claudeHome({
      enabled: { 'tavily@official': true },
      installs: { 'tavily@official': [{ path: install }] },
    })).home
    const linkParent = await tempDir('cc-plugin-link-')
    const linked = join(linkParent, 'home-link')
    await mkdir(join(linked, '..'), { recursive: true })
    await symlink(home, linked)
    expect(discoverCcPluginRoots({ claudeHome: home, dshHome: linked, cwd })).toEqual([
      { root: install, nameHint: 'tavily' },
    ])
  })
})
