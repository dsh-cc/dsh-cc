import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { scanMemoryDirectory } from '../src/scan.ts'
import { MemorySection, renderMemorySection, MEMORY_SECTION_NAME } from '../src/section.ts'
import { MIN_INDEX_MAX_BYTES } from '../src/section-settings.ts'
import type { MemorySectionSettings } from '../src/section-settings.ts'
import { FakeMemoryFs } from './helpers.ts'

/** UTF-8 bytes of the combined-index block inside a rendered section text. */
function indexBlockBytes(text: string): number {
  const start = text.indexOf('## Memory index')
  const end = text.indexOf('## Searching past context')
  const block = start === -1 ? '' : text.slice(start, end === -1 ? undefined : end)
  return Buffer.byteLength(block, 'utf8')
}

async function mountedFs(): Promise<{ fs: FakeMemoryFs }> {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  return { fs: ctx.fs as FakeMemoryFs }
}

describe('scanMemoryDirectory', () => {
  it('reads the entrypoint and frontmatter-valid topic files', async () => {
    const { fs } = await mountedFs()
    fs.seed('/root/MEMORY.md', '- [User role](user_role.md) — principal\n')
    fs.seed('/root/user_role.md', '---\nname: user role\ndescription: principal engineer\ntype: user\n---\nbody\n')
    fs.seed('/root/feedback_testing.md', '---\nname: testing\ndescription: no mocks\ntype: feedback\n---\nrule\n')
    const state = await scanMemoryDirectory(fs, '/root')
    expect(state.entrypoint).toContain('- [User role](user_role.md)')
    expect(state.topics.map(t => t.filename).sort()).toEqual(['feedback_testing.md', 'user_role.md'])
    expect(state.topics[0]?.frontmatter.name).toBe('testing')
  })

  it('returns an empty state for a missing directory', async () => {
    const { fs } = await mountedFs()
    const state = await scanMemoryDirectory(fs, '/missing')
    expect(state.entrypoint).toBeUndefined()
    expect(state.topics).toEqual([])
  })

  it('ignores non-markdown files and topics with broken frontmatter', async () => {
    const { fs } = await mountedFs()
    fs.seed('/root/notes.txt', 'not a memory')
    fs.seed('/root/broken.md', 'no frontmatter here')
    fs.seed('/root/good.md', '---\nname: a\ndescription: b\n---\nbody')
    const state = await scanMemoryDirectory(fs, '/root')
    expect(state.topics).toHaveLength(1)
    expect(state.topics[0]?.filename).toBe('good.md')
  })
})

describe('renderMemorySection', () => {
  it('renders entry content, an index, and search guidance', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', '- [User role](user_role.md) — principal\n')
    fs.seed('/ws/user_role.md', '---\nname: user role\ndescription: principal engineer\ntype: user\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('## MEMORY.md (this workspace)')
    expect(rendered).toContain('## MEMORY.md (global)')
    expect(rendered).toContain('- [User role](user_role.md) — principal')
    expect(rendered).toContain('## Memory index')
    expect(rendered).toContain('- [user role](user_role.md) — principal engineer (workspace) [user]')
    expect(rendered).toContain('## Searching past context')
    expect(rendered).toContain('grep -rn "<search term>" /ws/ --include="*.md"')
  })

  it('always renders with save guidance and placeholders when memoryless', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/user_role.md', '---\nname: a\ndescription: b\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    expect(rendered).toContain('(no memories yet)')
    expect(rendered).toContain('`/global`')
    expect(rendered).toContain('`/ws`')
    expect(rendered).toContain('scope: "global"')
  })

  it('renders an empty index when only the entrypoint exists', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', 'No memories yet.\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('## MEMORY.md (this workspace)')
    expect(rendered).not.toContain('## Memory index')
    expect(rendered).not.toContain('## Searching past context')
  })

  it('keeps the workspace and global layers distinct', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', '- [ws topic](ws.md) — here\n')
    fs.seed('/global/MEMORY.md', '- [global topic](g.md) — everywhere\n')
    const wsState = await scanMemoryDirectory(fs, '/ws')
    const globalState = await scanMemoryDirectory(fs, '/global')
    const rendered = renderMemorySection('/global', '/ws', globalState, wsState)
    expect(rendered).toContain('- [ws topic](ws.md) — here')
    expect(rendered).toContain('- [global topic](g.md) — everywhere')
  })
})

/**
 * The mounted MemorySection serves every agent from ONE registration: the
 * text callback receives the assembling agent through the assemble scope and
 * renders that agent's workspace layer, so two workspaces never see each
 * other's memories.
 */
describe('MemorySection (per-agent rendering)', () => {
  const agentAt = (cwd: string, delegationDepth = 0): Agent =>
    ({ session: { header: { cwd, delegationDepth } }, options: {} }) as unknown as Agent

  async function setup() {
    const ctx = new Context()
    await ctx.plugin(FakeMemoryFs)
    const fs = ctx.fs as unknown as FakeMemoryFs
    let textFn: ((context: { scope?: unknown }) => string) | undefined
    ctx.provide('systemPrompt' as never, {
      section: (def: { text: (context: { scope?: unknown }) => string }) => { textFn = def.text },
    } as never)
    const changes = vi.fn()
    ctx.on('system-prompt/change' as never, changes)
    const section = new MemorySection(ctx, '/mem')
    const text = (scope?: unknown) => {
      if (textFn === undefined) throw new Error('section text callback not captured')
      return textFn({ scope })
    }
    // Seed FIRST, then start: start()'s immediate global scan must not race
    // the test's seeds.
    const start = () => section.start()
    return { ctx, fs, section, text, changes, start }
  }

  it('renders each agent its own workspace layer plus the shared global layer', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    fs.seed('/mem/projects/work-repo-b/MEMORY.md', '- [beta](beta.md) — B\n')
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    start()
    const agentA = agentAt('/work/repo-a')
    const agentB = agentAt('/work/repo-b')
    await section.refresh(agentA)
    await section.refresh(agentB)

    const textA = text(agentA)
    expect(textA).toContain('- [alpha](alpha.md) — A')
    expect(textA).toContain('- [shared](shared.md) — G')
    expect(textA).not.toContain('- [beta](beta.md) — B')
    const textB = text(agentB)
    expect(textB).toContain('- [beta](beta.md) — B')
    expect(textB).toContain('- [shared](shared.md) — G')
    expect(textB).not.toContain('- [alpha](alpha.md) — A')
    await ctx.fiber.dispose()
  })

  it('renders an empty string for a delegated child (depth > 0)', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    start()
    const parent = agentAt('/work/repo-a', 0)
    const child = agentAt('/work/repo-a', 1)
    await section.refresh(parent)
    expect(text(parent)).toContain('- [alpha](alpha.md) — A')
    expect(text(child)).toBe('')
    await ctx.fiber.dispose()
  })

  it('renders an empty string when reading depth throws (fail closed)', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    start()
    await section.refresh()
    const broken = { session: { header: { cwd: '/work/repo-a' } }, options: { subagentDepth: -1 } } as unknown as Agent
    expect(text(broken)).toBe('')
    await ctx.fiber.dispose()
  })

  it('renders only the global layer when the assemble scope carries no agent', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    start()
    await section.refresh()

    const rendered = text()
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    expect(rendered).toContain('- [shared](shared.md) — G')
    expect(rendered).not.toContain('/mem/projects/')
    await ctx.fiber.dispose()
  })

  it('emits system-prompt/change only when a layer fragment changes', async () => {
    const { ctx, fs, section, text, changes, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    start()
    const agentA = agentAt('/work/repo-a')
    await section.refresh(agentA)
    const emitted = changes.mock.calls.length
    expect(emitted).toBeGreaterThan(0)
    expect(text(agentA)).toContain('- [alpha](alpha.md) — A')

    // Unchanged disk: no further emission.
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBe(emitted)

    // A host-side write: the next refresh emits again.
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A2\n')
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(emitted)
    expect(text(agentA)).toContain('- [alpha](alpha.md) — A2')
    await ctx.fiber.dispose()
  })

  it('triggers a lazy scan on first render of an unknown workspace', async () => {
    const { ctx, fs, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    start()
    const agentA = agentAt('/work/repo-a')

    // First render: placeholders plus guidance; the lazy scan kicks off.
    const first = text(agentA)
    expect(first).toContain('(no memories yet)')
    expect(first).toContain('memory_save')
    await vi.waitFor(() => expect(text(agentA)).toContain('- [alpha](alpha.md) — A'))
    await ctx.fiber.dispose()
  })
})

/**
 * The assemble-waterfall reconciliation: while a workspace's first scan is
 * still in flight, the assemble waterfall listener joins it (bounded) so the
 * FIRST assembly for that scope already carries the scanned text instead of
 * the placeholder — the first-turn request-2 prefix must not diverge. These
 * tests drive the REAL assembly path (`ctx.plugin(SystemPrompt)` then
 * `ctx.systemPrompt.assemble`) because the listener lives on that waterfall.
 */
describe('MemorySection (assemble waterfall readiness)', () => {
  const agentAt = (cwd: string, delegationDepth = 0): Agent =>
    ({ session: { header: { cwd, delegationDepth } }, options: {} }) as unknown as Agent

  async function setupReal(readSettings?: () => MemorySectionSettings | undefined) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FakeMemoryFs)
    const fs = ctx.fs as unknown as FakeMemoryFs
    const changes = vi.fn()
    ctx.on('system-prompt/change' as never, changes)
    const section = new MemorySection(ctx, '/mem', readSettings === undefined ? {} : { readSettings })
    const textOf = async (agent?: Agent): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble(agent === undefined ? {} : { scope: agent })
      return assembly.sections.find(section => section.name === MEMORY_SECTION_NAME)?.text ?? ''
    }
    // Seed FIRST, then start: start()'s immediate global scan must not race
    // the test's seeds (same contract as the per-agent rendering tests).
    const start = () => section.start()
    return { ctx, fs, changes, textOf, start }
  }

  it('first assembly with content carries the real memory text, no placeholder', async () => {
    const { ctx, fs, textOf, start } = await setupReal()
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    fs.seed('/mem/shared.md', '---\nname: shared\ndescription: G\ntype: user\n---\nbody\n')
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    fs.seed('/mem/projects/work-repo-a/alpha.md', '---\nname: alpha\ndescription: A\ntype: user\n---\nbody\n')
    start()

    // The very first assembly for this workspace: the listener must join the
    // in-flight scan rather than hand back the placeholder.
    const text = await textOf(agentAt('/work/repo-a'))
    expect(text).toContain('- [alpha](alpha.md) — A')
    expect(text).toContain('- [shared](shared.md) — G')
    expect(text).toContain('- [alpha](alpha.md) — A (workspace)')
    expect(text).not.toContain('(no memories yet)')
    await ctx.fiber.dispose()
  })

  it('first assembly for a delegated child drops the memory section', async () => {
    const { ctx, fs, textOf, start } = await setupReal()
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    start()
    const text = await textOf(agentAt('/work/repo-a', 1))
    expect(text).toBe('')
    await ctx.fiber.dispose()
  })

  it('renders memoryless directories stably without a second change emission', async () => {
    const { ctx, changes, textOf, start } = await setupReal()
    start()
    const first = await textOf(agentAt('/work/repo-a'))
    expect(first).toContain('# Memory')
    expect(first).toContain('memory_save')
    expect(first).toContain('(no memories yet)')

    // The reassembly the first-assembly scans triggered sees the same bytes,
    // and nothing emits again: a contentless directory never changes text.
    const second = await textOf(agentAt('/work/repo-a'))
    expect(second).toBe(first)
    const count = changes.mock.calls.length
    await textOf(agentAt('/work/repo-a'))
    expect(changes.mock.calls.length).toBe(count)
    await ctx.fiber.dispose()
  })

  it('applies the live index budget on the first-assembly readiness re-render', async () => {
    const { ctx, fs, textOf, start } = await setupReal(() => ({ truncate: true, maxBytes: MIN_INDEX_MAX_BYTES }))
    for (let i = 0; i < 12; i += 1) {
      const filename = `topic_${String(i).padStart(2, '0')}.md`
      fs.seed(`/mem/${filename}`, `---\nname: topic ${i}\ndescription: ${'d'.repeat(120)}\ntype: user\n---\nbody\n`)
    }
    start()
    // The readiness path re-renders through the same `render()`; the cap must
    // already hold on that first assembly, not only on later ones.
    const text = await textOf(agentAt('/work/repo-a'))
    expect(text).toContain('grep the memory directory for older entries')
    expect(indexBlockBytes(text)).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)
    await ctx.fiber.dispose()
  })
})
