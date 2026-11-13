/**
 * The `cc-memory-section` budget (design
 * docs/plans/2026-11-13-memory-section-unified-catalog.md §E) caps ONE surface:
 * the unified `## Memory index` catalog block. There are no per-layer
 * `MEMORY.md` fragments any more — the catalog is the whole enumeration — and
 * the measured object is exactly
 * `['## Memory index', '', ...kept, ...(ellipsis ? [ellipsis] : [])].join('\n')`,
 * i.e. what `fitCatalog` caps (design Verification 5). Truncation keeps whole
 * entries from the bottom of the interleaved order, the floor keeps the header
 * and the ellipsis line, and the budget is a LIVE setting re-read on every
 * render.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryDirectoryState } from '../src/scan.ts'
import { MemorySection, renderLayers, renderMemorySection } from '../src/section.ts'
import type { MemoryLayer } from '../src/section.ts'
import { MIN_INDEX_MAX_BYTES } from '../src/section-settings.ts'
import type { MemorySectionSettings } from '../src/section-settings.ts'
import { FakeMemoryFs } from './helpers.ts'

/**
 * The exact object `fitCatalog` caps: `## Memory index`, the blank line after
 * it, then the kept entry lines and (when entries were dropped) the ellipsis
 * line. Trailing blank separator lines before the search block are excluded —
 * counting them would measure the section, not the block.
 */
function catalogBlockLines(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf('## Memory index')
  if (start === -1) return []
  const end = lines.indexOf('## Searching past context')
  const block = lines.slice(start, end === -1 ? undefined : end)
  while (block.length > 0 && block.at(-1) === '') block.pop()
  return block
}

/** UTF-8 bytes of the capped catalog block (see {@link catalogBlockLines}). */
function catalogBlockBytes(text: string): number {
  return Buffer.byteLength(catalogBlockLines(text).join('\n'), 'utf8')
}

/** The catalog's ENTRY lines only (the header and the ellipsis line excluded). */
function catalogEntriesOf(text: string): string[] {
  return catalogBlockLines(text).slice(2).filter(line => line.startsWith('- ['))
}

/** The catalog's ellipsis line, when the render dropped entries. */
function ellipsisOf(text: string): string | undefined {
  return catalogBlockLines(text).slice(2).find(line => line.startsWith('… ('))
}

describe('renderLayers (catalog budget)', () => {
  /** One scanned layer state built from `[filename, name, description]` rows. */
  function stateOf(dir: string, rows: readonly [string, string, string][]): MemoryDirectoryState {
    return {
      dir,
      entrypoint: `- [${rows[0]?.[1] ?? 'seed'}](${rows[0]?.[0] ?? 'seed.md'}) — seed\n`,
      topics: rows.map(([filename, name, description]) => ({
        path: `${dir}/${filename}`,
        filename,
        frontmatter: { name, description, type: 'user' as const },
      })),
    }
  }

  /** `count` alphabetical topics whose descriptions are `descBytes` ASCII bytes. */
  function topics(count: number, descBytes = 120): [string, string, string][] {
    return Array.from({ length: count }, (_unused, i) => {
      const tag = String(i).padStart(2, '0')
      return [`topic_${tag}.md`, `topic ${tag}`, 'x'.repeat(descBytes)] as [string, string, string]
    })
  }

  function layersOf(rows: readonly [string, string, string][]): MemoryLayer[] {
    return [
      { scope: 'workspace', label: 'this workspace', dir: '/ws', state: stateOf('/ws', rows) },
      { scope: 'global', label: 'global', dir: '/global', state: undefined },
    ]
  }

  const ELLIPSIS = /^… \((\d+) more memory topics; grep the memory directory\)$/

  it('keeps whole entries only and counts the omitted ones in the ellipsis line', () => {
    const rows = topics(40)
    const layers = layersOf(rows)
    const uncapped = renderLayers(layers)
    const capped = renderLayers(layers, { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES })
    expect(catalogBlockBytes(capped)).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)

    const block = catalogBlockLines(capped)
    expect(block[0]).toBe('## Memory index')
    expect(block[1]).toBe('')
    const ellipsis = ellipsisOf(capped)
    const match = ELLIPSIS.exec(ellipsis ?? '')
    expect(match).not.toBeNull()
    const kept = block.slice(2, ellipsis === undefined ? undefined : block.indexOf(ellipsis))

    // Whole entries, prefix of the interleaved order: every kept line is an
    // entry line the uncapped render produced, in the same order.
    const entryLines = catalogEntriesOf(uncapped)
    expect(kept).toHaveLength(40 - Number(match?.[1]))
    expect(kept.length).toBeGreaterThan(0)
    expect(entryLines.slice(0, kept.length)).toEqual(kept)
    // N counts entries, not lines, and the omission is contiguous at the bottom.
    expect(Number(match?.[1])).toBe(40 - kept.length)
  })

  it('falls back to the floor (header + ellipsis, no entries) when one entry cannot fit', () => {
    // `description-max-bytes: 0`: with the default trimming (160) the oversized
    // description would shrink below the budget and the render would never
    // reach the floor (design Verification 5).
    const layers = layersOf([['huge.md', 'huge', 'y'.repeat(4000)]])
    const capped = renderLayers(layers, { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES, descriptionMaxBytes: 0 })
    expect(capped).toContain('## Memory index')
    expect(capped).toContain('… (1 more memory topics; grep the memory directory)')
    expect(catalogEntriesOf(capped)).toEqual([])
    expect(catalogBlockLines(capped)).toEqual([
      '## Memory index',
      '',
      '… (1 more memory topics; grep the memory directory)',
    ])
    expect(catalogBlockBytes(capped)).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)
    // The floor keeps the retrieval guidance — enumeration is all that is lost.
    expect(capped).toContain('## Searching past context')
    expect(capped).toContain('grep -rn "<search term>" /ws/ --include="*.md"')
  })

  it('renders the catalog uncapped when truncate is false', () => {
    const layers = layersOf(topics(40))
    const uncapped = renderLayers(layers)
    expect(renderLayers(layers, { truncate: false, maxBytes: MIN_INDEX_MAX_BYTES })).toBe(uncapped)
    // A budget the block already fits under is a no-op too.
    expect(renderLayers(layers, { truncate: true, maxBytes: 65536 })).toBe(uncapped)
  })

  it('measures UTF-8 bytes: multi-byte entries never overflow the budget', () => {
    // 30 CJK descriptions: ~3 bytes per code point, so a char-count cap would
    // overflow by ~3x.
    const rows: [string, string, string][] = Array.from({ length: 30 }, (_unused, i) => {
      const tag = String(i).padStart(2, '0')
      return [`中文_${tag}.md`, `中文主题 ${tag}`, '中文描述内容'.repeat(10)] as [string, string, string]
    })
    const capped = renderLayers(layersOf(rows), { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES })
    expect(catalogBlockBytes(capped)).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)
    // Whole entries only: every retained line is one of the full entry lines.
    const entryLines = catalogEntriesOf(renderLayers(layersOf(rows)))
    expect(catalogEntriesOf(capped).length).toBeGreaterThan(0)
    for (const line of catalogEntriesOf(capped)) {
      expect(entryLines).toContain(line)
    }
    expect(capped).not.toContain('\uFFFD')
  })
})

/**
 * The budget is a live setting: `MemorySection` stores the reader and consults
 * it per render, so a settings write applies to the next render of any path
 * (direct, readiness refresh, `system-prompt/change`).
 */
describe('MemorySection (live catalog budget)', () => {
  const agentAt = (cwd: string): Agent =>
    ({ session: { header: { cwd, delegationDepth: 0 } }, options: {} }) as unknown as Agent

  it('re-reads the settings getter on every render', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeMemoryFs)
    const fs = ctx.fs as unknown as FakeMemoryFs
    let textFn: ((context: { scope?: unknown }) => string) | undefined
    ctx.provide('systemPrompt' as never, {
      section: (def: { text: (context: { scope?: unknown }) => string }) => { textFn = def.text },
    } as never)
    let settings: MemorySectionSettings = {
      truncate: true,
      maxBytes: MIN_INDEX_MAX_BYTES,
      descriptionMaxBytes: 160,
    }
    const section = new MemorySection(ctx, '/mem', { readSettings: () => settings })
    for (let i = 0; i < 12; i += 1) {
      const filename = `topic_${String(i).padStart(2, '0')}.md`
      fs.seed(`/mem/${filename}`, `---\nname: topic ${i}\ndescription: ${'d'.repeat(120)}\ntype: user\n---\nbody\n`)
    }
    const agent = agentAt('/work/repo-a')
    const render = (): string => {
      if (textFn === undefined) throw new Error('section text callback not captured')
      return textFn({ scope: agent })
    }
    section.start()
    await section.refresh(agent)

    const capped = render()
    expect(capped).toContain('grep the memory directory')
    expect(catalogBlockBytes(capped)).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)

    // Flip truncation off: the NEXT render is uncapped, no restart, no rescan.
    settings = { truncate: false, maxBytes: MIN_INDEX_MAX_BYTES, descriptionMaxBytes: 160 }
    const uncapped = render()
    expect(uncapped).not.toContain('grep the memory directory')
    expect(catalogBlockBytes(uncapped)).toBeGreaterThan(MIN_INDEX_MAX_BYTES)

    // And back on, with a wider budget: the cap follows the new value.
    settings = { truncate: true, maxBytes: 65536, descriptionMaxBytes: 160 }
    expect(render()).toBe(uncapped)

    // The description ceiling is live and independent of truncation: a tighter
    // ceiling re-renders the SAME complete catalog with trimmed descriptions.
    settings = { truncate: false, maxBytes: MIN_INDEX_MAX_BYTES, descriptionMaxBytes: 40 }
    const trimmed = render()
    expect(trimmed).not.toBe(uncapped)
    expect(catalogEntriesOf(trimmed)).toHaveLength(catalogEntriesOf(uncapped).length)
    expect(trimmed).toContain(`${'d'.repeat(37)}…`)
    await ctx.fiber.dispose()
  })

  /** 40 topics with 300-byte descriptions: over both the default budget and trim ceiling. */
  function topics40(): [string, string, string][] {
    return Array.from({ length: 40 }, (_unused, i) => {
      const tag = String(i).padStart(2, '0')
      return [`topic_${tag}.md`, `topic ${tag}`, 'x'.repeat(300)] as [string, string, string]
    })
  }

  /** One workspace layer state, entrypoint pointing at the first row. */
  function workspaceLayerOf(rows: readonly [string, string, string][]): MemoryLayer {
    return {
      scope: 'workspace',
      label: 'this workspace',
      dir: '/ws',
      state: {
        dir: '/ws',
        entrypoint: `- [${rows[0]?.[1] ?? 'seed'}](${rows[0]?.[0] ?? 'seed.md'}) — seed\n`,
        topics: rows.map(([filename, name, description]) => ({
          path: `/ws/${filename}`,
          filename,
          frontmatter: { name, description, type: 'user' as const },
        })),
      },
    }
  }

  it('renders uncapped and untrimmed when no reader is provided (public renderers stay unchanged)', () => {
    const state = workspaceLayerOf(topics40()).state
    // `renderMemorySection` (a public export with existing callers) renders the
    // complete catalog with full descriptions regardless of the settings
    // defaults — over the default budget and past the default trim ceiling.
    const text = renderMemorySection('/global', '/ws', undefined, state)
    expect(catalogEntriesOf(text)).toHaveLength(40)
    expect(catalogEntriesOf(text)[0]).toContain('x'.repeat(300))
    expect(ellipsisOf(text)).toBeUndefined()
    expect(catalogBlockBytes(text)).toBeGreaterThan(MIN_INDEX_MAX_BYTES)
  })
})
