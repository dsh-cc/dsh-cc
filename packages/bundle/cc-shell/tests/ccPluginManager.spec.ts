import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSessionCcPluginManager } from '../src/ccPluginManager.ts'

const tmpRoots: string[] = []

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

/** Seed a minimal installed-plugin state in a tmp CLAUDE_CONFIG_DIR (C10 shapes). */
function seedState(): { claudeHome: string, settingsFile: string } {
  const claudeHome = mkdtempSync(join(tmpdir(), 'cc-plugin-manager-'))
  tmpRoots.push(claudeHome)
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true })
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'foo@bar': [{
        scope: 'user',
        installPath: join(claudeHome, 'plugins', 'cache', 'bar', 'foo', '1.0.0'),
        version: '1.0.0',
        installedAt: '2026-09-06T00:00:00.000Z',
        lastUpdated: '2026-09-06T00:00:00.000Z',
      }],
    },
  }, null, 2) + '\n')
  const settingsFile = join(claudeHome, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: { 'foo@bar': true } }, null, 2) + '\n')
  return { claudeHome, settingsFile }
}

/** Both env vars must be seeded to tmp dirs: `createSessionCcPluginManager`
 * resolves dual-home, and an unset `DSH_HOME` would point writes at the real
 * `~/.dsh`. */
function seedHomes(): { dshHome: string, previous: { dsh: string | undefined, claude: string | undefined } } {
  const dshHome = mkdtempSync(join(tmpdir(), 'cc-plugin-manager-dsh-'))
  tmpRoots.push(dshHome)
  const previous = {
    dsh: process.env['DSH_HOME'],
    claude: process.env['CLAUDE_CONFIG_DIR'],
  }
  process.env['DSH_HOME'] = dshHome
  return { dshHome, previous }
}

function restoreHomes(previous: { dsh: string | undefined, claude: string | undefined }): void {
  if (previous.dsh === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previous.dsh
  if (previous.claude === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = previous.claude
}

describe('ccPluginManager service', () => {
  it('registers under `ccPluginManager` via createSessionCcPluginManager (manager surface present)', () => {
    const { previous } = seedHomes()
    try {
      const manager = createSessionCcPluginManager()
      expect(typeof manager.list).toBe('function')
      expect(typeof manager.enable).toBe('function')
      expect(typeof manager.disable).toBe('function')
      expect(typeof manager.install).toBe('function')
      expect(typeof manager.uninstall).toBe('function')
      expect(typeof manager.update).toBe('function')
      expect(typeof manager.listMarketplaces).toBe('function')
      expect(typeof manager.addMarketplace).toBe('function')
      expect(typeof manager.removeMarketplace).toBe('function')
      expect(typeof manager.updateMarketplaces).toBe('function')
    } finally {
      restoreHomes(previous)
    }
  })

  it('writes plugin state to the dsh home: a disable lands in $DSH_HOME settings end-to-end', async () => {
    const { claudeHome, settingsFile } = seedState()
    const { dshHome, previous } = seedHomes()
    process.env['CLAUDE_CONFIG_DIR'] = claudeHome
    try {
      const manager = createSessionCcPluginManager()
      const result = await manager.disable('foo')
      expect(result).toEqual({ id: 'foo@bar', scope: 'user', enabled: false })
      // The disable landed in the dsh user settings (key kept, value false);
      // the Claude-home settings file stays untouched.
      const dshSettings = JSON.parse(readFileSync(join(dshHome, 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, boolean> }
      expect(dshSettings.enabledPlugins['foo@bar']).toBe(false)
      const claudeSettings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { enabledPlugins: Record<string, boolean> }
      expect(claudeSettings.enabledPlugins['foo@bar']).toBe(true)
    } finally {
      restoreHomes(previous)
    }
  })
})
