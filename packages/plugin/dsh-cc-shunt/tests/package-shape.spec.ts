/**
 * Package-shape pin for the official dsh-cc-shunt plugin distribution:
 * everything the package declares in `files` exists on disk, and the nested
 * CC manifest stays in lockstep with the npm manifest — so the published
 * artifact can never silently lose a component the loader mounts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_DIR = dirname(import.meta.dirname)

describe('packages/plugin/dsh-cc-shunt package shape', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string
    version: string
    files: string[]
  }

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-dsh-cc-shunt')
    expect(pkg.private).not.toBe(true)
  })

  it('declares every shipped component in `files`, and each entry exists on disk', () => {
    expect(pkg.files).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json',
      'agents',
      'hooks',
      'skills',
      'README.md',
    ]))
    for (const entry of pkg.files) {
      const path = join(PKG_DIR, entry)
      expect(existsSync(path), `files entry "${entry}" exists`).toBe(true)
      if (statSync(path).isDirectory()) {
        // A directory entry ships only when it is non-empty (npm pack drops
        // empty dirs) — so a lost agents/ or hooks/ or skills/ tree fails here.
        expect(readdirSync(path).length, `files dir "${entry}" non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it('the agents directory holds both shunt-worker definitions', () => {
    expect(existsSync(join(PKG_DIR, 'agents', 'shunt-reader.md'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'agents', 'shunt-writer.md'))).toBe(true)
  })

  it('the skills directory holds both delegation skills', () => {
    expect(existsSync(join(PKG_DIR, 'skills', 'bulk-reader', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'skills', 'code-writer', 'SKILL.md'))).toBe(true)
  })

  it('the hooks directory holds the gate manifest and both hook scripts', () => {
    expect(existsSync(join(PKG_DIR, 'hooks', 'hooks.json'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'hooks', 'check-file-size.mjs'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'hooks', 'check-bash-read.mjs'))).toBe(true)
  })

  it('the nested plugin manifest is name/version lockstep with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(PKG_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string }
    expect(manifest.name).toBe('dsh-cc-shunt')
    expect(manifest.version).toBe(pkg.version)
  })
})
