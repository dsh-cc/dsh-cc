/**
 * install (C2): cache materialization, installed entry fields, enabledPlugins
 * write, multi-scope entries, resolution and already-installed errors.
 *
 * @module @dsh-cc/plugin-manager/test-install
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GitRunner } from '../src/git.ts'
import { installPlugin } from '../src/install.ts'
import { PluginManagerError } from '../src/errors.ts'
import { canonicalizeExistingPath } from '../src/paths.ts'
import { cleanupTemps, expectError, readJson, readRaw, rig, tempDir, type Rig } from './helpers.ts'

afterEach(cleanupTemps)

const NOW = () => new Date('2026-09-06T10:00:00.000Z')

function fakeGit(sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'): { runGit: GitRunner, calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runGit: async args => {
      calls.push(args)
      return { code: 0, stdout: `${sha}\n`, stderr: '' }
    },
  }
}

function deps(r: Rig, runGit?: GitRunner): any {
  return { claudeHome: r.claudeHome, cwd: r.cwd, now: NOW, ...(runGit ? { runGit } : {}) }
}

describe('install (C2)', () => {
  it('installs at user scope with the exact byte shapes (pinned now)', async () => {
    const r = await rig()
    const git = fakeGit()
    const result = await installPlugin(deps(r, git.runGit), 'formatter@internal')

    const cachePath = join(r.cacheDir, 'internal', 'formatter', '1.0.0')
    expect(result).toEqual({ id: 'formatter@internal', version: '1.0.0', scope: 'user', installPath: cachePath })
    expect(existsSync(join(cachePath, 'skill.md'))).toBe(true)
    expect(existsSync(join(cachePath, '.claude-plugin', 'plugin.json'))).toBe(true)
    // rev-parse HEAD captured for a git-backed marketplace (github source here)
    expect(git.calls).toContainEqual(['-C', r.marketplaceDir, 'rev-parse', 'HEAD'])

    const expectedInstalled = {
      version: 2,
      plugins: {
        'formatter@internal': [
          {
            scope: 'user',
            installPath: cachePath,
            version: '1.0.0',
            installedAt: '2026-09-06T10:00:00.000Z',
            lastUpdated: '2026-09-06T10:00:00.000Z',
            gitCommitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
          },
        ],
      },
    }
    expect(await readRaw(r.installedFile)).toBe(JSON.stringify(expectedInstalled, null, 2) + '\n')
    const settingsRaw = await readRaw(join(r.claudeHome, 'settings.json'))
    expect(settingsRaw).toBe(JSON.stringify({ enabledPlugins: { 'formatter@internal': true } }, null, 2) + '\n')
  })

  it('bare name resolves against declared plugins', async () => {
    const r = await rig()
    const result = await installPlugin(deps(r), 'linter')
    expect(result.id).toBe('linter@internal')
  })

  it('second install at project scope adds a separate entry with realpathed projectPath; user entry untouched', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    const result = await installPlugin(deps(r), 'formatter', { scope: 'project' })
    expect(result.scope).toBe('project')
    const installed = await readJson(r.installedFile)
    const entries = installed.plugins['formatter@internal']
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      scope: 'user',
      installPath: join(r.cacheDir, 'internal', 'formatter', '1.0.0'),
      version: '1.0.0',
      installedAt: '2026-09-06T10:00:00.000Z',
      lastUpdated: '2026-09-06T10:00:00.000Z',
    })
    expect(entries[1]).toEqual({
      scope: 'project',
      installPath: join(r.cacheDir, 'internal', 'formatter', '1.0.0'),
      version: '1.0.0',
      installedAt: '2026-09-06T10:00:00.000Z',
      lastUpdated: '2026-09-06T10:00:00.000Z',
      projectPath: canonicalizeExistingPath(r.cwd),
    })
    const projectSettings = await readJson(join(r.cwd, '.claude', 'settings.json'))
    expect(projectSettings['enabledPlugins']).toEqual({ 'formatter@internal': true })
  })

  it('already installed at that scope → exact error', async () => {
    const r = await rig()
    await installPlugin(deps(r), 'formatter')
    const error = await expectError(() => installPlugin(deps(r), 'formatter'))
    expect((error as PluginManagerError).message).toBe('Plugin "formatter@internal" is already installed at scope user on this machine.')
  })

  it('plugin manifest without version → cache dir ends in /unknown', async () => {
    const r = await rig()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(r.marketplaceDir, 'plugins', 'formatter', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'formatter' }), 'utf8')
    const result = await installPlugin(deps(r), 'formatter')
    expect(result.version).toBe('unknown')
    expect(result.installPath).toBe(join(r.cacheDir, 'internal', 'formatter', 'unknown'))
  })

  it('missing plugin manifest → tolerated as {name, version: unknown} (loader auto-discovery)', async () => {
    const r = await rig()
    const { rm } = await import('node:fs/promises')
    await rm(join(r.marketplaceDir, 'plugins', 'formatter', '.claude-plugin'), { recursive: true, force: true })
    const result = await installPlugin(deps(r), 'formatter')
    expect(result.version).toBe('unknown')
  })

  it('git rev-parse failure → gitCommitSha omitted silently', async () => {
    const r = await rig()
    const runGit: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
    await installPlugin(deps(r, runGit), 'formatter')
    const installed = await readJson(r.installedFile)
    expect(installed.plugins['formatter@internal'][0]['gitCommitSha']).toBeUndefined()
  })

  it('unknown marketplace → exact error', async () => {
    const r = await rig()
    const error = await expectError(() => installPlugin(deps(r), 'formatter@ghost'))
    expect((error as PluginManagerError).message).toBe('Unknown marketplace "ghost". Known: internal')
  })

  it('marketplace does not declare the plugin → exact error', async () => {
    const r = await rig()
    const error = await expectError(() => installPlugin(deps(r), 'ghost@internal'))
    expect((error as PluginManagerError).message).toBe('Marketplace "internal" does not declare a plugin named "ghost".')
  })

  it('unreadable marketplace manifest surfaces the S3 manifest error', async () => {
    const r = await rig()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(r.marketplaceDir, '.claude-plugin', 'marketplace.json'), '{not json', 'utf8')
    const error = await expectError(() => installPlugin(deps(r), 'formatter@internal'))
    expect((error as PluginManagerError).code).toBe('MARKETPLACE_MANIFEST_MISSING')
  })

  it('invalid scope → exact error', async () => {
    const r = await rig()
    const error = await expectError(() => installPlugin(deps(r), 'formatter', { scope: 'repo' }))
    expect((error as PluginManagerError).message).toBe('Unknown scope "repo". Expected user, project, or local.')
  })

  it('directory-source marketplace still attempts rev-parse and omits on failure', async () => {
    const r = await rig()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(r.knownFile, JSON.stringify({ internal: { source: { source: 'directory', path: r.marketplaceDir }, installLocation: r.marketplaceDir, lastUpdated: 'x' } }), 'utf8')
    const git = fakeGit()
    await installPlugin(deps(r, git.runGit), 'formatter')
    expect(git.calls).toContainEqual(['-C', r.marketplaceDir, 'rev-parse', 'HEAD'])
  })
})
