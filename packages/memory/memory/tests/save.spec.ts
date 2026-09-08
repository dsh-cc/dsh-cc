import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { FakeMemoryFs } from './helpers.ts'
import {
  MEMORY_SAVE_TOOL,
  registerMemorySaveTool,
  renderTopicFile,
  upsertPointer,
} from '../src/save.ts'
import { canonicalMemoryRoot, projectSlug } from '../src/paths.ts'
import type { MemorySection } from '../src/section.ts'

/**
 * The `memory_save` tool over a bare ToolRuntime with the in-memory fs: the
 * model-facing save channel must generate frontmatter, maintain the MEMORY.md
 * pointer, write host-side under the confined per-call policy, and refresh the
 * section — while rejecting invalid input with zero writes. Saves default to
 * the calling agent's workspace directory (`<home>/projects/<slug>`);
 * `scope: "global"` targets the home root instead.
 */

const HOME = '/mem'
const WORKSPACE = '/work/repo'
const WS_DIR = `${HOME}/projects/${projectSlug(WORKSPACE)}`

/** Minimal agent stand-in carrying a session cwd. */
function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

async function setup(seed: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeMemoryFs)
  const fs = ctx.fs as unknown as FakeMemoryFs
  for (const [path, content] of Object.entries(seed)) fs.seed(path, content)
  const section = { refresh: vi.fn(async () => {}) }
  const dispose = registerMemorySaveTool(ctx, HOME, section as unknown as MemorySection)
  return { ctx, fs, section, dispose }
}

let callCounter = 0
function call(ctx: Context, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: MEMORY_SAVE_TOOL,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
}

const VALID = {
  name: 'user-profile',
  type: 'user',
  description: 'principal engineer, Chinese communication',
  body: '- works on dsh plugins\n',
}

describe('renderTopicFile / upsertPointer (pure)', () => {
  it('renders rationalized frontmatter above the trimmed body', () => {
    expect(renderTopicFile(VALID)).toBe(
      '---\nname: user-profile\ndescription: principal engineer, Chinese communication\ntype: user\n---\n\n- works on dsh plugins\n',
    )
  })

  it('appends a pointer to an empty or populated index', () => {
    expect(upsertPointer('', VALID)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
    const existing = '- [other](other.md) — o\n'
    expect(upsertPointer(existing, VALID)).toBe(
      '- [other](other.md) — o\n- [user-profile](user-profile.md) — principal engineer, Chinese communication\n',
    )
  })

  it('replaces the pointer line for the same topic', () => {
    const existing = '- [user-profile](user-profile.md) — old description\n- [other](other.md) — o\n'
    expect(upsertPointer(existing, VALID)).toBe(
      '- [user-profile](user-profile.md) — principal engineer, Chinese communication\n- [other](other.md) — o\n',
    )
  })
})

describe('memory_save tool', () => {
  it('registers under the tools service with the structured parameters', async () => {
    const { ctx, dispose } = await setup()
    expect(dispose).toBeTypeOf('function')
    const tool = ctx.tools.get(MEMORY_SAVE_TOOL)!
    expect(tool.description).toContain('ONLY')
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain(MEMORY_SAVE_TOOL)
  })

  it('writes the topic file and index host-side under the confined policy, then refreshes', async () => {
    const { ctx, fs, section } = await setup()
    const writeSpy = vi.spyOn(fs, 'writeText')

    const result = await call(ctx, VALID, agentAt(WORKSPACE))

    expect(result.isError).toBeFalsy()
    expect(fs.backingText(`${WS_DIR}/user-profile.md`)).toBe(renderTopicFile(VALID))
    expect(fs.backingText(`${WS_DIR}/MEMORY.md`)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
    for (const callArgs of writeSpy.mock.calls) {
      expect(callArgs[4]).toEqual({ mode: 'workspace-write', workspaceRoot: WS_DIR })
    }
    expect(section.refresh).toHaveBeenCalledTimes(1)
  })

  it('saves to the home root when scope is global', async () => {
    const { ctx, fs } = await setup()
    const writeSpy = vi.spyOn(fs, 'writeText')

    const result = await call(ctx, { ...VALID, scope: 'global' }, agentAt(WORKSPACE))

    expect(result.isError).toBeFalsy()
    expect(fs.backingText(`${HOME}/user-profile.md`)).toBe(renderTopicFile(VALID))
    expect(fs.backingText(`${HOME}/MEMORY.md`)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
    expect(fs.backingText(`${WS_DIR}/user-profile.md`)).toBeUndefined()
    for (const callArgs of writeSpy.mock.calls) {
      expect(callArgs[4]).toEqual({ mode: 'workspace-write', workspaceRoot: HOME })
    }
  })

  it('falls back to the process cwd when the execution carries no agent', async () => {
    const { ctx, fs } = await setup()

    const result = await call(ctx, VALID)

    expect(result.isError).toBeFalsy()
    const dir = `${HOME}/projects/${projectSlug(canonicalMemoryRoot(process.cwd()))}`
    expect(fs.backingText(`${dir}/user-profile.md`)).toBe(renderTopicFile(VALID))
  })

  it('re-saving the same name replaces its pointer line instead of duplicating it', async () => {
    const { ctx, fs } = await setup({
      [`${WS_DIR}/MEMORY.md`]: '- [user-profile](user-profile.md) — old\n',
    })

    const result = await call(ctx, VALID, agentAt(WORKSPACE))

    expect(result.isError).toBeFalsy()
    expect(fs.backingText(`${WS_DIR}/MEMORY.md`)).toBe('- [user-profile](user-profile.md) — principal engineer, Chinese communication\n')
  })

  it('rejects invalid input with an error result and zero writes', async () => {
    const cases = [
      { ...VALID, name: '../escape' },
      { ...VALID, name: 'Memory' }, // reserved, case-insensitive
      { ...VALID, name: 'has_underscore' },
      { ...VALID, type: 'task' },
      { ...VALID, description: 'two\nlines' },
      { ...VALID, description: 'x'.repeat(201) },
      { ...VALID, body: '   ' },
      { ...VALID, scope: 'team' },
    ]
    for (const args of cases) {
      const { ctx, fs, section } = await setup()
      const result = await call(ctx, args)
      expect(result.isError).toBe(true)
      expect(fs.backingSize()).toBe(0)
      expect(section.refresh).not.toHaveBeenCalled()
    }
  })

  it('is not registered when the host has no tools service', () => {
    const ctx = new Context()
    const section = { refresh: vi.fn(async () => {}) }
    expect(registerMemorySaveTool(ctx, HOME, section as unknown as MemorySection)).toBeUndefined()
  })
})
