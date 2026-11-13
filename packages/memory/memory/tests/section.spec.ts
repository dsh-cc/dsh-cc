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

/**
 * The exact object the budget caps (design
 * docs/plans/2026-11-13-memory-section-unified-catalog.md §E):
 * `['## Memory index', '', ...kept, ...(ellipsis ? [ellipsis] : [])].join('\n')`.
 * Trailing blank separator lines before the search block are excluded — counting
 * them would measure the section, not the block.
 */
function catalogBlockBytes(text: string): number {
  const lines = text.split('\n')
  const start = lines.indexOf('## Memory index')
  if (start === -1) return 0
  const end = lines.indexOf('## Searching past context')
  const block = lines.slice(start, end === -1 ? undefined : end)
  while (block.length > 0 && block.at(-1) === '') block.pop()
  return Buffer.byteLength(block.join('\n'), 'utf8')
}

/**
 * The fixed header block captured from the PRE-CHANGE renderer
 * (`.scratch/golden/pre-change.json`, `header`), for fixture dirs
 * {@linkcode GOLDEN_WS} and {@linkcode GOLDEN_GLOBAL}. It is byte-identical to
 * today's render — the design changes only the body below it (§A) — so it is
 * pinned literally, ending with the blank separator line before the catalog.
 */
const GOLDEN_WS = '/tmp/golden-fixture/ws'
const GOLDEN_GLOBAL = '/tmp/golden-fixture/global'
const GOLDEN_HEADER = [
  '# Memory',
  '',
  'You have a persistent, file-based memory system. Use it to recall context across conversations and to save durable facts.',
  '',
  'There are two scope levels:',
  `- workspace: memories private to the current workspace, stored at \`${GOLDEN_WS}\`.`,
  `- global: memories shared by every workspace, stored at \`${GOLDEN_GLOBAL}\`.`,
  '',
  'Each directory keeps its own index and topic files. Save each memory to the directory matching its scope; never write memory content directly into a MEMORY.md.',
  '',
  'To save a durable fact, call the `memory_save` tool — it writes the topic file and updates MEMORY.md for you. '
  + `By default the memory lands in this workspace's directory (\`${GOLDEN_WS}\`), visible only to sessions of this workspace; `
  + `pass \`scope: "global"\` for facts useful across ALL workspaces (saved to \`${GOLDEN_GLOBAL}\`).`,
  'Never write or edit files under a memory directory directly: the sandbox fences writes outside the session workspace, so direct writes always fail.',
].join('\n') + '\n\n'

/**
 * The same capture's search block with the ONE approved wording change applied
 * (§A): the lead sentence now names the catalog entry the model actually sees
 * instead of the `MEMORY.md` body it can no longer see.
 */
const GOLDEN_SEARCH = [
  '## Searching past context',
  'When an index entry is not enough, search topic files and the transcript log with narrow terms (error messages, file paths, function names):',
  '```',
  `grep -rn "<search term>" ${GOLDEN_WS}/ ${GOLDEN_GLOBAL}/ --include="*.md"`,
  '```',
].join('\n')

async function mountedFs(): Promise<{ fs: FakeMemoryFs }> {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  return { fs: ctx.fs as FakeMemoryFs }
}

/** Seed one frontmatter-valid topic file (what the catalog enumerates). */
function seedTopic(fs: FakeMemoryFs, dir: string, filename: string, name: string, description: string): void {
  fs.seed(`${dir}/${filename}`, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`)
}

/**
 * Remove a file from the double's backing map. `FakeMemoryFs` exposes no
 * unlink, and the change-detection tests need a real topic DELETION (design §F).
 */
function removeFile(fs: FakeMemoryFs, path: string): void {
  const backing = (fs as unknown as { backing: Map<string, string> }).backing
  backing.delete(path)
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
  it('renders one catalog entry, the catalog heading, and search guidance', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', '- [User role](user_role.md) — principal\n')
    fs.seed('/ws/user_role.md', '---\nname: user role\ndescription: principal engineer\ntype: user\n---\nbody\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered.match(/## Memory index/g)).toHaveLength(1)
    expect(rendered).not.toContain('## MEMORY.md (')
    expect(rendered).toContain('- [user role](user_role.md) — principal engineer (workspace) [user]')
    expect(rendered).toContain('## Searching past context')
    expect(rendered).toContain('grep -rn "<search term>" /ws/ --include="*.md"')
  })

  it('renders the fixed header block and the search block byte-identically to the pre-change capture', async () => {
    // Rebuild the exact fixture the golden was captured with: two workspace
    // topics (both listed by MEMORY.md) and one global topic.
    const { fs } = await mountedFs()
    fs.seed(`${GOLDEN_WS}/MEMORY.md`, '- [Alpha](alpha.md) — first\n- [Beta](beta.md) — second\n')
    fs.seed(`${GOLDEN_WS}/alpha.md`, '---\nname: alpha\ndescription: first topic\ntype: project\n---\nbody\n')
    fs.seed(`${GOLDEN_WS}/beta.md`, '---\nname: beta\ndescription: second topic\ntype: feedback\n---\nbody\n')
    fs.seed(`${GOLDEN_GLOBAL}/MEMORY.md`, '- [Gamma](gamma.md) — global one\n')
    fs.seed(`${GOLDEN_GLOBAL}/gamma.md`, '---\nname: gamma\ndescription: global topic\ntype: user\n---\nbody\n')
    const wsState = await scanMemoryDirectory(fs, GOLDEN_WS)
    const globalState = await scanMemoryDirectory(fs, GOLDEN_GLOBAL)
    const text = renderMemorySection(GOLDEN_GLOBAL, GOLDEN_WS, globalState, wsState)

    // Header: `# Memory` through the save guidance, byte-for-byte unchanged.
    expect(text.slice(0, text.indexOf('## Memory index'))).toBe(GOLDEN_HEADER)
    // Search guidance: byte-for-byte, after the single approved wording change.
    expect(text.slice(text.indexOf('## Searching past context'))).toBe(GOLDEN_SEARCH)
    // And the body between them is one catalog with maintained order first:
    // MEMORY.md lists Alpha then Beta, so that is the rendered order.
    expect(text.indexOf('- [alpha](alpha.md)')).toBeLessThan(text.indexOf('- [beta](beta.md)'))
    expect(text).toContain('- [gamma](gamma.md) — global topic (global) [user]')
  })

  it('renders the catalog entry for a topic file even when no entrypoint exists', async () => {
    const { fs } = await mountedFs()
    seedTopic(fs, '/ws', 'user_role.md', 'a', 'b')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    // A parsed topic is enumerated from its own frontmatter: MEMORY.md is not
    // required for a topic to be visible (design §A row 2).
    expect(rendered).toContain('## Memory index')
    expect(rendered).toContain('- [a](user_role.md) — b (workspace)')
    expect(rendered).not.toContain('(no memories yet)')
    expect(rendered).toContain('`/global`')
    expect(rendered).toContain('`/ws`')
    expect(rendered).toContain('scope: "global"')
  })

  it('renders the (no memories yet) placeholder when no layer holds a topic', async () => {
    // Only the entrypoint exists: no parsed topic anywhere, so the catalog is
    // replaced by the placeholder and the search block is dropped (§A row 1).
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', 'No memories yet.\n')
    const state = await scanMemoryDirectory(fs, '/ws')
    const rendered = renderMemorySection('/global', '/ws', undefined, state)
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    expect(rendered).toContain('(no memories yet)')
    expect(rendered).not.toContain('## Memory index')
    expect(rendered).not.toContain('## Searching past context')
  })

  it('keeps the workspace and global layers distinct', async () => {
    const { fs } = await mountedFs()
    fs.seed('/ws/MEMORY.md', '- [ws topic](ws.md) — here\n')
    seedTopic(fs, '/ws', 'ws.md', 'ws topic', 'here')
    fs.seed('/global/MEMORY.md', '- [global topic](g.md) — everywhere\n')
    seedTopic(fs, '/global', 'g.md', 'global topic', 'everywhere')
    const wsState = await scanMemoryDirectory(fs, '/ws')
    const globalState = await scanMemoryDirectory(fs, '/global')
    const rendered = renderMemorySection('/global', '/ws', globalState, wsState)
    expect(rendered).toContain('- [ws topic](ws.md) — here (workspace)')
    expect(rendered).toContain('- [global topic](g.md) — everywhere (global)')
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
    seedTopic(fs, '/mem/projects/work-repo-a', 'alpha.md', 'alpha', 'A')
    fs.seed('/mem/projects/work-repo-b/MEMORY.md', '- [beta](beta.md) — B\n')
    seedTopic(fs, '/mem/projects/work-repo-b', 'beta.md', 'beta', 'B')
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    seedTopic(fs, '/mem', 'shared.md', 'shared', 'G')
    start()
    const agentA = agentAt('/work/repo-a')
    const agentB = agentAt('/work/repo-b')
    await section.refresh(agentA)
    await section.refresh(agentB)

    const textA = text(agentA)
    expect(textA).toContain('- [alpha](alpha.md) — A (workspace)')
    expect(textA).toContain('- [shared](shared.md) — G (global)')
    expect(textA).not.toContain('beta.md')
    const textB = text(agentB)
    expect(textB).toContain('- [beta](beta.md) — B (workspace)')
    expect(textB).toContain('- [shared](shared.md) — G (global)')
    expect(textB).not.toContain('alpha.md')
    await ctx.fiber.dispose()
  })

  it('renders an empty string for a delegated child (depth > 0)', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    seedTopic(fs, '/mem/projects/work-repo-a', 'alpha.md', 'alpha', 'A')
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    seedTopic(fs, '/mem', 'shared.md', 'shared', 'G')
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
    seedTopic(fs, '/mem', 'shared.md', 'shared', 'G')
    start()
    await section.refresh()
    const broken = { session: { header: { cwd: '/work/repo-a' } }, options: { subagentDepth: -1 } } as unknown as Agent
    expect(text(broken)).toBe('')
    await ctx.fiber.dispose()
  })

  it('renders only the global layer when the assemble scope carries no agent', async () => {
    const { ctx, fs, section, text, start } = await setup()
    fs.seed('/mem/MEMORY.md', '- [shared](shared.md) — G\n')
    seedTopic(fs, '/mem', 'shared.md', 'shared', 'G')
    start()
    await section.refresh()

    const rendered = text()
    expect(rendered).toContain('# Memory')
    expect(rendered).toContain('memory_save')
    expect(rendered).toContain('- [shared](shared.md) — G (global)')
    expect(rendered).not.toContain('/mem/projects/')
    await ctx.fiber.dispose()
  })

  it('emits system-prompt/change only when a layer fingerprint changes', async () => {
    const { ctx, fs, section, text, changes, start } = await setup()
    const dir = '/mem/projects/work-repo-a'
    fs.seed(`${dir}/MEMORY.md`, '- [alpha](alpha.md) — A\n- [beta](beta.md) — B\n')
    seedTopic(fs, dir, 'alpha.md', 'alpha', 'A')
    seedTopic(fs, dir, 'beta.md', 'beta', 'B')
    start()
    const agentA = agentAt('/work/repo-a')
    await section.refresh(agentA)
    const emitted = changes.mock.calls.length
    expect(emitted).toBeGreaterThan(0)
    expect(text(agentA)).toContain('- [alpha](alpha.md) — A (workspace)')

    // Unchanged disk: the fingerprint matches, so nothing emits.
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBe(emitted)
    expect(text(agentA)).toContain('- [alpha](alpha.md) — A (workspace)')

    // Prose-only MEMORY.md edit (no pointer added, removed or reordered): the
    // entrypoint body is no longer rendered, so it is not part of the
    // fingerprint and no reassembly is requested (design §F, R18). The scan
    // still publishes its state on the equal path, so the render stays current.
    fs.seed(`${dir}/MEMORY.md`, '# Notes\n\n- [alpha](alpha.md) — A\n- [beta](beta.md) — B\n\nKeep this file tidy.\n')
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBe(emitted)
    expect(text(agentA)).toContain('- [beta](beta.md) — B (workspace)')

    // A new topic file no pointer lists yet: the tail order changes.
    seedTopic(fs, dir, 'gamma.md', 'gamma', 'C')
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(emitted)
    expect(text(agentA)).toContain('- [gamma](gamma.md) — C (workspace)')

    // Reordering the pointers is a change even though the entry SET is the
    // same: pass-1 order follows MEMORY.md.
    let now = changes.mock.calls.length
    fs.seed(`${dir}/MEMORY.md`, '- [beta](beta.md) — B\n- [alpha](alpha.md) — A\n')
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(now)
    expect(text(agentA).indexOf('- [beta](beta.md)')).toBeLessThan(text(agentA).indexOf('- [alpha](alpha.md)'))

    // A frontmatter edit changes the fingerprint...
    now = changes.mock.calls.length
    seedTopic(fs, dir, 'alpha.md', 'alpha', 'A'.repeat(200))
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(now)
    const trimmed = text(agentA)

    // ...even when trimming hides it: the fingerprint carries the RAW
    // description, so two oversized descriptions that trim to the same text
    // still emit (over-firing, never a stale section).
    now = changes.mock.calls.length
    seedTopic(fs, dir, 'alpha.md', 'alpha', 'A'.repeat(400))
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(now)
    expect(text(agentA)).toBe(trimmed)

    // Deleting a topic file changes the tail.
    now = changes.mock.calls.length
    removeFile(fs, `${dir}/gamma.md`)
    await section.refresh(agentA)
    expect(changes.mock.calls.length).toBeGreaterThan(now)
    expect(text(agentA)).not.toContain('gamma.md')
    await ctx.fiber.dispose()
  })

  it('triggers a lazy scan on first render of an unknown workspace', async () => {
    const { ctx, fs, text, start } = await setup()
    fs.seed('/mem/projects/work-repo-a/MEMORY.md', '- [alpha](alpha.md) — A\n')
    seedTopic(fs, '/mem/projects/work-repo-a', 'alpha.md', 'alpha', 'A')
    start()
    const agentA = agentAt('/work/repo-a')

    // First render: placeholders plus guidance; the lazy scan kicks off.
    const first = text(agentA)
    expect(first).toContain('(no memories yet)')
    expect(first).toContain('memory_save')
    await vi.waitFor(() => expect(text(agentA)).toContain('- [alpha](alpha.md) — A (workspace)'))
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

  it('applies the live catalog budget on the first-assembly readiness re-render', async () => {
    const { ctx, fs, textOf, start } = await setupReal(() => ({
      truncate: true,
      maxBytes: MIN_INDEX_MAX_BYTES,
      descriptionMaxBytes: 160,
    }))
    for (let i = 0; i < 12; i += 1) {
      const filename = `topic_${String(i).padStart(2, '0')}.md`
      fs.seed(`/mem/${filename}`, `---\nname: topic ${i}\ndescription: ${'d'.repeat(120)}\ntype: user\n---\nbody\n`)
    }
    start()
    // The readiness path re-renders through the same `render()`; the cap must
    // already hold on that first assembly, not only on later ones.
    const text = await textOf(agentAt('/work/repo-a'))
    expect(text).toContain('grep the memory directory')
    expect(text).toContain('… (')
    expect(catalogBlockBytes(text)).toBeLessThanOrEqual(MIN_INDEX_MAX_BYTES)
    await ctx.fiber.dispose()
  })
})
