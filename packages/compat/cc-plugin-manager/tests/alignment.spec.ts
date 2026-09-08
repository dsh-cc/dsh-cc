/**
 * S6 alignment test (plan §5-S6): the interop money test. The manager core
 * (`@dsh-cc/plugin-manager`) writes Claude Code v2.1.236-shaped state files in
 * a scratch `CLAUDE_CONFIG_DIR`; the loader (`@dsh-cc/plugin-loader`) must
 * then discover exactly the installed ∧ enabled ∧ visible-from-cwd plugin
 * roots after every mutation step.
 *
 * @module @dsh-cc/plugin-manager/alignment
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCcPluginManager } from '../src/index.ts'
// The loader's package root (`@dsh-cc/plugin-loader`) pulls the full mount
// chain (skills/agents/… → harness packages whose `link:` deps dangle in
// this worktree); the discovery surface alone is the interop contract under
// test. Same pattern as the loader's own discovery.spec.ts (src import).
import { discoverCcPluginRoots } from '../../cc-plugin-loader/src/discovery.ts'
import { snapshotTree } from './helpers.ts'

const temps: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Fixed clock so installedAt/lastUpdated ordering is deterministic. */
const now = (): Date => new Date('2026-09-06T12:00:00.000Z')

const PLUGINS = ['alpha', 'beta', 'gamma'] as const

/**
 * Build a directory marketplace `local-tools` mirroring the
 * `tests/fixtures/dir-marketplace` layout, plus a real on-disk plugin dir per
 * declared plugin (nested manifest + one command file so the loader sees
 * content).
 */
async function buildDirMarketplace(dir: string): Promise<void> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'local-tools',
      owner: { name: 'Probe' },
      plugins: PLUGINS.map(name => ({ name, source: `plugins/${name}` })),
    }),
    'utf8',
  )
  for (const name of PLUGINS) {
    await mkdir(join(dir, 'plugins', name, '.claude-plugin'), { recursive: true })
    await mkdir(join(dir, 'plugins', name, 'commands'), { recursive: true })
    await writeFile(
      join(dir, 'plugins', name, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }),
      'utf8',
    )
    await writeFile(join(dir, 'plugins', name, 'commands', 'x.md'), `---\ndescription: ${name}\n---\n\n# ${name}\n`, 'utf8')
  }
}

/** Discovery roots from the scratch home/cwd, canonicalized the way the manager canonicalizes `projectPath`. */
function discovered(claudeHome: string, cwd: string): string[] {
  return discoverCcPluginRoots({ claudeHome, cwd }).map(entry => realpathSync(entry.root))
}

function nameHints(claudeHome: string, cwd: string): string[] {
  return discoverCcPluginRoots({ claudeHome, cwd }).map(entry => entry.nameHint)
}

describe('S6 alignment: manager state ↔ loader discovery', () => {
  it('discovery tracks install/enable/disable across scopes', async () => {
    const claudeHome = await tempDir('pm-s6-home-')
    const cwd = await tempDir('pm-s6-cwd-')
    const foreignCwd = await tempDir('pm-s6-foreign-')
    const marketplaceDir = await tempDir('pm-s6-mkt-')
    await buildDirMarketplace(marketplaceDir)

    const manager = createCcPluginManager({ claudeHome, cwd, now })
    await manager.addMarketplace(marketplaceDir)

    // (1) baseline: nothing installed → nothing discovered.
    expect(discovered(claudeHome, cwd)).toEqual([])
    expect(nameHints(claudeHome, cwd)).toEqual([])

    // (2) install at user scope → discovered (realpath /tmp → /private/tmp on macOS).
    const userInstall = await manager.install('alpha@local-tools', { scope: 'user' })
    expect(discovered(claudeHome, cwd)).toEqual([realpathSync(userInstall.installPath)])
    expect(nameHints(claudeHome, cwd)).toEqual(['alpha'])

    // (3) install at project scope from cwd → both visible, user entry first.
    const projectInstall = await manager.install('beta@local-tools', { scope: 'project' })
    expect(projectInstall.scope).toBe('project')
    expect(discovered(claudeHome, cwd)).toEqual([
      realpathSync(userInstall.installPath),
      realpathSync(projectInstall.installPath),
    ])

    // (4) a project-scope entry carrying a DIFFERENT projectPath is not discovered from cwd.
    const foreignManager = createCcPluginManager({ claudeHome, cwd: foreignCwd, now })
    const foreignInstall = await foreignManager.install('gamma@local-tools', { scope: 'project' })
    expect(foreignInstall.scope).toBe('project')
    expect(discovered(claudeHome, cwd)).toEqual([
      realpathSync(userInstall.installPath),
      realpathSync(projectInstall.installPath),
    ])
    // ...but from the foreign project's own cwd, gamma IS discovered
    // (alongside the user-scope alpha, which is visible everywhere).
    expect(nameHints(claudeHome, foreignCwd)).toEqual(['alpha', 'gamma'])

    // (5) disable at user scope → only the project-scope plugin remains.
    await manager.disable('alpha@local-tools', { scope: 'user' })
    expect(discovered(claudeHome, cwd)).toEqual([realpathSync(projectInstall.installPath)])

    // (6) enable at user scope → both back.
    await manager.enable('alpha@local-tools', { scope: 'user' })
    expect(discovered(claudeHome, cwd)).toEqual([
      realpathSync(userInstall.installPath),
      realpathSync(projectInstall.installPath),
    ])
  })
})

describe('dual-home alignment (S2): manager listing ≡ loader discovery across two homes', () => {
  /** Seed `<home>/plugins/installed_plugins.json` and `<home>/settings.json`. */
  async function seedHome(home: string, options: {
    enabled?: Record<string, boolean>
    installs?: Record<string, { scope: 'user' | 'project'; path: string; projectPath?: string }[]>
  }): Promise<void> {
    await mkdir(join(home, 'plugins'), { recursive: true })
    await writeFile(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: Object.fromEntries(
          Object.entries(options.installs ?? {}).map(([key, entries]) => [
            key,
            entries.map(entry => ({
              scope: entry.scope,
              installPath: entry.path,
              version: '1.0.0',
              installedAt: '2026-09-06T12:00:00.000Z',
              lastUpdated: '2026-09-06T12:00:00.000Z',
              ...entry.projectPath !== undefined ? { projectPath: entry.projectPath } : {},
            })),
          ]),
        ),
      }),
      'utf8',
    )
    await writeFile(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: options.enabled ?? {} }), 'utf8')
  }

  /** Build a real plugin root (nested manifest) so discovery sees content. */
  async function pluginRoot(prefix: string, name: string): Promise<string> {
    const root = await tempDir(prefix)
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
    return root
  }

  function managerFor(claudeHome: string, dshHome: string, cwd: string): ReturnType<typeof createCcPluginManager> {
    return createCcPluginManager({ claudeHome, dshHome, cwd, now })
  }

  function discoveredIn(claudeHome: string, dshHome: string, cwd: string): string[] {
    return discoverCcPluginRoots({ claudeHome, dshHome, cwd }).map(entry => realpathSync(entry.root))
  }

  it('a claude-only install is visible and enabled in both views', async () => {
    const claudeHome = await tempDir('al-d-cl-')
    const dshHome = await tempDir('al-d-ds-')
    const cwd = await tempDir('al-d-cwd-')
    const install = await pluginRoot('al-d-ia-', 'alpha')
    await seedHome(claudeHome, {
      enabled: { 'alpha@mp': true },
      installs: { 'alpha@mp': [{ scope: 'user', path: install }] },
    })
    const manager = managerFor(claudeHome, dshHome, cwd)
    const rows = await manager.list()
    expect(rows.map(row => [row.id, row.effectiveEnabled])).toEqual([['alpha@mp', true]])
    expect(rows[0]!.enabledByScope.user).toBe(true)
    expect(discoveredIn(claudeHome, dshHome, cwd)).toEqual([realpathSync(install)])
  })

  it('a dsh false masking a claude true: both views agree the plugin does NOT mount', async () => {
    const claudeHome = await tempDir('al-m-cl-')
    const dshHome = await tempDir('al-m-ds-')
    const cwd = await tempDir('al-m-cwd-')
    const install = await pluginRoot('al-m-ia-', 'alpha')
    await seedHome(claudeHome, {
      enabled: { 'alpha@mp': true },
      installs: { 'alpha@mp': [{ scope: 'user', path: install }] },
    })
    await seedHome(dshHome, { enabled: { 'alpha@mp': false } })
    const manager = managerFor(claudeHome, dshHome, cwd)
    const rows = await manager.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.effectiveEnabled).toBe(false)
    expect(rows[0]!.enabledByScope.user).toBe(false) // §3.3 provenance pin
    expect(discoveredIn(claudeHome, dshHome, cwd)).toEqual([])
  })

  it('a dsh-installed plugin on a claude-known marketplace appears in both views', async () => {
    const claudeHome = await tempDir('al-s-cl-')
    const dshHome = await tempDir('al-s-ds-')
    const cwd = await tempDir('al-s-cwd-')
    const claudeInstall = await pluginRoot('al-s-ic-', 'alpha')
    const dshInstall = await pluginRoot('al-s-id-', 'beta')
    await seedHome(claudeHome, {
      enabled: { 'alpha@mp': true },
      installs: { 'alpha@mp': [{ scope: 'user', path: claudeInstall }] },
    })
    await seedHome(dshHome, {
      enabled: { 'beta@mp': true },
      installs: { 'beta@mp': [{ scope: 'user', path: dshInstall }] },
    })
    const manager = managerFor(claudeHome, dshHome, cwd)
    const rows = await manager.list()
    expect(rows.map(row => row.id).sort()).toEqual(['alpha@mp', 'beta@mp'])
    expect(discoveredIn(claudeHome, dshHome, cwd).sort()).toEqual(
      [realpathSync(claudeInstall), realpathSync(dshInstall)].sort(),
    )
  })

  it('an empty-list tombstoned id is invisible to both views', async () => {
    const claudeHome = await tempDir('al-t-cl-')
    const dshHome = await tempDir('al-t-ds-')
    const cwd = await tempDir('al-t-cwd-')
    const install = await pluginRoot('al-t-ia-', 'alpha')
    await seedHome(claudeHome, {
      enabled: { 'alpha@mp': true },
      installs: { 'alpha@mp': [{ scope: 'user', path: install }] },
    })
    await seedHome(dshHome, {
      enabled: { 'alpha@mp': true },
      installs: { 'alpha@mp': [] },
    })
    const manager = managerFor(claudeHome, dshHome, cwd)
    expect(await manager.list()).toEqual([])
    expect(discoveredIn(claudeHome, dshHome, cwd)).toEqual([])
  })
describe('dual-home alignment (S3/S4): mutations keep both views in agreement', () => {
  it('update from a claude-known marketplace materializes into the dsh cache and discovery mounts the dsh cache copy', async () => {
    const claudeHome = await tempDir('al-u-cl-')
    const dshHome = await tempDir('al-u-ds-')
    const cwd = await tempDir('al-u-cwd-')
    const marketplaceDir = await tempDir('al-u-mkt-')
    await buildDirMarketplace(marketplaceDir)
    // claude-side known entry (directory source, external path — untouched by the update)
    await mkdir(join(claudeHome, 'plugins'), { recursive: true })
    await writeFile(join(claudeHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      mp: { source: { source: 'directory', path: marketplaceDir }, installLocation: marketplaceDir, lastUpdated: '2026-09-01T00:00:00.000Z' },
    }), 'utf8')
    // claude-side install at a STALE version (0.9.0) vs the manifest (1.0.0), enabled at the claude user layer
    const staleInstall = await pluginRoot('al-u-ia-', 'alpha')
    await seedHome(claudeHome, {
      enabled: { 'alpha@mp': true },
      installs: { 'alpha@mp': [{ scope: 'user', path: staleInstall }] },
    })
    const { readFile: readFileAsync } = await import('node:fs/promises')
    const installedFile = join(claudeHome, 'plugins', 'installed_plugins.json')
    const stale = JSON.parse(await readFileAsync(installedFile, 'utf8'))
    stale.plugins['alpha@mp'][0].version = '0.9.0'
    await writeFile(installedFile, JSON.stringify(stale), 'utf8')
    const claudeBefore = await snapshotTree(claudeHome)

    const manager = managerFor(claudeHome, dshHome, cwd)
    const result = await manager.update('alpha@mp')
    expect(result).toEqual({ upToDate: false, id: 'alpha@mp', fromVersion: '0.9.0', toVersion: '1.0.0', scope: 'user' })

    // the new version materialized into the DSH cache; discovery mounts it
    const dshCacheRoot = realpathSync(join(dshHome, 'plugins', 'cache', 'mp', 'alpha', '1.0.0'))
    expect(existsSync(join(dshCacheRoot, 'commands', 'x.md'))).toBe(true)
    expect(discoveredIn(claudeHome, dshHome, cwd)).toEqual([dshCacheRoot])
    // W1: the claude home (stale install, enabled flag, marketplace clone) is byte-identical
    expect(await snapshotTree(claudeHome)).toEqual(claudeBefore)
  })
})
})
