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

  describe('entrypoint write gate', () => {
    function fullIndex(entries = 200): string {
      return Array.from({ length: entries }, (_, i) => `- [topic-${i}](topic-${i}.md) — entry ${i}`).join('\n')
    }

    it('rejects a save that pushes a within-limit index over the cap, writing nothing', async () => {
      const { ctx, fs } = await setup({ [`${WS_DIR}/MEMORY.md`]: fullIndex() })
      const before = fs.backingText(`${WS_DIR}/MEMORY.md`)

      const result = await call(ctx, VALID, agentAt(WORKSPACE))

      expect(result.isError).toBe(true)
      expect(String((result.error as { message?: string })?.message ?? '')).toContain('under 140 lines')
      expect(fs.backingText(`${WS_DIR}/MEMORY.md`)).toBe(before)
      expect(fs.backingText(`${WS_DIR}/user-profile.md`)).toBeUndefined()
    })

    it('rejects the same push-over in the global scope', async () => {
      const { ctx, fs } = await setup({ [`${HOME}/MEMORY.md`]: fullIndex() })
      const before = fs.backingText(`${HOME}/MEMORY.md`)

      const result = await call(ctx, { ...VALID, scope: 'global' }, agentAt(WORKSPACE))

      expect(result.isError).toBe(true)
      expect(fs.backingText(`${HOME}/MEMORY.md`)).toBe(before)
      expect(fs.backingText(`${HOME}/user-profile.md`)).toBeUndefined()
    })

    it('fail-opens when the index was ALREADY over the cap, warning in the message', async () => {
      const { ctx, fs, section } = await setup({ [`${WS_DIR}/MEMORY.md`]: fullIndex(300) })

      const result = await call(ctx, VALID, agentAt(WORKSPACE))

      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')
      expect(text).toContain('already over its 200-line/25000-byte cap')
      expect(text).toContain('tail entries are invisible until consolidation compacts it')
      expect(fs.backingText(`${WS_DIR}/user-profile.md`)).toBe(renderTopicFile(VALID))
      expect(fs.backingText(`${WS_DIR}/MEMORY.md`)).toContain('- [user-profile](user-profile.md)')
      expect(section.refresh).toHaveBeenCalledTimes(1)
    })

    it('succeeds overwriting an existing topic on a 200-line index (update-without-growth)', async () => {
      const seeded = `${fullIndex(199)}\n- [user-profile](user-profile.md) — old\n`
      const { ctx, fs } = await setup({ [`${WS_DIR}/MEMORY.md`]: seeded })

      const result = await call(ctx, VALID, agentAt(WORKSPACE))

      expect(result.isError).toBeFalsy()
      expect((result.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')).not.toContain('already over')
      const after = fs.backingText(`${WS_DIR}/MEMORY.md`) ?? ''
      expect(after.trim().split('\n').length).toBe(200)
      expect(after).toContain('principal engineer, Chinese communication')
    })

    it('passes at exactly the caps (200 lines / 25000 bytes) and rejects one over, CJK-safe', async () => {
      // Byte-exact index built from CJK pointer lines (3 UTF-8 bytes per char,
      // the UTF-8-vs-UTF-16 trap from truncate.spec.ts), ASCII-topped off to
      // exact byte counts. The user-profile pointer is line 200 so a
      // user-profile save REPLACES a line (line count stable) while a fresh
      // topic appends one (push-over).
      const prefix = '- [user-profile](user-profile.md) — '
      const cjkBase = (i: number) => `- [主题-${i}](主题-${i}.md) — `
      const padded = (base: string, bytes: number) => {
        const budget = bytes - Buffer.byteLength(base, 'utf8')
        return base + '记'.repeat(Math.floor(budget / 3)) + 'a'.repeat(budget % 3)
      }
      const cjkLines = Array.from({ length: 199 }, (_, i) => padded(cjkBase(i), 124))
      const seed = (descLen: number) =>
        [...cjkLines, `${prefix}${'a'.repeat(descLen)}`].join('\n')
      const bytesOf = (descLen: number) =>
        199 * 124 + 199 + Buffer.byteLength(prefix, 'utf8') + descLen
      // 199 separators between 200 lines; description is pure ASCII.
      // byteLength(prefix) = 38 ('—' is 3 UTF-8 bytes), so desc 87 → 25000.
      expect(bytesOf(87)).toBe(25000)
      expect(bytesOf(88)).toBe(25001)

      // Exactly 200 lines under the byte cap: a plain replace passes.
      const lines = await setup({ [`${WS_DIR}/MEMORY.md`]: seed(86) })
      await expect(call(lines.ctx, VALID, agentAt(WORKSPACE))).resolves.toMatchObject({ isError: false })

      // Resulting index of EXACTLY 25000 bytes passes; 25001 rejects and arms.
      const fit = await setup({ [`${WS_DIR}/MEMORY.md`]: seed(86) })
      await expect(call(fit.ctx, { ...VALID, description: 'a'.repeat(87) }, agentAt(WORKSPACE)))
        .resolves.toMatchObject({ isError: false })
      const big = await setup({ [`${WS_DIR}/MEMORY.md`]: seed(86) })
      const bigResult = await call(big.ctx, { ...VALID, description: 'a'.repeat(88) }, agentAt(WORKSPACE))
      expect(bigResult.isError).toBe(true)
      expect(big.fs.backingText(`${WS_DIR}/.consolidation-needed`)).toBeDefined()

      // 201 CJK lines pushes a within-cap index over the LINE cap: rejects
      // and arms (the appended topic is what overflows, not the seed).
      const appended = `${seed(86)}\n${padded('- [新话题](新话题.md) — ', 120)}`
      expect(appended.split('\n').length).toBe(201)
      const over = await setup({ [`${WS_DIR}/MEMORY.md`]: seed(86) })
      const overResult = await call(over.ctx, { name: 'cjk-topic', type: 'project', description: 'CJK push-over', body: 'x\n' }, agentAt(WORKSPACE))
      expect(overResult.isError).toBe(true)
      expect(over.fs.backingText(`${WS_DIR}/.consolidation-needed`)).toBeDefined()
    })

    describe('pressure arming', () => {
      it('arms the marker and appends the queued sentence on a push-over rejection', async () => {
        const { ctx, fs } = await setup({ [`${WS_DIR}/MEMORY.md`]: fullIndex() })

        const result = await call(ctx, VALID, agentAt(WORKSPACE))

        expect(result.isError).toBe(true)
        const message = String((result.error as { message?: string })?.message ?? '')
        expect(message).toContain('would exceed its cap')
        expect(message).toContain('A forced consolidation has been queued; the next turn-end will run it, bypassing the usual periodic gates.')
        const marker = fs.backingText(`${WS_DIR}/.consolidation-needed`)
        expect(marker).toBeDefined()
        expect(Number(marker!.split('\n')[0])).toBeGreaterThan(0)
      })

      it('leaves the message unchanged when the marker write fails', async () => {
        const { ctx, fs } = await setup({ [`${WS_DIR}/MEMORY.md`]: fullIndex() })
        vi.spyOn(fs, 'writeText').mockRejectedValue(new Error('disk gone'))

        const result = await call(ctx, VALID, agentAt(WORKSPACE))

        expect(result.isError).toBe(true)
        const message = String((result.error as { message?: string })?.message ?? '')
        expect(message).toContain('would exceed its cap')
        expect(message).not.toContain('forced consolidation')
      })

      it('global-scope rejection arms nothing and leaves the message untouched', async () => {
        const { ctx, fs } = await setup({ [`${HOME}/MEMORY.md`]: fullIndex() })

        const result = await call(ctx, { ...VALID, scope: 'global' }, agentAt(WORKSPACE))

        expect(result.isError).toBe(true)
        const message = String((result.error as { message?: string })?.message ?? '')
        expect(message).toContain('would exceed its cap')
        expect(message).not.toContain('forced consolidation')
        expect(fs.backingText(`${HOME}/.consolidation-needed`)).toBeUndefined()
        expect(fs.backingText(`${WS_DIR}/.consolidation-needed`)).toBeUndefined()
      })

      it('fail-open over-limit workspace save arms and extends the WARNING on arm success', async () => {
        const { ctx, fs } = await setup({ [`${WS_DIR}/MEMORY.md`]: fullIndex(300) })

        const result = await call(ctx, VALID, agentAt(WORKSPACE))

        expect(result.isError).toBeFalsy()
        const text = (result.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')
        expect(text).toContain('already over its 200-line/25000-byte cap')
        expect(text).toContain('A forced consolidation has been queued; the next turn-end will run it, bypassing the usual periodic gates.')
        expect(fs.backingText(`${WS_DIR}/.consolidation-needed`)).toBeDefined()
      })

      it('fail-open over-limit save does NOT append the sentence when the arm fails', async () => {
        const { ctx, fs } = await setup({ [`${WS_DIR}/MEMORY.md`]: fullIndex(300) })
        vi.spyOn(fs, 'writeText').mockRejectedValue(new Error('disk gone'))

        const result = await call(ctx, VALID, agentAt(WORKSPACE))

        // The save itself fails too when the fs is down; the point is that no
        // queued sentence ever leaked into any model-visible text.
        expect(result.isError).toBe(true)
        expect(String((result.error as { message?: string })?.message ?? '')).not.toContain('forced consolidation')
      })
    })
  })
})
