import { describe, expect, it } from 'vitest'
import {
  formatInstallResult,
  formatInstalledList,
  MANAGE_FOOTER,
  formatMarketplaceAdded,
  formatMarketplaceList,
  formatMarketplaceRemoved,
  formatMarketplacesUpdated,
  formatPluginHelp,
  formatToggleResult,
  formatUninstallResult,
  formatUpdateResult,
} from '../src/render-manage.ts'

describe('formatInstalledList', () => {
  it('renders the §3 list shape with a blank line after the header', () => {
    const text = formatInstalledList([
      { id: 'foo@bar', version: '1.2.0', scope: 'user', effectiveEnabled: true },
    ])
    expect(text).toBe([
      'Installed Claude Code plugins:',
      '',
      '  ❯ foo@bar',
      '    Version: 1.2.0',
      '    Scope: user',
      '    Status: ✔ enabled',
    ].join('\n'))
  })

  it('renders disabled status and the Overrides line only when a note exists', () => {
    const text = formatInstalledList([
      { id: 'a@m', version: '0.1.0', scope: 'project', effectiveEnabled: false, overrideNote: 'project=true, user=false' },
    ])
    expect(text).toContain('    Status: ✘ disabled')
    expect(text).toContain('    Overrides: project=true, user=false')
  })

  it('renders the empty placeholder when no rows are visible', () => {
    expect(formatInstalledList([])).toBe('No Claude Code plugins are installed (or none visible from this project).')
  })
})

describe('formatMarketplaceList', () => {
  it('renders directory, github, and git sources', () => {
    const text = formatMarketplaceList([
      { name: 'local-mkt', source: { source: 'directory', path: '/tmp/mkt' } },
      { name: 'gh', source: { source: 'github', repo: 'owner/repo' } },
      { name: 'git', source: { source: 'git', url: 'https://example.com/x.git' } },
    ])
    expect(text).toBe([
      'Configured marketplaces:',
      '',
      '  ❯ local-mkt',
      '    Source: Directory (/tmp/mkt)',
      '  ❯ gh',
      '    Source: GitHub (owner/repo)',
      '  ❯ git',
      '    Source: Git (https://example.com/x.git)',
    ].join('\n'))
  })

  it('renders the empty placeholder', () => {
    expect(formatMarketplaceList([])).toBe('No marketplaces are configured.')
  })
})

describe('§3 success lines (verbatim)', () => {
  it('install / uninstall / enable / disable', () => {
    expect(formatInstallResult({ id: 'foo@bar', version: '1.2.0', scope: 'user' }))
      .toBe('Installed plugin: foo@bar (scope: user, version: 1.2.0)')
    expect(formatUninstallResult({ id: 'foo@bar', scope: 'user' }))
      .toBe('Uninstalled plugin: foo@bar (scope: user)')
    expect(formatToggleResult('enable', { id: 'foo', scope: 'project' }))
      .toBe('Enabled plugin: foo (scope: project)')
    expect(formatToggleResult('disable', { id: 'foo', scope: 'local' }))
      .toBe('Disabled plugin: foo (scope: local)')
  })

  it('update: changed and up-to-date forms', () => {
    expect(formatUpdateResult({ upToDate: false, id: 'foo@bar', fromVersion: '1.0.0', toVersion: '2.0.0', scope: 'user' }))
      .toBe('Plugin "foo@bar" updated from 1.0.0 to 2.0.0 for scope user. Restart to apply changes (or /reload-plugins).')
    expect(formatUpdateResult({ upToDate: true, id: 'foo@bar', version: '1.0.0', scope: 'user' }))
      .toBe('Plugin "foo@bar" is already up to date (scope: user).')
  })

  it('marketplace add / remove / update forms', () => {
    expect(formatMarketplaceAdded({ name: 'gh', sourceKind: 'github', scope: 'user' }))
      .toBe('Added marketplace: gh (github, declared in user settings)')
    expect(formatMarketplaceRemoved({ name: 'gh', removedPlugins: ['a@gh', 'b@gh'] }))
      .toBe('Removed marketplace: gh (also uninstalled 2 plugin installation(s))')
    expect(formatMarketplacesUpdated(['one'])).toBe('Updated marketplace: one')
    expect(formatMarketplacesUpdated(['one', 'two'])).toBe('Updated 2 marketplaces.')
  })
})

describe('footer, warning, and help block', () => {
  it('footer names every manage form', () => {
    expect(MANAGE_FOOTER)
      .toBe('Manage: /plugin install|uninstall|enable|disable|update|list · /plugin marketplace add|remove|list|update')
  })

  it('help block lists the full grammar', () => {
    const help = formatPluginHelp()
    expect(help).toContain('/plugin list [--enabled|--disabled]')
    expect(help).toContain('/plugin install <plugin[@mkt]> [--scope user|project|local]')
    expect(help).toContain('/plugin marketplace update [name]')
    expect(help).toContain('/plugin help')
  })
})
