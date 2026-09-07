/**
 * Declared-plugin id resolution (S4): `resolveDeclaredPluginId` against
 * marketplace declarations and `readDeclaredPlugins` manifest reads.
 *
 * @module @dsh-cc/plugin-manager/test-declared
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { readDeclaredPlugins, resolveDeclaredPluginId } from '../src/resolve-id.ts'
import { PluginManagerError } from '../src/errors.ts'
import { cleanupTemps, expectError, readJson, rig, tempDir } from './helpers.ts'

afterEach(cleanupTemps)

const declared = new Map<string, readonly string[]>([
  ['internal', ['formatter@internal', 'linter@internal']],
  ['extra', ['formatter@extra']],
])

describe('resolveDeclaredPluginId', () => {
  it('exact full id that is declared resolves to itself (idempotent)', () => {
    expect(resolveDeclaredPluginId('formatter@internal', declared)).toBe('formatter@internal')
    expect(resolveDeclaredPluginId('formatter@extra', declared)).toBe('formatter@extra')
  })

  it('exact full id not declared by that marketplace → exact error', async () => {
    const error = await expectError(async () => resolveDeclaredPluginId('ghost@internal', declared))
    expect((error as PluginManagerError).message).toBe('Marketplace "internal" does not declare a plugin named "ghost".')
  })

  it('bare name with exactly one declaring marketplace resolves uniquely', () => {
    expect(resolveDeclaredPluginId('linter', declared)).toBe('linter@internal')
  })

  it('bare name declared by multiple marketplaces → exact ambiguous error', async () => {
    const error = await expectError(async () => resolveDeclaredPluginId('formatter', declared))
    expect((error as PluginManagerError).message).toBe('Plugin name "formatter" is ambiguous: formatter@extra, formatter@internal. Use the full <name>@<marketplace> id.')
  })

  it('bare name declared nowhere → Unknown … Declared: sorted ids', async () => {
    const error = await expectError(async () => resolveDeclaredPluginId('nope', declared))
    expect((error as PluginManagerError).message).toBe('Unknown plugin "nope". Declared: formatter@extra, formatter@internal, linter@internal')
  })

  it('bare name with empty map → Declared: (none)', async () => {
    const error = await expectError(async () => resolveDeclaredPluginId('nope', new Map()))
    expect((error as PluginManagerError).message).toBe('Unknown plugin "nope". Declared: (none)')
  })
})

describe('readDeclaredPlugins', () => {
  it('reads the marketplace manifest and returns name+source pairs', async () => {
    const r = await rig()
    const declaredPlugins = await readDeclaredPlugins({ claudeHome: r.claudeHome, cwd: r.cwd }, 'internal')
    expect(declaredPlugins).toEqual([
      { name: 'formatter', source: 'plugins/formatter' },
      { name: 'linter', source: 'plugins/linter' },
    ])
  })

  it('object source form → exact unsupported-source error', async () => {
    const r = await rig()
    const manifestFile = join(r.marketplaceDir, '.claude-plugin', 'marketplace.json')
    await writeFile(manifestFile, JSON.stringify({ name: 'internal', plugins: [{ name: 'bad', source: { source: 'directory', path: 'x' } }] }), 'utf8')
    const error = await expectError(() => readDeclaredPlugins({ claudeHome: r.claudeHome, cwd: r.cwd }, 'internal'))
    expect((error as PluginManagerError).message).toBe('Plugin "bad@internal" uses an unsupported source form (v1 supports directory strings).')
  })

  it('missing manifest → the S3 manifest-missing error', async () => {
    const r = await rig()
    await writeFile(r.knownFile, JSON.stringify({ broken: { source: { source: 'github', repo: 'a/b' }, installLocation: join(r.marketplacesDir, 'broken'), lastUpdated: 'x' } }), 'utf8')
    const error = await expectError(() => readDeclaredPlugins({ claudeHome: r.claudeHome, cwd: r.cwd }, 'broken'))
    expect((error as PluginManagerError).code).toBe('MARKETPLACE_MANIFEST_MISSING')
    expect(error.message).toContain('has no readable .claude-plugin/marketplace.json')
  })

  it('unknown marketplace → the S3 unknown-marketplace error', async () => {
    const r = await rig()
    const error = await expectError(() => readDeclaredPlugins({ claudeHome: r.claudeHome, cwd: r.cwd }, 'ghost'))
    expect((error as PluginManagerError).message).toBe('Unknown marketplace "ghost". Known: internal')
  })

  it('round-trips through JSON fixtures intact', async () => {
    const r = await rig()
    const manifest = await readJson(join(r.marketplaceDir, '.claude-plugin', 'marketplace.json'))
    expect(manifest['name']).toBe('internal')
  })
})
