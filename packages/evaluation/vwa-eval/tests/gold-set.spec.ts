import { describe, expect, it } from 'vitest'
import { goldSnapshotPath, loadGoldSet } from '../src/annotation.js'

// Gold-set selection invariants (docs/plans/2026-10-12-verifiable-workspace-agent.md §8).
// The list is pinned in gold-set.json and its bytes in fixtures/gold/<path>;
// select-gold.mjs --check validates ONLY that snapshot, so repo docs churn
// (added/edited/deleted docs or READMEs) can never turn this red.
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

    // --check: the committed list matches the committed snapshot.
    const out = execFileSync('node', [join(pkg, 'scripts', 'select-gold.mjs'), '--check'], { cwd: root })
    expect(out.toString()).toContain('check OK: 30 entries')
  })

  it('pins correct sha256 for every snapshot file', async () => {
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
    const root = join(pkg, '..', '..', '..')

    void root
    for (const entry of loadGoldSet(pkg)) {
      const buf = readFileSync(goldSnapshotPath(pkg, entry.path))
      expect(createHash('sha256').update(buf).digest('hex'), entry.path).toBe(entry.sha256)
      expect(buf.byteLength, entry.path).toBe(entry.bytes)
    }
  })

  it('--check ignores live repo docs (adding a doc stays green)', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
    // Mirror the package into a throwaway repo layout with an empty docs/ tree
    // plus a brand-new doc: the live selection would differ completely, the
    // snapshot check must not care.
    const tmp = mkdtempSync(join(tmpdir(), 'gold-'))
    try {
      const dest = join(tmp, 'packages', 'evaluation', 'vwa-eval')
      mkdirSync(dest, { recursive: true })
      for (const f of ['gold-set.json', 'scripts', 'fixtures']) cpSync(join(pkg, f), join(dest, f), { recursive: true })
      mkdirSync(join(tmp, 'docs'), { recursive: true })
      writeFileSync(join(tmp, 'docs', 'brand-new-doc.md'), '# new\n')
      const out = execFileSync('node', [join(dest, 'scripts', 'select-gold.mjs'), '--check'], { cwd: tmp })
      expect(out.toString()).toContain('check OK: 30 entries')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
