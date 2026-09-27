/**
 * Package-shape pin for the cc-codex-bridge plugin distribution:
 * everything the package declares in `files` exists on disk, and the nested
 * CC manifest stays in lockstep with the npm manifest — so the published
 * artifact can never silently lose a component the loader mounts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_DIR = dirname(import.meta.dirname)

describe('packages/plugin/cc-codex-bridge package shape', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string
    version: string
    files: string[]
  }

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-cc-codex-bridge')
    expect(pkg.private).not.toBe(true)
  })

  it('declares every shipped component in `files`, and each entry exists on disk', () => {
    expect(pkg.files).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json',
      'commands',
      'scripts',
      'README.md',
    ]))
    for (const entry of pkg.files) {
      const path = join(PKG_DIR, entry)
      expect(existsSync(path), `files entry "${entry}" exists`).toBe(true)
      if (statSync(path).isDirectory()) {
        // A directory entry ships only when it is non-empty (npm pack drops
        // empty dirs) — so a lost commands/ or scripts/ tree fails here.
        expect(readdirSync(path).length, `files dir "${entry}" non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it('the commands directory holds the rescue command document', () => {
    expect(existsSync(join(PKG_DIR, 'commands', 'rescue.md'))).toBe(true)
  })

  it('the scripts/lib directory holds the shared lexer and argv parser', () => {
    expect(existsSync(join(PKG_DIR, 'scripts', 'lib', 'lexer.mjs'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'scripts', 'lib', 'argv.mjs'))).toBe(true)
  })

  it('the nested plugin manifest is name/version lockstep with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(PKG_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string }
    expect(manifest.name).toBe('cc-codex-bridge')
    expect(manifest.version).toBe(pkg.version)
  })

  it('the marketplace manifest lists the plugin', () => {
    const marketplace = JSON.parse(
      readFileSync(join(PKG_DIR, '..', '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string; source: string }> }
    const entry = marketplace.plugins.find((p) => p.name === 'cc-codex-bridge')
    expect(entry?.source).toBe('./packages/plugin/cc-codex-bridge')
  })
})
