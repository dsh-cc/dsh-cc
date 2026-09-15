/**
 * Cursor dialect S1: candidate-dir precedence, flavor recording, dual-manifest
 * warning, and enable/disable round-trips for cursor-flavored plugins.
 *
 * @module
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountCcPlugin } from '../src/index.ts'
import { discoverCcPluginRoots } from '../src/discovery.ts'
import { makeContext } from './helpers.ts'

const cursorFixtures = join(import.meta.dirname, 'fixtures', 'cursor')

const allSeams = () => ({
  commands: { register: () => () => {} },
  settings: { set: () => () => {} },
  skills: { register: () => () => {} },
  subagents: { registerProvider: () => () => {}, getProvider: () => undefined },
  hooks: { mergePluginHooks: () => () => {} },
  mcp: { registerServer: () => () => {} },
})

const byKind = (report: { components: readonly { kind: string; loaded: number }[] }) =>
  Object.fromEntries(report.components.map(c => [c.kind, c]))

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

describe('cursor flavor recording', () => {
  it('mounts a minimal cursor plugin with flavor cursor and default components', async () => {
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root: join(cursorFixtures, 'minimal'), seams: allSeams() })
    try {
      expect(mount.report.flavor).toBe('cursor')
      expect(mount.report.name).toBe('cursor-minimal')
      const byKindReport = byKind(mount.report)
      // S2: cursor flavor accepts commands/*.txt too (hi.md + bye.txt).
      expect(byKindReport['commands']?.loaded).toBe(2)
      expect(byKindReport['skills']?.loaded).toBe(1)
      expect(byKindReport['agents']?.loaded).toBe(1)
      expect(byKindReport['hooks']?.loaded).toBeGreaterThan(0)
    } finally {
      mount.dispose()
    }
  })

  it('honors declared component paths in a cursor manifest', async () => {
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root: join(cursorFixtures, 'declared-paths'), seams: allSeams() })
    try {
      expect(mount.report.flavor).toBe('cursor')
      const byKindReport = byKind(mount.report)
      expect(byKindReport['skills']?.loaded).toBe(1)
      expect(byKindReport['commands']?.loaded).toBe(1)
      expect(byKindReport['agents']?.loaded).toBe(1)
      expect(mount.commands.map(c => c.info.name)).toContain('cursor-declared-paths:plan')
    } finally {
      mount.dispose()
    }
  })

  it('keeps top-level plugin.json fallback flavor cc', async () => {
    const root = await tempDir('cc-top-level-')
    await writeJson(join(root, 'plugin.json'), { name: 'legacy-p' })
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root, seams: allSeams() })
    try {
      expect(mount.report.flavor).toBe('cc')
      expect(mount.report.warnings).toEqual([])
    } finally {
      mount.dispose()
    }
  })

  it('prefers the cc nested manifest on dual manifests and records a warning', async () => {
    const ctx = makeContext()
    const mount = await mountCcPlugin(ctx, { root: join(cursorFixtures, 'dual-manifest'), seams: allSeams() })
    try {
      expect(mount.report.flavor).toBe('cc')
      expect(mount.report.warnings).toEqual(['cursor manifest ignored: cc manifest takes precedence'])
    } finally {
      mount.dispose()
    }
  })
})

describe('cursor plugin enable/disable round-trip', () => {
  it('rediscovers and remounts a cursor plugin across disable/re-enable with env-seeded homes', async () => {
    const install = await tempDir('cursor-install-')
    await writeJson(join(install, '.cursor-plugin', 'plugin.json'), { name: 'round-trip' })
    await writeJson(join(install, 'commands', 'go.md'), 'go body')
    const claudeHome = await tempDir('cursor-claude-home-')
    const dshHome = await tempDir('cursor-dsh-home-')
    const cwd = await tempDir('cursor-cwd-')
    await writeJson(join(claudeHome, 'settings.json'), { enabledPlugins: { 'round-trip@mkt': true } })
    await writeJson(join(dshHome, 'settings.json'), {})
    await writeJson(join(claudeHome, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'round-trip@mkt': [{ scope: 'user', installPath: install }] },
    })
    await writeJson(join(dshHome, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {} })

    const prevClaude = process.env.CLAUDE_CONFIG_DIR
    const prevDsh = process.env.DSH_HOME
    process.env.CLAUDE_CONFIG_DIR = claudeHome
    process.env.DSH_HOME = dshHome
    try {
      const mountOnce = async () => {
        const [found] = discoverCcPluginRoots({ cwd })
        expect(found?.root).toBe(install)
        const ctx = makeContext()
        const mount = await mountCcPlugin(ctx, { root: found!.root, nameHint: found!.nameHint, seams: allSeams() })
        expect(mount.report.flavor).toBe('cursor')
        expect(byKind(mount.report)['commands']?.loaded).toBe(1)
        return mount
      }
      const first = await mountOnce()
      first.dispose() // disable
      const second = await mountOnce() // re-enable + remount
      second.dispose()
    } finally {
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevClaude
      if (prevDsh === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevDsh
    }
  })
})
