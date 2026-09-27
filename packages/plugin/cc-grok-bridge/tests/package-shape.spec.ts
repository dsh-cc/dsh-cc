/**
 * Package-shape pin for the cc-grok-bridge plugin distribution:
 * everything the package declares in `files` exists on disk, the nested CC
 * manifest stays in lockstep with the npm manifest (three-way description
 * lockstep with the marketplace stanza), the capability row exists, and the
 * .gitignore negation/ignore pair holds (guarded for git-less environments).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_DIR = dirname(import.meta.dirname)
const REPO_DIR = join(PKG_DIR, '..', '..', '..')

const hasGit = (() => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return !probe.error && probe.status === 0
})()

describe('packages/plugin/cc-grok-bridge package shape', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string
    version: string
    description: string
    files: string[]
  }
  const manifest = JSON.parse(
    readFileSync(join(PKG_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { name: string; version: string; description: string }

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-cc-grok-bridge')
    expect(pkg.private).not.toBe(true)
  })

  it('declares every shipped component in `files`, and each entry exists on disk', () => {
    expect(pkg.files).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json',
      'commands',
      'hooks',
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

  it('the commands directory holds the review command document', () => {
    expect(existsSync(join(PKG_DIR, 'commands', 'review.md'))).toBe(true)
    expect(readFileSync(join(PKG_DIR, 'commands', 'review.md'), 'utf8')).toContain(
      'If the SessionStart block is missing or reports NOT armed, STOP',
    )
  })

  it('the scripts/lib directory holds the shared lexer and argv parser', () => {
    expect(existsSync(join(PKG_DIR, 'scripts', 'lib', 'lexer.mjs'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'scripts', 'lib', 'argv.mjs'))).toBe(true)
  })

  it('the hooks directory holds the PreToolUse allow hook and its wiring', () => {
    expect(existsSync(join(PKG_DIR, 'hooks', 'hooks.json'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'hooks', 'grok-review-allow.mjs'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'hooks', 'grok-review-context.mjs'))).toBe(true)
  })

  it('the nested plugin manifest is name/version/description lockstep with package.json', () => {
    expect(manifest.name).toBe('cc-grok-bridge')
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.description).toBe(pkg.description)
  })

  it('three-way description lockstep: package.json / plugin.json / marketplace stanza', () => {
    const marketplace = JSON.parse(
      readFileSync(join(REPO_DIR, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string; source: string; description: string }> }
    const entry = marketplace.plugins.find((p) => p.name === 'cc-grok-bridge')
    expect(entry?.source).toBe('./packages/plugin/cc-grok-bridge')
    expect(entry?.description).toBe(pkg.description)
    expect(manifest.description).toBe(pkg.description)
  })

  it('the version is copied from the cc-codex-bridge package at implementation time (lockstep)', () => {
    const codex = JSON.parse(
      readFileSync(join(PKG_DIR, '..', 'cc-codex-bridge', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(pkg.version).toBe(codex.version)
  })

  it('the marketplace manifest lists the plugin', () => {
    const marketplace = JSON.parse(
      readFileSync(join(REPO_DIR, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string; source: string }> }
    expect(marketplace.plugins.find((p) => p.name === 'cc-grok-bridge')).toBeDefined()
  })

  it('the capability doc carries the plugins.grok-bridge row', () => {
    const caps = readFileSync(join(REPO_DIR, 'docs', 'claude-code-capabilities.yaml'), 'utf8')
    expect(caps).toContain('plugins.grok-bridge:')
    expect(caps).toContain('docs/plans/2026-09-27-grok-review-bridge.md')
  })

  it('git check-ignore: scripts/lib/argv.mjs is tracked (negation holds), tests/.runtime/ is ignored', () => {
    if (!hasGit) return expect(true).toBe(true) // no git in this environment — skip silently
    const tracked = spawnSync('git', ['check-ignore', '--quiet', 'packages/plugin/cc-grok-bridge/scripts/lib/argv.mjs'], {
      cwd: REPO_DIR,
    })
    expect(tracked.status).not.toBe(0) // non-match: NOT ignored
    const ignored = spawnSync('git', ['check-ignore', '--quiet', 'packages/plugin/cc-grok-bridge/tests/.runtime/x'], {
      cwd: REPO_DIR,
    })
    expect(ignored.status).toBe(0) // match: ignored
  })
})
