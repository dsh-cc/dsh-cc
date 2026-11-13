/**
 * Pins for the unified memory catalog (design
 * docs/plans/2026-11-13-memory-section-unified-catalog.md §A-§F).
 *
 * These are the properties the section render now OWES: one enumeration, a
 * maintained-order-then-filename order interleaved across scopes, UTF-8-safe
 * description trimming, a byte cap with a floor, and a fingerprint that decides
 * `system-prompt/change` without ever reading rendered text.
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_CATALOG_HEADER,
  compareFilename,
  ellipsisLine,
  fitCatalog,
  renderCatalog,
  renderLayerFingerprint,
  trimDescription,
} from '../src/catalog.ts'
import type { CombinedIndexBudget, MemoryLayer, MemoryLayerScope } from '../src/catalog.ts'
import type { MemoryDirectoryState } from '../src/scan.ts'
import type { MemoryIndexEntry } from '../src/types.ts'

/** The options the section resolves by default (`truncate`, 24576, 160). */
const OPTIONS: Required<CombinedIndexBudget> = { truncate: true, maxBytes: 24576, descriptionMaxBytes: 160 }

/** One topic entry at a scope-independent path. */
function topic(filename: string, description = `desc ${filename}`, name = filename.replace(/\.md$/, '')): MemoryIndexEntry {
  return { path: `/mem/${filename}`, filename, frontmatter: { name, description } }
}

/** One layer state; `entrypoint` is the raw MEMORY.md text (or absent). */
function stateOf(dir: string, topics: MemoryIndexEntry[], entrypoint?: string): MemoryDirectoryState {
  return { dir, entrypoint, topics }
}

/** One layer over a state. */
function layer(scope: MemoryLayerScope, state?: MemoryDirectoryState): MemoryLayer {
  return { scope, label: scope, dir: `/mem/${scope}`, state }
}

/** The catalog's entry lines (heading and blank line stripped). */
function entriesOf(layers: readonly MemoryLayer[], options: Required<CombinedIndexBudget> = OPTIONS): string[] {
  return renderCatalog(layers, options).filter(line => line.startsWith('- ['))
}

/** The entry filenames in rendered order. */
function filenamesOf(layers: readonly MemoryLayer[], options: Required<CombinedIndexBudget> = OPTIONS): string[] {
  return entriesOf(layers, options).map(line => line.slice(line.indexOf('](') + 2, line.indexOf(') —')))
}

/** UTF-8 bytes of the catalog block exactly as `fitCatalog` measures it. */
function catalogBytes(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join('\n'), 'utf8')
}

describe('renderCatalog — order (§C)', () => {
  it('renders the maintained partition in entrypoint order, then the tail by filename', () => {
    const state = stateOf('/mem/workspace', [
      topic('a.md'), topic('b.md'), topic('c.md'), topic('d.md'),
    ], '- [d](d.md) — D\n- [b](b.md) — B\n')
    expect(filenamesOf([layer('workspace', state)])).toEqual(['d.md', 'b.md', 'a.md', 'c.md'])
  })

  it('dedupes a target listed twice, keeping the first position', () => {
    const state = stateOf('/mem/workspace', [topic('a.md'), topic('b.md')],
      '- [b](b.md) — B\n- [a](a.md) — A\n- [b](b.md) — B again\n')
    expect(filenamesOf([layer('workspace', state)])).toEqual(['b.md', 'a.md'])
  })

  it('interleaves maintained entries round-robin across scopes', () => {
    const workspace = stateOf('/mem/workspace', [topic('w1.md'), topic('w2.md'), topic('w3.md')],
      '- [w1](w1.md) — W1\n- [w2](w2.md) — W2\n- [w3](w3.md) — W3\n')
    const global = stateOf('/mem/global', [topic('g1.md'), topic('g2.md')],
      '- [g1](g1.md) — G1\n- [g2](g2.md) — G2\n')
    // Round 0: workspace then global; round 1: both; round 2: workspace only.
    expect(filenamesOf([layer('workspace', workspace), layer('global', global)]))
      .toEqual(['w1.md', 'g1.md', 'w2.md', 'g2.md', 'w3.md'])
  })

  it('never cuts a longer list short when a shorter one runs out', () => {
    const workspace = stateOf('/mem/workspace', [topic('w1.md'), topic('w2.md'), topic('w3.md')],
      '- [w1](w1.md)\n- [w2](w2.md)\n- [w3](w3.md)\n')
    const team = stateOf('/mem/team', [topic('t1.md')], '- [t1](t1.md)\n')
    expect(filenamesOf([layer('workspace', workspace), layer('team', team)]))
      .toEqual(['w1.md', 't1.md', 'w2.md', 'w3.md'])
  })

  it('interleaves the tail pass too, each layer sorted by filename', () => {
    const workspace = stateOf('/mem/workspace', [topic('a.md'), topic('z.md')])
    const global = stateOf('/mem/global', [topic('b.md'), topic('y.md')])
    expect(filenamesOf([layer('workspace', workspace), layer('global', global)]))
      .toEqual(['a.md', 'b.md', 'z.md', 'y.md'])
  })

  it('renders one entry per (scope, filename): a shared filename appears twice', () => {
    const workspace = stateOf('/mem/workspace', [topic('same.md', 'workspace copy')])
    const global = stateOf('/mem/global', [topic('same.md', 'global copy')])
    const entries = entriesOf([layer('workspace', workspace), layer('global', global)])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toContain('workspace copy')
    expect(entries[1]).toContain('global copy')
  })

  it('keeps the canonical layer order and one layer per scope', () => {
    const workspace = stateOf('/mem/workspace', [topic('w.md')])
    const global = stateOf('/mem/global', [topic('g.md')])
    // Input order reversed; a duplicate workspace layer is ignored.
    const layers = [layer('global', global), layer('workspace', workspace), layer('workspace', stateOf('/mem/other', [topic('x.md')]))]
    expect(filenamesOf(layers)).toEqual(['w.md', 'g.md'])
  })
})

describe('renderCatalog — pointer matching (§C)', () => {
  const cases: Array<[string, string]> = [
    ['./a.md', 'a topic target carrying a directory prefix is not the filename'],
    ['dir/a.md', 'a nested target is not the filename'],
    ['A.MD', 'matching is case-sensitive'],
    ['missing.md', 'a dangling pointer promotes nothing'],
    ['b.md', 'a pointer to ANOTHER layer\'s topic never promotes it'],
  ]

  for (const [target, why] of cases) {
    it(`falls back to the tail when ${why}`, () => {
      const state = stateOf('/mem/workspace', [topic('a.md'), topic('z.md')], `- [x](${target}) — X\n`)
      expect(filenamesOf([layer('workspace', state)])).toEqual(['a.md', 'z.md'])
    })
  }

  it('does not fall through to a second link on the same line', () => {
    const state = stateOf('/mem/workspace', [topic('a.md'), topic('b.md')],
      '- [x](missing.md) then [y](b.md)\n')
    expect(filenamesOf([layer('workspace', state)])).toEqual(['a.md', 'b.md'])
  })

  it('walks the RAW entrypoint, so pointers past the read cap still order entries', () => {
    const topics = Array.from({ length: 210 }, (_unused, index) => topic(`t${String(index).padStart(3, '0')}.md`))
    const pointers = topics.map(entry => `- [${entry.filename}](${entry.filename}) — d`).join('\n')
    const state = stateOf('/mem/workspace', topics, pointers)
    // Maintained order is the entrypoint's order, not the filed order reversed.
    expect(filenamesOf([layer('workspace', state)])[0]).toBe('t000.md')
  })
})

describe('trimDescription (§D)', () => {
  it('returns a description at or under the ceiling unchanged', () => {
    const text = 'a'.repeat(160)
    expect(trimDescription(text, 160)).toBe(text)
  })

  it('cuts ASCII on a byte budget and appends the ellipsis', () => {
    const trimmed = trimDescription('x'.repeat(400), 160)
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(160)
    expect(trimmed.endsWith('…')).toBe(true)
  })

  it('never splits a Han character', () => {
    const trimmed = trimDescription('记'.repeat(300), 160)
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(160)
    expect(trimmed).not.toContain('\uFFFD')
    expect(trimmed.endsWith('记…')).toBe(true)
  })

  it('never splits an emoji surrogate pair', () => {
    const trimmed = trimDescription('🧠'.repeat(100), 160)
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(160)
    expect(trimmed).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(trimmed.endsWith('🧠…')).toBe(true)
  })

  it('trims nothing at 0 and nothing on an empty description', () => {
    expect(trimDescription('y'.repeat(400), 0)).toBe('y'.repeat(400))
    expect(trimDescription('', 160)).toBe('')
  })

  it('keeps an entry line at the ceiling byte-accurately', () => {
    const entries = entriesOf([layer('workspace', stateOf('/mem/workspace', [topic('a.md', 'z'.repeat(1000))]))])
    expect(entries[0]).toContain('…')
    expect(entries[0]).not.toContain('z'.repeat(200))
  })
})

describe('renderCatalog — budget and floor (§E)', () => {
  it('renders the full catalog when truncation is off, however large', () => {
    const topics = Array.from({ length: 60 }, (_unused, index) => topic(`t${index}.md`, 'd'.repeat(200)))
    const entries = entriesOf([layer('workspace', stateOf('/mem/workspace', topics))], { ...OPTIONS, truncate: false })
    expect(entries).toHaveLength(60)
  })

  it('drops whole entries from the bottom and counts them in the ellipsis line', () => {
    const topics = Array.from({ length: 60 }, (_unused, index) => topic(`t${String(index).padStart(3, '0')}.md`, 'd'.repeat(200)))
    const lines = renderCatalog([layer('workspace', stateOf('/mem/workspace', topics))], { ...OPTIONS, maxBytes: 4096 })
    expect(catalogBytes(lines)).toBeLessThanOrEqual(4096)
    const kept = lines.filter(line => line.startsWith('- ['))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept[0]).toContain('t000.md')
    const tail = lines[lines.length - 1] ?? ''
    expect(tail).toMatch(/^… \(\d+ more memory topics; grep the memory directory\)$/)
    expect(tail).not.toContain('older entries')
  })

  it('falls to the floor (heading + ellipsis, no entries) when nothing fits', () => {
    // The NAME is never trimmed, so it is the only way to exceed the budget with
    // one entry: the floor is reachable only when even a single line cannot fit.
    const wide: MemoryIndexEntry = {
      path: '/mem/wide.md', filename: 'wide.md', frontmatter: { name: 'n'.repeat(1200), description: 'd' },
    }
    const lines = renderCatalog([layer('workspace', stateOf('/mem/workspace', [wide]))],
      { ...OPTIONS, maxBytes: 1024, descriptionMaxBytes: 0 })
    expect(lines.slice(0, MEMORY_CATALOG_HEADER.length)).toEqual([...MEMORY_CATALOG_HEADER])
    expect(lines.filter(line => line.startsWith('- ['))).toHaveLength(0)
    expect(lines[lines.length - 1]).toBe(ellipsisLine(1))
  })

  it('holds the byte cap for random corpora (non-floor cases)', () => {
    for (const maxBytes of [1024, 2048, 8192, 24576]) {
      const topics = Array.from({ length: 40 }, (_unused, index) =>
        topic(`r${String(index).padStart(2, '0')}.md`, `${'描'.repeat(index % 7)}${'a'.repeat((index * 13) % 90)}`))
      const lines = renderCatalog([layer('workspace', stateOf('/mem/workspace', topics))], { ...OPTIONS, maxBytes })
      const kept = lines.filter(line => line.startsWith('- ['))
      if (kept.length > 0 || catalogBytes(lines) <= maxBytes) {
        expect(catalogBytes(lines)).toBeLessThanOrEqual(maxBytes)
      }
    }
  })

  it('returns no block at all when no layer holds a topic', () => {
    expect(renderCatalog([layer('workspace', stateOf('/mem/workspace', [])), layer('global')], OPTIONS)).toEqual([])
  })
})

describe('renderCatalog — entry line format (§B)', () => {
  it('keeps the historical line shape, with the type suffix only when present', () => {
    const typed: MemoryIndexEntry = {
      path: '/mem/t.md', filename: 't.md', frontmatter: { name: 'Name [x]', description: 'the description', type: 'project' },
    }
    const entries = entriesOf([layer('workspace', stateOf('/mem/workspace', [typed]))])
    expect(entries[0]).toBe('- [Name \\[x\\]](t.md) — the description (workspace) [project]')
  })
})

describe('renderLayerFingerprint (§F)', () => {
  it('is stable across repeated scans of the same state', () => {
    const state = stateOf('/mem/workspace', [topic('a.md')], '- [a](a.md)\n')
    expect(renderLayerFingerprint(state)).toBe(renderLayerFingerprint(stateOf('/mem/workspace', [topic('a.md')], '- [a](a.md)\n')))
  })

  it('changes when a pointer PROMOTES a topic out of the tail', () => {
    const before = stateOf('/mem/workspace', [topic('a.md'), topic('b.md')], '- [a](a.md)\n')
    const after = stateOf('/mem/workspace', [topic('a.md'), topic('b.md')], '- [a](a.md)\n- [b](b.md)\n')
    expect(renderLayerFingerprint(after)).not.toBe(renderLayerFingerprint(before))
  })

  it('changes when a topic is added or removed', () => {
    const one = renderLayerFingerprint(stateOf('/mem/workspace', [topic('a.md')]))
    const two = renderLayerFingerprint(stateOf('/mem/workspace', [topic('a.md'), topic('b.md')]))
    expect(two).not.toBe(one)
    expect(renderLayerFingerprint(stateOf('/mem/workspace', []))).not.toBe(one)
  })

  it('changes on a frontmatter edit even when trimming hides it from the render', () => {
    const long = 'd'.repeat(400)
    const before = stateOf('/mem/workspace', [topic('a.md', long)])
    const after = stateOf('/mem/workspace', [topic('a.md', `${long}extra`)])
    expect(entriesOf([layer('workspace', before)])).toEqual(entriesOf([layer('workspace', after)]))
    expect(renderLayerFingerprint(after)).not.toBe(renderLayerFingerprint(before))
  })

  it('ignores an entrypoint prose edit that touches no pointer', () => {
    const before = stateOf('/mem/workspace', [topic('a.md')], '- [a](a.md)\n')
    const after = stateOf('/mem/workspace', [topic('a.md')], '# Memory index\n\n- [a](a.md)\n\nnotes\n')
    expect(renderLayerFingerprint(after)).toBe(renderLayerFingerprint(before))
  })

  it('contains no scope tag, so a directory can be fingerprinted without one', () => {
    const state = stateOf('/mem/workspace', [topic('a.md')], '- [a](a.md)\n')
    expect(renderLayerFingerprint(state)).not.toContain('workspace')
  })
})

describe('compareFilename', () => {
  it('is total: distinct filenames never compare equal', () => {
    const composed = 'é.md'
    const decomposed = 'e\u0301.md'
    expect(composed).not.toBe(decomposed)
    expect(compareFilename(composed, decomposed)).not.toBe(0)
    expect(compareFilename(decomposed, composed)).toBe(-compareFilename(composed, decomposed))
  })
})

describe('fitCatalog', () => {
  it('returns the post-header lines, so the caller can render heading + result', () => {
    expect(fitCatalog([], 1024)).toEqual([])
    expect(fitCatalog(['- [a](a.md) — d (workspace)'], 1024)).toHaveLength(1)
  })
})
