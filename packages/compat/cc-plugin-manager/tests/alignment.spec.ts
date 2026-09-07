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
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCcPluginManager } from '../src/index.ts'
// The loader's package root (`@dsh-cc/plugin-loader`) pulls the full mount
// chain (skills/agents/… → harness packages whose `link:` deps dangle in
// this worktree); the discovery surface alone is the interop contract under
// test. Same pattern as the loader's own discovery.spec.ts (src import).
import { discoverCcPluginRoots } from '../../cc-plugin-loader/src/discovery.ts'

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
