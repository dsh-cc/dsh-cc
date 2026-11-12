/**
 * The `cc-memory-section` budget (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §A) caps ONE
 * surface: the combined topic index. The section header, the per-layer
 * `MEMORY.md` fragments and the "Searching past context" guidance block must
 * render byte-identical to the uncapped form, truncation keeps whole entries
 * from the bottom of the alphabetical list, the floor keeps the guidance, and
 * the budget is a LIVE setting re-read on every render.
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

/** The rendered combined-index block (header through last entry), UTF-8 bytes. */
function indexBlockOf(text: string): { text: string; byteLength: number } {
  const start = text.indexOf('## Memory index')
  const end = text.indexOf('## Searching past context')
  const block = start === -1 ? '' : text.slice(start, end === -1 ? undefined : end)
  return { text: block, byteLength: Buffer.byteLength(block, 'utf8') }
}

/**
 * The combined-index ENTRY lines only. The per-layer `MEMORY.md` fragments share
 * the `- [` prefix, so entry assertions must be scoped to the index block.
 */
function indexEntriesOf(text: string): string[] {
  return indexBlockOf(text).text.split('\n').filter(line => line.startsWith('- ['))
}

describe('renderLayers (combined-index budget)', () => {
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

  const ELLIPSIS = /^… \((\d+) more memory topics; grep the memory directory for older entries\)$/

  it('caps only the index block, leaving fragments and guidance byte-identical', () => {
    const layers = layersOf(topics(40))
    const uncapped = renderLayers(layers)
    const capped = renderLayers(layers, { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES })
    expect(capped).not.toBe(uncapped)

    // Everything above the index header and everything from the search block on
    // is untouched — the fragments still render at their full (already capped)
    // entrypoint length and the retrieval guidance survives verbatim.
    const headOf = (text: string): string => text.slice(0, text.indexOf('## Memory index'))
    const tailOf = (text: string): string => text.slice(text.indexOf('## Searching past context'))
    expect(headOf(capped)).toBe(headOf(uncapped))
    expect(tailOf(capped)).toBe(tailOf(uncapped))
    expect(headOf(capped)).toContain('## MEMORY.md (this workspace)')
    expect(tailOf(capped)).toContain('## Searching past context')
  })

  it('keeps whole entries only and counts the omitted ones in the ellipsis line', () => {
    const rows = topics(40)
    const layers = layersOf(rows)
    const uncapped = renderLayers(layers)
    const capped = renderLayers(layers, { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES })
    const block = indexBlockOf(capped)
    expect(block.byteLength).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)

    const blockLines = capped.slice(capped.indexOf('## Memory index')).split('\n')
    const ellipsis = blockLines.find(line => line.startsWith('… ('))
    const match = ELLIPSIS.exec(ellipsis ?? '')
    expect(match).not.toBeNull()
    const kept = blockLines.slice(blockLines.indexOf('## Memory index') + 2, blockLines.indexOf(ellipsis ?? ''))

    // Whole entries, alphabetical prefix: every kept line is an entry line the
    // uncapped render produced, and the kept order matches it exactly.
    const entryLines = indexEntriesOf(uncapped)
    expect(kept).toHaveLength(40 - Number(match?.[1]))
    expect(kept.length).toBeGreaterThan(0)
    expect(entryLines.slice(0, kept.length)).toEqual(kept)
    // N counts entries, not lines, and the omission is contiguous at the bottom.
    expect(Number(match?.[1])).toBe(40 - kept.length)
  })

  it('falls back to the floor (guidance, no entries) when one entry cannot fit', () => {
    const layers = layersOf([['huge.md', 'huge', 'y'.repeat(4000)]])
    const capped = renderLayers(layers, { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES })
    expect(capped).toContain('## Memory index')
    expect(capped).toContain('… (1 more memory topics; grep the memory directory for older entries)')
    expect(indexEntriesOf(capped)).toEqual([])
    // The floor keeps the retrieval guidance — enumeration is all that is lost.
    expect(capped).toContain('## Searching past context')
    expect(capped).toContain('grep -rn "<search term>" /ws/ --include="*.md"')
  })

  it('renders the index uncapped when truncate is false', () => {
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
    expect(indexBlockOf(capped).byteLength).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)
    // Whole entries only: every retained line is one of the full entry lines.
    const entryLines = indexEntriesOf(renderLayers(layersOf(rows)))
    expect(indexEntriesOf(capped).length).toBeGreaterThan(0)
    for (const line of indexEntriesOf(capped)) {
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
describe('MemorySection (live index budget)', () => {
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
    let settings: MemorySectionSettings = { truncate: true, maxBytes: MIN_INDEX_MAX_BYTES }
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
    expect(capped).toContain('grep the memory directory for older entries')
    expect(indexBlockOf(capped).byteLength).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)

    // Flip truncation off: the NEXT render is uncapped, no restart, no rescan.
    settings = { truncate: false, maxBytes: MIN_INDEX_MAX_BYTES }
    const uncapped = render()
    expect(uncapped).not.toContain('grep the memory directory for older entries')
    expect(indexBlockOf(uncapped).byteLength).toBeGreaterThan(MIN_INDEX_MAX_BYTES)

    // And back on, with a wider budget: the cap follows the new value.
    settings = { truncate: true, maxBytes: 65536 }
    expect(render()).toBe(uncapped)
    await ctx.fiber.dispose()
  })

  it('renders uncapped when no reader is provided (public renderers stay unchanged)', () => {
    const rows = Array.from({ length: 40 }, (_unused, i) => {
      const tag = String(i).padStart(2, '0')
      return `- [topic ${tag}](topic_${tag}.md) — ${'x'.repeat(120)}\n`
    })
    // `renderMemorySection` (a public export with existing callers) is uncapped
    // regardless of the settings defaults.
    const state: MemoryDirectoryState = {
      dir: '/ws',
      entrypoint: rows[0],
      topics: [],
    }
    expect(renderMemorySection('/global', '/ws', undefined, state)).toContain('- [topic 00](topic_00.md)')
  })
})
