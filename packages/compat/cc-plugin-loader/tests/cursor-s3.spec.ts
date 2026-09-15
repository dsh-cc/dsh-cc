/**
 * Cursor dialect S3: end-to-end loader mounting of the fixture pack via
 * directory discovery (`pluginDirs`) in isolated dual homes. Exercises the
 * full resolve → parse → mount → report pipeline per fixture, including the
 * rules skipped-tally (mounting itself is PR-B).
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCcPluginRoots, mountCcPlugin } from '../src/index.ts'
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

const byKind = (report: { components: readonly { kind: string; loaded: number; skipped: number; reasons: readonly string[] }[] }) =>
  Object.fromEntries(report.components.map(c => [c.kind, c]))

let homes: string
let previousClaude: string | undefined
let previousDsh: string | undefined

beforeEach(async () => {
  // House rule: isolated dual homes — never the real ones.
  homes = await mkdtemp(join(tmpdir(), 'cursor-s3-homes-'))
  previousClaude = process.env['CLAUDE_CONFIG_DIR']
  previousDsh = process.env['DSH_HOME']
  process.env['CLAUDE_CONFIG_DIR'] = homes
  process.env['DSH_HOME'] = homes
})

afterEach(async () => {
  if (previousClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = previousClaude
  if (previousDsh === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousDsh
  await rm(homes, { recursive: true, force: true })
})

/** Discover the fixture pack via pluginDirs and mount one discovered root. */
async function mountFixture(fixture: string, seams = allSeams()) {
  const roots = discoverCcPluginRoots({ pluginDirs: [cursorFixtures] })
  const found = roots.find(entry => entry.root === join(cursorFixtures, fixture))
  expect(found, `fixture ${fixture} discovered`).toBeDefined()
  const ctx = makeContext()
  return { mount: await mountCcPlugin(ctx, { root: found!.root, nameHint: found!.nameHint, seams }), ctx }
}

describe('S3: minimal fixture via pluginDirs discovery', () => {
  it('mounts all default-path components with cursor flavor', async () => {
    const merged: { name: string; config: Record<string, unknown> }[] = []
    const { mount } = await mountFixture('minimal', {
      ...allSeams(),
      hooks: { mergePluginHooks: (name, config) => { merged.push({ name, config }); return () => {} } },
      mcp: { registerServer: () => () => {} },
    })
    try {
      expect(mount.report.name).toBe('cursor-minimal')
      expect(mount.report.flavor).toBe('cursor')
      expect(byKind(mount.report)['skills']?.loaded).toBe(1)
      expect(byKind(mount.report)['agents']?.loaded).toBe(1)
      expect(byKind(mount.report)['commands']?.loaded).toBe(2)
      expect(byKind(mount.report)['mcpServers']?.loaded).toBe(1)
      // Hooks: only mapped cursor events reach the seam.
      expect(merged).toHaveLength(1)
      expect(merged[0].name).toBe('cursor-minimal')
      expect(Object.keys(merged[0].config).sort()).toEqual([
        'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'SessionEnd',
        'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit',
      ])
      const hooks = byKind(mount.report)['hooks']
      expect(hooks?.loaded).toBe(1)
      expect(hooks?.reasons.some(r => r.includes('afterAgentResponse'))).toBe(true)
      // Rules: tallied skipped-with-reason (mounting is PR-B).
      const rules = byKind(mount.report)['rules']
      expect(rules?.skipped).toBe(1)
      expect(rules?.reasons[0]).toContain('"rules"')
    } finally {
      mount.dispose()
    }
  })

  it('carries no metadata warnings for a bare fixture', async () => {
    const { mount } = await mountFixture('minimal')
    try {
      expect(mount.report.warnings).toEqual([])
    } finally {
      mount.dispose()
    }
  })
})

describe('S3: declared-paths fixture', () => {
  it('honors manifest-declared paths including the agents/** walk', async () => {
    const { mount } = await mountFixture('declared-paths')
    try {
      expect(byKind(mount.report)['skills']?.loaded).toBe(1)
      expect(byKind(mount.report)['agents']?.loaded).toBe(1)
      expect(byKind(mount.report)['commands']?.loaded).toBe(1)
      const rules = byKind(mount.report)['rules']
      expect(rules?.skipped).toBe(1)
      expect(rules?.reasons[0]).toContain('rules/*.mdc')
    } finally {
      mount.dispose()
    }
  })
})

describe('S3: github-mcp fixture', () => {
  it('honors the "./mcp.json" path and warns on variables/minClientVersions', async () => {
    const registered: string[] = []
    const { mount } = await mountFixture('github-mcp', {
      ...allSeams(),
      mcp: { registerServer: name => { registered.push(name); return () => {} } },
    })
    try {
      expect(mount.report.flavor).toBe('cursor')
      // The ${GITHUB_PERSONAL_ACCESS_TOKEN} var is unset: server skipped, not thrown.
      expect(registered).toEqual([])
      const mcp = byKind(mount.report)['mcpServers']
      expect(mcp?.skipped).toBe(1)
      expect(mcp?.reasons.join(' ')).toContain('GITHUB_PERSONAL_ACCESS_TOKEN')
      expect(mount.report.warnings).toContain('client-version gating is not enforced')
      expect(mount.report.warnings).toContain('plugin variables are not prompted; set values via environment')
    } finally {
      mount.dispose()
    }
  })
})

describe('S3: dual-manifest fixture', () => {
  it('cc manifest wins; precedence warning reaches report.warnings', async () => {
    const { mount } = await mountFixture('dual-manifest')
    try {
      expect(mount.report.name).toBe('dual-dialect')
      expect(mount.report.flavor).toBe('cc')
      expect(mount.report.warnings).toContain('cursor manifest ignored: cc manifest takes precedence')
    } finally {
      mount.dispose()
    }
  })
})
