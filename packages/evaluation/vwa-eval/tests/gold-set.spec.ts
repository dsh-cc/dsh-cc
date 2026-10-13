import { describe, expect, it } from 'vitest'
import { loadGoldSet } from '../src/annotation.js'

// Gold-set selection invariants (docs/plans/2026-10-12-verifiable-workspace-agent.md §8).
// The list itself is pinned in gold-set.json; select-gold.mjs --check re-derives
// it live. Here we pin the committed list's shape and strata.
describe('gold set', () => {
  it('has exactly 30 entries, ~15 docs + ~15 package READMEs, sorted by path', async () => {
    const { execFileSync } = await import('node:child_process')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
    const root = join(pkg, '..', '..', '..')

    const gold = loadGoldSet(pkg)
    expect(gold).toHaveLength(30)
    const paths = gold.map((e) => e.path)
    expect([...paths].sort()).toEqual(paths)
    const docs = paths.filter((p) => p.startsWith('docs/'))
    const readmes = paths.filter((p) => /^packages\/[^/]+\/[^/]+\/README\.md$/.test(p))
    expect(docs.length).toBe(15)
    expect(readmes.length).toBe(15)

    // --check round-trip: the committed list matches a fresh deterministic run.
    const out = execFileSync('node', [join(pkg, 'scripts', 'select-gold.mjs'), '--check'], { cwd: root })
    expect(out.toString()).toContain('check OK: 30 entries')
  })

  it('pins correct sha256 for a live gold file', async () => {
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
    const root = join(pkg, '..', '..', '..')

    const entry = loadGoldSet(pkg)[0]
    const actual = createHash('sha256').update(readFileSync(join(root, entry.path))).digest('hex')
    expect(entry.sha256).toBe(actual)
    expect(entry.bytes).toBe(readFileSync(join(root, entry.path)).byteLength)
  })
})
