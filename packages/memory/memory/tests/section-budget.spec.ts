/**
 * Section A of design docs/plans/2026-11-12-selective-system-prompt-sections.md:
 * the `cc-memory-section` byte budget for the COMBINED topic index block.
 *
 * The contract these specs pin:
 * - only the combined index block is capped — header, per-layer fragments and
 *   the "Searching past context" guidance render byte-identical;
 * - truncation drops whole entries from the bottom of the alphabetical list and
 *   counts omitted ENTRIES in the closing note;
 * - the floor rule keeps the heading + the note when even one entry does not fit;
 * - `truncate: false` renders the index uncapped (it never removes the section);
 * - the settings reader is consulted per render, so a settings write reaches the
 *   text callback, the readiness refresh and `system-prompt/change` re-renders.
 *
 * Every measurement is UTF-8 bytes (`Buffer.byteLength`), the unit the design
 * doc and the existing entrypoint truncation layer use.
 */
import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { MemorySection, MEMORY_SECTION_NAME, renderLayers } from '../src/section.ts'
import type { MemoryLayer } from '../src/section.ts'
import type { MemoryDirectoryState } from '../src/scan.ts'
import type { MemoryIndexEntry } from '../src/types.ts'
import { MEMORY_INDEX_HEADING, memoryIndexNote } from '../src/index-budget.ts'
import {
  DEFAULT_MEMORY_SECTION_SETTINGS,
  MIN_SECTION_MAX_BYTES,
  SECTION_SETTINGS_NAMESPACE,
  SettingsSchema as SectionSettingsSchema,
  memorySectionSettings,
  resolveMemorySectionSettings,
} from '../src/section-settings.ts'
import { FakeMemoryFs } from './helpers.ts'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** One scanned topic entry with its rationalized frontmatter. */
function topic(filename: string, name: string, description: string): MemoryIndexEntry {
  return { path: `/mem/${filename}`, filename, frontmatter: { name, description } }
}

/** A layer whose scan has landed. */
function layer(
  scope: 'workspace' | 'global',
  label: string,
  dir: string,
  topics: MemoryIndexEntry[],
): MemoryLayer {
  const state: MemoryDirectoryState = { dir, entrypoint: `- [${label}](x.md) — pointer`, topics }
  return { scope, label, dir, state }
}

/** N alphabetically-ordered topics with predictable line sizes. */
function topics(count: number, descriptionLength = 40): MemoryIndexEntry[] {
  return Array.from({ length: count }, (_unused, index) => {
    const suffix = String(index).padStart(2, '0')
    return topic(`topic_${suffix}.md`, `topic ${suffix}`, 'd'.repeat(descriptionLength))
  })
}

/** The rendered entry line for one topic, as the section composes it. */
function entryLine(t: MemoryIndexEntry, scope: 'workspace' | 'global'): string {
  return `- [${t.frontmatter.name}](${t.filename}) — ${t.frontmatter.description} (${scope})`
}

/** The index block's rendered lines (heading through the closing note). */
function indexBlock(text: string): string[] {
  const start = text.indexOf(MEMORY_INDEX_HEADING)
  const end = text.indexOf('## Searching past context')
  return text.slice(start, end).trimEnd().split('\n')
}

describe('cc-memory-section settings namespace', () => {
  it('names the namespace exactly `cc-memory-section` and defaults to on/8192', () => {
    expect(SECTION_SETTINGS_NAMESPACE).toBe('cc-memory-section')
    expect(DEFAULT_MEMORY_SECTION_SETTINGS).toEqual({ truncate: true, maxBytes: 8192 })
    expect(memorySectionSettings(undefined)).toEqual(DEFAULT_MEMORY_SECTION_SETTINGS)
    expect(resolveMemorySectionSettings(undefined)).toEqual(DEFAULT_MEMORY_SECTION_SETTINGS)
  })

  it('maps the kebab-case user section onto the internal shape', () => {
    expect(memorySectionSettings({ truncate: false, 'max-bytes': 2048 }))
      .toEqual({ truncate: false, maxBytes: 2048 })
  })

  it('resolves defaults for fields the user section omits', () => {
    const resolved = (SectionSettingsSchema as unknown as (input: unknown) => unknown)({ 'max-bytes': 2048 }) as {
      truncate: boolean
      'max-bytes': number
    }
    expect(memorySectionSettings(resolved)).toEqual({ truncate: true, maxBytes: 2048 })
  })

  it('rejects max-bytes outside 1024..65536 and non-integers (never clamps)', () => {
    const schema = SectionSettingsSchema as unknown as (input: unknown) => unknown
    expect(() => schema({ 'max-bytes': MIN_SECTION_MAX_BYTES - 1 })).toThrow()
    expect(() => schema({ 'max-bytes': 65537 })).toThrow()
    expect(() => schema({ 'max-bytes': 2048.5 })).toThrow()
    expect(() => schema({ 'max-bytes': 1024 })).not.toThrow()
    expect(() => schema({ 'max-bytes': 65536 })).not.toThrow()
  })

  it('keeps an absent namespace absent instead of materializing defaults', () => {
    const schema = SectionSettingsSchema as unknown as (input: unknown) => unknown
    expect(schema(undefined)).toBeUndefined()
  })
})

describe('renderLayers combined-index budget', () => {
  const workspace = (count: number, descriptionLength = 40): MemoryLayer =>
    layer('workspace', 'this workspace', '/ws', topics(count, descriptionLength))
  const global = layer('global', 'global', '/global', [])

  it('renders byte-identical output when the index block is under budget', () => {
    const layers = [workspace(3), global]
    const unbudgeted = renderLayers(layers, { truncate: false })
    const budgeted = renderLayers(layers, { truncate: true, maxBytes: 8192 })
    expect(budgeted).toBe(unbudgeted)
    expect(budgeted).not.toContain('more memory topics')
  })

  it('caps ONLY the index block: header, fragments and guidance stay byte-identical', () => {
    const layers = [workspace(12), global]
    const unbudgeted = renderLayers(layers, { truncate: false })
    const capped = renderLayers(layers, { truncate: true, maxBytes: 700 })

    expect(capped).not.toBe(unbudgeted)
    expect(capped).toContain('more memory topics')
    // The section head (title, save guidance, per-layer MEMORY.md fragments)
    // is untouched: it is the prefix that ends where the index block begins.
    expect(capped.slice(0, capped.indexOf(MEMORY_INDEX_HEADING)))
      .toBe(unbudgeted.slice(0, unbudgeted.indexOf(MEMORY_INDEX_HEADING)))
    // The retrieval guidance block is untouched: same suffix, still naming
    // every populated memory directory.
    expect(capped.slice(capped.indexOf('## Searching past context')))
      .toBe(unbudgeted.slice(unbudgeted.indexOf('## Searching past context')))
    expect(capped).toContain('grep -rn "<search term>" /ws/ --include="*.md"')
  })

  it('drops whole entries from the bottom and counts the omitted ENTRIES', () => {
    const all = topics(10)
    const layers = [layer('workspace', 'this workspace', '/ws', all), global]
    const maxBytes = 520
    const rendered = renderLayers(layers, { truncate: true, maxBytes })

    const indexStart = rendered.indexOf(MEMORY_INDEX_HEADING)
    const indexEnd = rendered.indexOf('## Searching past context')
    const blockLines = rendered.slice(indexStart, indexEnd).trimEnd().split('\n')
    // heading + blank + retained entries + note
    const entryLines = blockLines.filter(line => line.startsWith('- ['))
    const note = blockLines.at(-1) ?? ''
    expect(note).toBe(memoryIndexNote(all.length - entryLines.length))
    // Whole entries only: every retained line is one of today's complete lines,
    // and the retained prefix keeps today's alphabetical order.
    const expectedPrefix = all.slice(0, entryLines.length)
      .map(t => entryLine(t, 'workspace'))
    expect(entryLines).toEqual(expectedPrefix)
    // The boundary is maximal: one more entry would not have fit.
    const oneMore = [MEMORY_INDEX_HEADING, '', ...all.slice(0, entryLines.length + 1)
      .map(t => entryLine(t, 'workspace')), memoryIndexNote(all.length - entryLines.length - 1)].join('\n')
    expect(bytes(oneMore)).toBeGreaterThan(maxBytes)
    // And the rendered block respects the budget.
    expect(bytes(rendered.slice(indexStart, indexEnd).trimEnd())).toBeLessThanOrEqual(maxBytes)
  })

  it('keeps every entry when the block already fits, even with truncate on', () => {
    const all = topics(4)
    const layers = [layer('workspace', 'this workspace', '/ws', all), global]
    const rendered = renderLayers(layers, { truncate: true, maxBytes: 65536 })
    for (const t of all) expect(rendered).toContain(entryLine(t, 'workspace'))
    expect(rendered).not.toContain('more memory topics')
  })

  it('floor rule: one oversized entry renders heading + guidance + note, no entries', () => {
    const huge = [topic('huge.md', 'huge', 'x'.repeat(4000))]
    const layers = [layer('workspace', 'this workspace', '/ws', huge), global]
    const rendered = renderLayers(layers, { truncate: true, maxBytes: 1024 })

    expect(rendered).toContain(MEMORY_INDEX_HEADING)
    expect(rendered).toContain(memoryIndexNote(1))
    expect(rendered).not.toContain('- [huge](huge.md)')
    // The retrieval guidance and the fragments survive the floor form.
    expect(rendered).toContain('## Searching past context')
    expect(rendered).toContain('## MEMORY.md (this workspace)')
    // The floor fired because entry + note genuinely cannot fit.
    const withEntry = [MEMORY_INDEX_HEADING, '', entryLine(huge[0]!, 'workspace'), memoryIndexNote(1)]
      .join('\n')
    expect(bytes(withEntry)).toBeGreaterThan(1024)
  })

  it('truncate: false renders the index uncapped (the section is never removed)', () => {
    const all = topics(20, 200)
    const layers = [layer('workspace', 'this workspace', '/ws', all), global]
    const rendered = renderLayers(layers, { truncate: false, maxBytes: 1024 })
    expect(rendered).toContain(MEMORY_INDEX_HEADING)
    for (const t of all) expect(rendered).toContain(entryLine(t, 'workspace'))
    expect(rendered).not.toContain('more memory topics')
    expect(rendered).toContain('## Searching past context')
  })

  it('never removes the index when a layer has no topics', () => {
    const rendered = renderLayers([workspace(0), global], { truncate: true, maxBytes: 1024 })
    expect(rendered).not.toContain(MEMORY_INDEX_HEADING)
    expect(rendered).toContain('## MEMORY.md (this workspace)')
  })
})

/**
 * Hot settings: the section stores its reader and consults it on every render,
 * so one settings write reaches the direct text callback, the one-shot
 * first-assembly readiness refresh and every `system-prompt/change` re-render
 * (all three route through `MemorySection.render`).
 */
describe('MemorySection hot settings', () => {
  const agentAt = (cwd: string): Agent =>
    ({ session: { header: { cwd, delegationDepth: 0 } }, options: {} }) as unknown as Agent

  async function seededContext(): Promise<{ ctx: Context; fs: FakeMemoryFs }> {
    const ctx = new Context()
    await ctx.plugin(FakeMemoryFs)
    const fs = ctx.fs as unknown as FakeMemoryFs
    for (let index = 0; index < 12; index++) {
      const suffix = String(index).padStart(2, '0')
      fs.seed(`/mem/topic_${suffix}.md`, `---\nname: topic ${suffix}\ndescription: ${'d'.repeat(40)}\n---\nbody\n`)
    }
    fs.seed('/mem/MEMORY.md', '- [topic 00](topic_00.md) — pointer\n')
    return { ctx, fs }
  }

  it('consults the stored getter per render (direct callback path)', async () => {
    const { ctx } = await seededContext()
    let settings = { truncate: true, maxBytes: 700 }
    let textFn: ((context: { scope?: unknown }) => string) | undefined
    ctx.provide('systemPrompt' as never, {
      section: (def: { text: (context: { scope?: unknown }) => string }) => { textFn = def.text },
    } as never)
    const section = new MemorySection(ctx, '/mem', { readSettings: () => settings })
    await section.refresh()
    section.start()
    const text = (): string => {
      if (textFn === undefined) throw new Error('section text callback not captured')
      return textFn({})
    }
    const retained = (): number => indexBlock(text()).filter(line => line.startsWith('- [')).length

    const capped = text()
    expect(capped).toContain('more memory topics')
    expect(indexBlock(capped).at(-1)).toBe(memoryIndexNote(12 - retained()))
    expect(retained()).toBeGreaterThan(0)
    expect(retained()).toBeLessThan(12)
    const retainedUnder700 = retained()

    // Flip truncation off: the very next render (no re-registration, no new
    // section) serves the uncapped index.
    settings = { truncate: false, maxBytes: 700 }
    const uncapped = text()
    expect(uncapped).not.toContain('more memory topics')
    expect(uncapped).toContain('- [topic 11](topic_11.md)')
    expect(retained()).toBe(12)

    // Tighten the budget instead: the cap re-applies on the same instance.
    settings = { truncate: true, maxBytes: 400 }
    const tighter = text()
    expect(tighter).toContain('more memory topics')
    expect(tighter).not.toContain('- [topic 11](topic_11.md)')
    expect(retained()).toBeLessThan(retainedUnder700)
    await ctx.fiber.dispose()
  })

  it('applies the same reader on the real assemble path and its re-render', async () => {
    const { ctx, fs } = await seededContext()
    await ctx.plugin(SystemPrompt)
    let settings = { truncate: false, maxBytes: 700 }
    const section = new MemorySection(ctx, '/mem', { readSettings: () => settings })
    await section.refresh()
    section.start()
    const textOf = async (agent: Agent): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      return assembly.sections.find(entry => entry.name === MEMORY_SECTION_NAME)?.text ?? ''
    }
    const indexBytes = (text: string): number => {
      const start = text.indexOf(MEMORY_INDEX_HEADING)
      const end = text.indexOf('## Searching past context')
      return bytes(text.slice(start, end).trimEnd())
    }
    const agent = agentAt('/work/repo-a')
    const uncapped = await textOf(agent)
    expect(uncapped).toContain('- [topic 11](topic_11.md)')

    settings = { truncate: true, maxBytes: 700 }
    const capped = await textOf(agent)
    expect(capped).toContain('more memory topics')
    expect(capped).not.toContain('- [topic 11](topic_11.md)')
    // Acceptance: the index block's UTF-8 size stays inside the budget.
    expect(indexBytes(capped)).toBeLessThanOrEqual(700)

    // A host-side write forces a `system-prompt/change` re-render: the cap is
    // re-applied through the same render function the callback uses.
    const changes = vi.fn()
    ctx.on('system-prompt/change', changes)
    fs.seed('/mem/MEMORY.md', '- [topic 00](topic_00.md) — pointer v2\n')
    await section.refresh(agent)
    expect(changes).toHaveBeenCalled()
    const reRendered = await textOf(agent)
    expect(reRendered).toContain('pointer v2')
    expect(reRendered).toContain('more memory topics')
    expect(indexBytes(reRendered)).toBeLessThanOrEqual(700)
    await ctx.fiber.dispose()
  })
})
