/**
 * Package-shape pin for the official plugin distribution
 * (docs/plans/2026-09-07-official-agents-plugin.md §5.3): everything the
 * package declares in `files` exists on disk, and the nested CC manifest
 * stays in lockstep with the npm manifest — so the published artifact can
 * never silently lose a component the loader mounts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_DIR = dirname(import.meta.dirname)

describe('packages/plugin/dsh-cc-agents package shape', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string
    version: string
    files: string[]
  }

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-dsh-cc-agents')
    expect(pkg.private).not.toBe(true)
  })

  it('declares every shipped component in `files`, and each entry exists on disk', () => {
    expect(pkg.files).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json',
      'agents',
      'skills',
      'README.md',
    ]))
    for (const entry of pkg.files) {
      const path = join(PKG_DIR, entry)
      expect(existsSync(path), `files entry "${entry}" exists`).toBe(true)
      if (statSync(path).isDirectory()) {
        // A directory entry ships only when it is non-empty (npm pack drops
        // empty dirs) — so a lost agents/ or skills/ tree fails here.
        expect(readdirSync(path).length, `files dir "${entry}" non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it('the agents directory holds both agent definitions', () => {
    expect(existsSync(join(PKG_DIR, 'agents', 'critic.md'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'agents', 'executor.md'))).toBe(true)
  })

  it('keeps the Output contract section in lockstep with the repo agents (drift guard)', () => {
    const repoRoot = join(PKG_DIR, '..', '..', '..')
    // repo .claude/agents file → plugin distribution copy
    const pairs = [
      ['deep-reasoner.md', 'critic.md'],
      ['fast-worker.md', 'executor.md'],
    ] as const
    const section = (text: string): string => {
      const match = text.match(/^## Output contract.*?$/m)
      expect(match, '## Output contract heading exists').not.toBeNull()
      const start = match!.index! + match![0].length
      const rest = text.slice(start)
      const next = rest.indexOf('\n## ')
      return next === -1 ? rest : rest.slice(0, next)
    }
    for (const [repoName, pluginName] of pairs) {
      const repo = readFileSync(join(repoRoot, '.claude', 'agents', repoName), 'utf8')
      const plugin = readFileSync(join(PKG_DIR, 'agents', pluginName), 'utf8')
      expect(
        section(plugin),
        `Output contract of plugin ${pluginName} must be identical to repo ${repoName}`,
      ).toBe(section(repo))
    }
  })

  it('the skills directory holds the uniquely-named orchestration skill', () => {
    expect(existsSync(join(PKG_DIR, 'skills', 'dsh-cc-agents-orchestration', 'SKILL.md'))).toBe(true)
  })

  it('the nested plugin manifest is name/version lockstep with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(PKG_DIR, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string }
    expect(manifest.name).toBe('dsh-cc-agents')
    expect(manifest.version).toBe(pkg.version)
  })
})
