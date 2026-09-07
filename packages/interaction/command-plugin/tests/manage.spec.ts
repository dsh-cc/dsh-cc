import { describe, expect, it, vi } from 'vitest'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { executePluginManage, type CcPluginManagerSeam } from '../src/manage.ts'
import type { CcPluginsSeam } from '../src/index.ts'

function invocation(rawInput: string): CommandInvocation {
  return { rawInput } as unknown as CommandInvocation
}

function fakeManager(overrides: Partial<CcPluginManagerSeam> = {}): CcPluginManagerSeam {
  return {
    list: vi.fn(async () => [
      { id: 'foo@bar', version: '1.0.0', scope: 'user', effectiveEnabled: true },
    ]),
    enable: vi.fn(async () => ({ id: 'foo', scope: 'user', enabled: true })),
    disable: vi.fn(async () => ({ id: 'foo', scope: 'user', enabled: false })),
    install: vi.fn(async () => ({ id: 'foo@bar', version: '1.0.0', scope: 'user', installPath: '/p' })),
    uninstall: vi.fn(async () => ({ id: 'foo@bar', scope: 'user' })),
    update: vi.fn(async () => ({ upToDate: false, id: 'foo@bar', fromVersion: '1.0.0', toVersion: '2.0.0', scope: 'user' })),
    listMarketplaces: vi.fn(async () => [{ name: 'gh', source: { source: 'github', repo: 'owner/repo' } }]),
    addMarketplace: vi.fn(async () => ({ name: 'gh', sourceKind: 'github', pluginCount: 1 })),
    removeMarketplace: vi.fn(async () => ({ name: 'gh', removedPlugins: ['a@gh'] })),
    updateMarketplaces: vi.fn(async () => ['gh']),
    ...overrides,
  }
}

function fakeCcPlugins(): CcPluginsSeam & { rescan: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(() => [{ name: 'mounted-a', root: '/r/a', components: [] }]),
    rescan: vi.fn(async () => []),
  } as CcPluginsSeam & { rescan: ReturnType<typeof vi.fn> }
}

const deps = (ccPlugins: CcPluginsSeam | undefined, manager: CcPluginManagerSeam | undefined) => ({
  ctx: undefined,
  ccPlugins,
  ccPluginManager: manager,
})

describe('executePluginManage — bare /plugin', () => {
  it('renders the mounted view plus the manage footer', async () => {
    const ccPlugins = fakeCcPlugins()
    const result = await executePluginManage(deps(ccPlugins, undefined), invocation(''))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Mounted Claude Code plugins:')
    expect(result.text?.endsWith('Manage: /plugin install|uninstall|enable|disable|update|list · /plugin marketplace add|remove|list|update')).toBe(true)
  })

  it('reports the registry-absent sentence when ccPlugins is missing', async () => {
    const result = await executePluginManage(deps(undefined, undefined), invocation(''))
    expect(result.text).toBe('No plugin registry is mounted in this composition (cc-shell-glue absent).')
  })
})

describe('executePluginManage — manager seam absent', () => {
  it('reports the graceful sentence for manage verbs', async () => {
    for (const raw of ['list', 'install foo', 'marketplace list']) {
      const result = await executePluginManage(deps(fakeCcPlugins(), undefined), invocation(raw))
      expect(result.text).toBe('No plugin manager is mounted in this composition (cc-shell-glue absent).')
    }
  })
})

describe('executePluginManage — mutations rescan and render §3 lines', () => {
  it('install appends the trust warning and rescans', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    const result = await executePluginManage(deps(ccPlugins, manager), invocation('install foo@bar'))
    expect(result.text).toBe([
      'Installed plugin: foo@bar (scope: user, version: 1.0.0)',
      'Note: plugins can add hooks and MCP servers; only install from sources you trust.',
    ].join('\n'))
    expect(manager.install).toHaveBeenCalledWith('foo@bar', { scope: undefined })
    expect(ccPlugins.rescan).toHaveBeenCalledTimes(1)
  })

  it('uninstall/enable/disable render the bare success line and rescan', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('uninstall foo'))).text)
      .toBe('Uninstalled plugin: foo@bar (scope: user)')
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('enable foo'))).text)
      .toBe('Enabled plugin: foo (scope: user)')
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('disable foo --scope local'))).text)
      .toBe('Disabled plugin: foo (scope: user)')
    expect(ccPlugins.rescan).toHaveBeenCalledTimes(3)
  })

  it('update renders the changed-version string and rescans', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('update foo'))).text)
      .toBe('Plugin "foo@bar" updated from 1.0.0 to 2.0.0 for scope user. Restart to apply changes (or /reload-plugins).')
    expect(ccPlugins.rescan).toHaveBeenCalledTimes(1)
  })

  it('marketplace add of a remote source appends the trust warning; directory does not', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager({
      addMarketplace: vi.fn(async () => ({ name: 'm', sourceKind: 'directory', pluginCount: 0 })),
    })
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('marketplace add /tmp/m'))).text)
      .toBe('Added marketplace: m (directory, declared in user settings)')
    const remote = fakeManager()
    expect((await executePluginManage(deps(ccPlugins, remote), invocation('marketplace add owner/repo'))).text)
      .toBe([
        'Added marketplace: gh (github, declared in user settings)',
        'Note: plugins can add hooks and MCP servers; only install from sources you trust.',
      ].join('\n'))
    expect(ccPlugins.rescan).toHaveBeenCalledTimes(2)
  })

  it('marketplace remove and update rescan and render their lines', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('marketplace remove gh'))).text)
      .toBe('Removed marketplace: gh (also uninstalled 1 plugin installation(s))')
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('marketplace update'))).text)
      .toBe('Updated marketplace: gh')
    expect(ccPlugins.rescan).toHaveBeenCalledTimes(2)
  })
})

describe('executePluginManage — reads do not rescan', () => {
  it('list renders rows without touching rescan', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    const result = await executePluginManage(deps(ccPlugins, manager), invocation('list --enabled'))
    expect(result.text).toContain('Installed Claude Code plugins:')
    expect(manager.list).toHaveBeenCalledWith({ enabled: true })
    expect(ccPlugins.rescan).not.toHaveBeenCalled()
  })

  it('marketplace list renders without rescan', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    expect((await executePluginManage(deps(ccPlugins, manager), invocation('marketplace list'))).text)
      .toBe(['Configured marketplaces:', '', '  ❯ gh', '    Source: GitHub (owner/repo)'].join('\n'))
    expect(ccPlugins.rescan).not.toHaveBeenCalled()
  })

  it('parse errors render the usage line without touching either seam', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager()
    const result = await executePluginManage(deps(ccPlugins, manager), invocation('install'))
    expect(result.text).toBe('Usage: /plugin install <plugin[@mkt]> [--scope user|project|local]')
    expect(ccPlugins.rescan).not.toHaveBeenCalled()
    expect(manager.install).not.toHaveBeenCalled()
  })
})

describe('executePluginManage — errors', () => {
  it('renders a PluginManagerError message only (no stack, success kind)', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager({
      install: vi.fn(async () => {
        // Duck-typed PluginManagerError: the manager core sets `name` to
        // 'PluginManagerError' on every catalog error.
        const error = new Error('Unknown plugin "foo". Installed: none')
        error.name = 'PluginManagerError'
        throw error
      }),
    })
    const result = await executePluginManage(deps(ccPlugins, manager), invocation('install foo'))
    expect(result.kind).toBe('success')
    expect(result.text).toBe('Unknown plugin "foo". Installed: none')
    expect(result.text).not.toContain('at ')
    expect(ccPlugins.rescan).not.toHaveBeenCalled()
  })

  it('propagates non-PluginManagerError failures', async () => {
    const ccPlugins = fakeCcPlugins()
    const manager = fakeManager({
      install: vi.fn(async () => {
        throw new TypeError('boom')
      }),
    })
    await expect(executePluginManage(deps(ccPlugins, manager), invocation('install foo'))).rejects.toThrow(TypeError)
  })
})
