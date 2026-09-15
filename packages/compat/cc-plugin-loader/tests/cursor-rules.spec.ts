/**
 * Cursor dialect S4: the `rules` guest seam (plan §3.3). Rules discovered from
 * the plugin `rules` directory and manifest-declared `rules` paths (append-default-dir,
 * S2 glob policy) parse typed frontmatter (`alwaysApply` boolean, `globs`
 * inline AND block YAML list forms) and merge through the optional `rules`
 * seam with copy-on-write disposal — mirroring the PR #16 hooks seam tests.
 * When the seam is absent the component stays a skipped tally. CC-flavored
 * plugins declare no `rules` and gain nothing.
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginManifest } from '../src/manifest.ts'
import { discoverCcPluginRoots, mountCcPlugin } from '../src/index.ts'
import { makeContext, writeFileAt } from './helpers.ts'

const cursorFixtures = join(import.meta.dirname, 'fixtures', 'cursor')

const tmpRoots: string[] = []
afterEach(async () => {
  for (const root of tmpRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A temp fixture root with a cursor manifest. */
async function cursorRoot(manifest: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cursor-rules-'))
  tmpRoots.push(root)
  await writeFileAt(root, '.cursor-plugin/plugin.json', JSON.stringify(manifest))
  return root
}

const byKind = (report: { components: readonly { kind: string; loaded: number; skipped: number; reasons: readonly string[] }[] }) =>
  Object.fromEntries(report.components.map(c => [c.kind, c]))

interface CapturedEntry {
  readonly path: string
  readonly description?: string
  readonly alwaysApply: boolean
  readonly globs: readonly string[]
  readonly body: string
}

async function mountFixture(fixture: string, seams: Record<string, unknown> = {}) {
  const roots = discoverCcPluginRoots({ pluginDirs: [cursorFixtures] })
  const found = roots.find(entry => entry.root === join(cursorFixtures, fixture))
  expect(found, `fixture ${fixture} discovered`).toBeDefined()
  return mountCcPlugin(makeContext(), { root: found!.root, nameHint: found!.nameHint, seams: seams as never })
}

describe('S4: rules seam mount (typed frontmatter)', () => {
  it('passes parsed entries with inline and block globs forms to the seam', async () => {
    const merged: { name: string; entries: CapturedEntry[] }[] = []
    const mount = await mountFixture('minimal', {
      rules: { mergePluginRules: (name: string, entries: CapturedEntry[]) => { merged.push({ name, entries }); return () => {} } },
    })
    try {
      expect(merged).toHaveLength(1)
      expect(merged[0].name).toBe('cursor-minimal')
      const [always, globbed] = merged[0].entries
      // inline list form
      expect(always.path).toBe('rules/always.mdc')
      expect(always.description).toBe('Always-on repo hygiene rule.')
      expect(always.alwaysApply).toBe(true)
      expect(always.globs).toEqual(['*.md'])
      expect(always.body).toContain('Keep docs in sync with code.')
      // block list form
      expect(globbed.path).toBe('rules/globbed.mdc')
      expect(globbed.alwaysApply).toBe(false)
      expect(globbed.globs).toEqual(['**/*.test.ts', '**/*.spec.ts'])
      expect(globbed.body).toContain('Run the tests after edits.')
      // report tallies loaded paths when the seam is present
      const rules = byKind(mount.report)['rules']
      expect(rules?.loaded).toBe(2)
      expect(rules?.skipped).toBe(0)
    } finally {
      mount.dispose()
    }
  })

  it('skips a malformed-frontmatter rule file with a warning (never throws)', async () => {
    const root = await cursorRoot({ name: 'bad-rules' })
    await writeFileAt(root, 'rules/broken.mdc', '---\nalwaysApply: [not, a, bool]\n---\nbody')
    const merged: Array<readonly CapturedEntry[]> = []
    const mount = await mountCcPlugin(makeContext(), {
      root,
      seams: { rules: { mergePluginRules: (_n: string, e: readonly CapturedEntry[]) => { merged.push(e); return () => {} } } } as never,
    })
    try {
      expect(merged).toEqual([[]])
      const rules = byKind(mount.report)['rules']
      expect(rules?.loaded).toBe(0)
      expect(rules?.skipped).toBe(1)
      expect(rules?.reasons[0]).toContain('alwaysApply')
    } finally {
      mount.dispose()
    }
  })
})

describe('S4: manifest-declared rules paths', () => {
  it('appends the default rules dir to literal declared paths', async () => {
    const root = await cursorRoot({ name: 'declared-rules', rules: 'extra' })
    await writeFileAt(root, 'rules/extra/nested/one.mdc', '---\ndescription: d\n---\nalpha')
    const merged: Array<readonly CapturedEntry[]> = []
    const mount = await mountCcPlugin(makeContext(), {
      root,
      seams: { rules: { mergePluginRules: (_n: string, e: readonly CapturedEntry[]) => { merged.push(e); return () => {} } } } as never,
    })
    try {
      expect(merged[0].map(r => r.path)).toEqual(['rules/extra/nested/one.mdc'])
    } finally {
      mount.dispose()
    }
  })

  it('skips non-`/**` glob declarations with a warning even when the seam is present', async () => {
    const merged: Array<readonly CapturedEntry[]> = []
    const mount = await mountFixture('declared-paths', {
      rules: { mergePluginRules: (_n: string, e: readonly CapturedEntry[]) => { merged.push(e); return () => {} } },
    })
    try {
      expect(merged).toEqual([])
      const rules = byKind(mount.report)['rules']
      expect(rules?.skipped).toBe(1)
      expect(rules?.reasons[0]).toContain('rules/*.mdc')
    } finally {
      mount.dispose()
    }
  })
})

describe('S4: seam lifecycle (hooks-test-pattern variants)', () => {
  it("copy-on-write: disposing plugin A removes only A's entries; B still merged", async () => {
    const store = new Map<string, string[]>()
    const merge = (name: string, entries: readonly { path: string }[]) => {
      store.set(name, entries.map(e => e.path))
      return () => { store.delete(name) }
    }
    const root = await cursorRoot({ name: 'plug-a' })
    await writeFileAt(root, 'rules/a.mdc', '---\n---\nA body')
    const mountA = await mountCcPlugin(makeContext(), { root, seams: { rules: { mergePluginRules: merge } } as never })
    merge('plug-b', [{ path: 'rules/b.mdc' }])
    expect([...store.keys()].sort()).toEqual(['plug-a', 'plug-b'])
    mountA.dispose()
    expect([...store.keys()]).toEqual(['plug-b'])
  })

  it('leaked-services: full unload leaves the seam store empty', async () => {
    const store = new Map<string, string[]>()
    const merge = (name: string, entries: readonly { path: string }[]) => {
      store.set(name, entries.map(e => e.path))
      return () => { store.delete(name) }
    }
    const root = await cursorRoot({ name: 'plug-l' })
    await writeFileAt(root, 'rules/l.mdc', '---\n---\nL body')
    const mount = await mountCcPlugin(makeContext(), { root, seams: { rules: { mergePluginRules: merge } } as never })
    mount.dispose()
    expect(store.size).toBe(0)
  })

  it('seam-absent: rules stay a skipped tally with the S3 reasons', async () => {
    const mount = await mountFixture('minimal')
    try {
      const rules = byKind(mount.report)['rules']
      expect(rules?.loaded).toBe(0)
      expect(rules?.skipped).toBe(1)
      expect(rules?.reasons[0]).toContain('"rules"')
    } finally {
      mount.dispose()
    }
    const declared = await mountFixture('declared-paths')
    try {
      const rules = byKind(declared.report)['rules']
      expect(rules?.skipped).toBe(1)
      expect(rules?.reasons[0]).toContain('rules/*.mdc')
    } finally {
      declared.dispose()
    }
  })
})

describe('S4: cc flavor unchanged', () => {
  it('a cc manifest declares no rules and mounts no rules component', async () => {
    expect(parsePluginManifest({ name: 'cc-p' }, 'cc-p').rules).toEqual([])
    const root = await mkdtemp(join(tmpdir(), 'cc-rules-'))
    tmpRoots.push(root)
    await writeFileAt(root, '.claude-plugin/plugin.json', JSON.stringify({ name: 'cc-p' }))
    await writeFileAt(root, 'rules/ignored.mdc', '---\nalwaysApply: true\n---\nnever mounted')
    const mount = await mountCcPlugin(makeContext(), {
      root,
      seams: { rules: { mergePluginRules: () => { throw new Error('cc must not merge rules') } } } as never,
    })
    try {
      expect(mount.report.flavor).toBe('cc')
      expect(byKind(mount.report)['rules']).toBeUndefined()
    } finally {
      mount.dispose()
    }
  })
})
