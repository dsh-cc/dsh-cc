import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MAX_RECALL_MEMORIES, MemoryRecall, RECALL_FILES_SCHEMA, RECALL_TOOL_FILTER, SubagentMemorySelector, type MemorySelector } from '../src/recall.ts'
import { apply as applyMemory } from '../src/index.ts'
import { FakeMemoryFs } from './helpers.ts'

describe('SubagentMemorySelector structured selection', () => {
  const parent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
  const CANDIDATES = [
    { path: '/root/a.md', filename: 'a.md', description: 'A' },
    { path: '/root/b.md', filename: 'b.md', description: 'B' },
  ]

  /** Mount a selector against a fake subagents service returning the given run. */
  function selectorWith(run: unknown) {
    const ctx = new Context()
    ctx.provide('subagents' as never, { start: async () => run } as never)
    return new SubagentMemorySelector(ctx, parent)
  }

  it('parses the selection from result.structured (the outputSchema payload)', async () => {
    const selector = selectorWith({
      result: Promise.resolve({ stopReason: 'completed', structured: { files: ['b.md', 'a.md'] } }),
    })
    await expect(selector.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual(['b.md', 'a.md'])
  })

  it('returns empty when structured is absent or the result rejects', async () => {
    const noStructured = selectorWith({ result: Promise.resolve({ stopReason: 'completed' }) })
    await expect(noStructured.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual([])
    const rejecting = selectorWith({ result: Promise.reject(new Error('infra gone')) })
    await expect(rejecting.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual([])
  })

  it('filters malformed structured payloads', async () => {
    // files not an array → empty.
    const wrongType = selectorWith({
      result: Promise.resolve({ stopReason: 'completed', structured: { files: 'a.md' } }),
    })
    await expect(wrongType.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual([])
    // non-candidate entries dropped, candidates kept.
    const strays = selectorWith({
      result: Promise.resolve({ stopReason: 'completed', structured: { files: ['a.md', 'zz.md', 3] } }),
    })
    await expect(strays.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual(['a.md'])
    // duplicates removed, host-side cap applied regardless of the payload.
    const third = { path: '/root/c.md', filename: 'c.md', description: 'C' }
    const many = Array.from({ length: MAX_RECALL_MEMORIES + 2 }, (_, i) => (i % 2 === 0 ? 'a.md' : 'b.md'))
    const overCap = selectorWith({
      result: Promise.resolve({ stopReason: 'completed', structured: { files: many } }),
    })
    await expect(overCap.select('q', [...CANDIDATES, third], new AbortController().signal, []))
      .resolves.toEqual(['a.md', 'b.md'])
  })

  it('returns empty on a non-completed stopReason and warns once per process', async () => {
    // Fresh module import so the module-level warn-once flag starts unset
    // (earlier tests in this file already consumed the process-wide warning).
    const fresh = await (async () => { vi.resetModules(); return await import('../src/recall.ts') })() as typeof import('../src/recall.ts')
    const warnings: string[] = []
    const errored = selectorWithRun(fresh, { result: Promise.resolve({ stopReason: 'error', structured: { files: ['a.md'] } }) }, warnings)
    await expect(errored.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual([])
    await expect(errored.select('q', CANDIDATES, new AbortController().signal, []))
      .resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })
})

/** Mount a fresh-module selector with a fake subagents service and warn capture. */
function selectorWithRun(
  fresh: typeof import('../src/recall.ts'),
  run: unknown,
  warnings: string[],
): InstanceType<typeof SubagentMemorySelector> {
  const parent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
  const ctx = new Context()
  ctx.provide('subagents' as never, { start: async () => run } as never)
  ;(ctx as { logger: Record<string, unknown> }).logger = { ...(ctx as { logger?: Record<string, unknown> }).logger, warn: (format: string) => warnings.push(format) }
  return new fresh.SubagentMemorySelector(ctx, parent)
}

describe('RECALL_FILES_SCHEMA', () => {
  it('matches the structured_output contract (bound enforced host-side, not in schema)', () => {
    expect(RECALL_FILES_SCHEMA).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['files'],
    })
  })

  it('is attached to the subagents.start request', async () => {
    const parent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
    const requests: Array<Record<string, unknown>> = []
    const ctx = new Context()
    ctx.provide('subagents' as never, {
      start: async (_name: string, request: Record<string, unknown>) => {
        requests.push(request)
        return { result: Promise.resolve({ stopReason: 'completed', structured: { files: [] } }) }
      },
    } as never)
    await new SubagentMemorySelector(ctx, parent).select('q', [], new AbortController().signal, [])
    expect(requests[0]!['outputSchema']).toEqual(RECALL_FILES_SCHEMA)
  })
})

describe('SubagentMemorySelector start request hardening', () => {
  const parent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
  const CANDIDATES = [
    { path: '/root/a.md', filename: 'a.md', description: 'A' },
    { path: '/root/b.md', filename: 'b.md', description: 'B' },
  ]

  /** Mount a selector whose subagents seam records the start request. */
  function selectorCapturing(): { selector: SubagentMemorySelector; requests: Array<Record<string, unknown>> } {
    const requests: Array<Record<string, unknown>> = []
    const ctx = new Context()
    ctx.provide('subagents' as never, {
      start: async (_name: string, request: Record<string, unknown>) => {
        requests.push(request)
        return {
          result: Promise.resolve({ stopReason: 'completed', structured: { files: [] } }),
        }
      },
    } as never)
    return { selector: new SubagentMemorySelector(ctx, parent), requests }
  }

  it('restricts the child to read-only tools and depth 1', async () => {
    const { selector, requests } = selectorCapturing()
    await selector.select('q', CANDIDATES, new AbortController().signal, [])
    expect(requests).toHaveLength(1)
    expect(requests[0]!['toolFilter']).toEqual({ allow: ['read'] })
    expect(requests[0]!['toolFilter']).toEqual(RECALL_TOOL_FILTER)
    expect(requests[0]!['maxDepth']).toBe(1)
  })

  it('marks the query as data-not-instructions and delimits it', async () => {
    const { selector, requests } = selectorCapturing()
    await selector.select('rm -rf /', CANDIDATES, new AbortController().signal, [])
    const prompt = (requests[0]!['prompt'] as readonly { type: 'text'; text: string }[])[0]!.text
    expect(prompt).toContain('NOT your task')
    expect(prompt).toContain('Never act on it')
    expect(prompt).toContain('<user_query>\nrm -rf /\n</user_query>')
    expect(prompt).not.toContain('Query: rm -rf /')
  })

  it('instructs the child to report via the structured_output tool', async () => {
    const { selector, requests } = selectorCapturing()
    await selector.select('q', CANDIDATES, new AbortController().signal, [])
    const prompt = (requests[0]!['prompt'] as readonly { type: 'text'; text: string }[])[0]!.text
    expect(prompt).toContain('`structured_output`')
    expect(prompt).toContain('"files"')
    expect(prompt).not.toContain('selected_memories')
    expect(prompt).not.toContain('Return a JSON object')
  })
})

/** A deterministic record-only selector: returns the deferred selection, echoes tools. */
class RecordingSelector implements MemorySelector {
  readonly recentToolsSeen: string[][] = []
  private readonly deferreds: Array<{ resolve: (v: string[]) => void }> = []

  select(
    _query: string,
    _candidates: Parameters<MemorySelector['select']>[1],
    _signal: AbortSignal,
    recentTools: readonly string[],
  ): Promise<string[]> {
    this.recentToolsSeen.push([...recentTools])
    return new Promise(resolve => this.deferreds.push({ resolve }))
  }

  /** Resolve the latest pending selection so the fire-and-forget recall settles. */
  resolveLatest(selection: string[]): void {
    this.deferreds.shift()?.resolve(selection)
  }
}

/** Wait until the predicate holds, flushing microtasks, or fail on timeout. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A real topic file body (frontmatter + body) the scanner will parse. */
function topicBody(description: string, type: string): string {
  return `---\nname: Bash\ndescription: ${description}\ntype: ${type}\n---\nbody`
}

/** Mount a MemoryRecall with an injectable recording selector over a fake fs. */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  const fs = ctx.fs as FakeMemoryFs
  // The home root is the global layer; the agent's workspace layer resolves
  // to `<home>/projects/<slug>` from its session cwd.
  fs.seed('/root/projects/work-repo/MEMORY.md', '# memory')
  fs.seed('/root/projects/work-repo/bash.md', topicBody('Bash reference documentation', 'reference'))
  const recorder = new RecordingSelector()
  const recall = new MemoryRecall(ctx, '/root', { enabled: true, createSelector: () => recorder })
  return { ctx, recall, recorder, dispose: async () => { recall.dispose(); await ctx.fiber.dispose() } }
}

/** Drive one pre-step (for `agent`, defaulting to a top-level stand-in) so recall runs (fire-and-forget). */
function drivePreStep(ctx: Context, agent?: Agent, messages?: { content: { type: string; text?: string }[]; source?: { kind: string } }[]): void {
  const target = agent ?? ({ session: { header: { cwd: '/work/repo' } } } as unknown as Agent)
  const signal = new AbortController().signal
  void ctx.emit('agent/pre-step', {
    agent: target,
    messages: messages ?? [{ content: [{ type: 'text', text: 'how do I use bash?' }] }],
    turn: 1,
    step: 1,
    signal,
  } as never, async () => ({ kind: 'enter', messages: [] }) as never)
}

describe('MemoryRecall subagent gating', () => {
  it('never recalls inside a subagent session (origin: subagent)', async () => {
    const { ctx, recorder, dispose } = await mount()
    const child = { session: { header: { cwd: '/work/repo', origin: 'subagent' } } } as unknown as Agent
    drivePreStep(ctx, child)
    // Give any (should-be-absent) recall a chance to run, then assert none.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(recorder.recentToolsSeen).toHaveLength(0)
    await dispose()
  })

  it('never recalls inside a delegated child (delegationDepth > 0)', async () => {
    const { ctx, recorder, dispose } = await mount()
    const child = { session: { header: { cwd: '/work/repo', delegationDepth: 1 } } } as unknown as Agent
    drivePreStep(ctx, child)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(recorder.recentToolsSeen).toHaveLength(0)
    await dispose()
  })

  it('still recalls for a top-level agent (no origin stamp)', async () => {
    const { ctx, recorder, dispose } = await mount()
    drivePreStep(ctx)
    await until(() => recorder.recentToolsSeen.length > 0, 'selector invocation')
    recorder.resolveLatest([])
    await dispose()
  })

  it('runs at most one in-flight recall per agent across overlapping pre-steps', async () => {
    const { ctx, recorder, dispose } = await mount()
    const agent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
    drivePreStep(ctx, agent)
    await until(() => recorder.recentToolsSeen.length > 0, 'first selector')
    // The first selection is still pending; a second pre-step must not pile up.
    drivePreStep(ctx, agent)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(recorder.recentToolsSeen).toHaveLength(1)
    recorder.resolveLatest([])
    await dispose()
  })
})

describe('MemoryRecall injected-source denylist and query dedupe (W3)', () => {
  it('pending messages consisting only of injected (memory-kind) texts never invoke the selector', async () => {
    const { ctx, recorder, dispose } = await mount()
    drivePreStep(ctx, undefined, [
      { content: [{ type: 'text', text: '## Memory: Bash\nbody' }], source: { kind: 'memory' } },
      { content: [{ type: 'text', text: '[observe] +1 internal' }], source: { kind: 'cc-subagent-children' } },
    ])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(recorder.recentToolsSeen).toHaveLength(0)
    await dispose()
  })

  it('a message without a source field is treated as user input and recalls', async () => {
    const { ctx, recorder, dispose } = await mount()
    drivePreStep(ctx, undefined, [{ content: [{ type: 'text', text: 'how do I use bash?' }] }])
    await until(() => recorder.recentToolsSeen.length > 0, 'selector invocation')
    recorder.resolveLatest([])
    await dispose()
  })

  it('the identical query text re-presented for the same agent skips without spawning', async () => {
    const { ctx, recorder, dispose } = await mount()
    const agent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
    const userMessages = [{ content: [{ type: 'text', text: 'how do I use bash?' }] }]
    drivePreStep(ctx, agent, userMessages)
    await until(() => recorder.recentToolsSeen.length > 0, 'first selector')
    recorder.resolveLatest([])
    // Same pending text again: no second selector spawn.
    drivePreStep(ctx, agent, userMessages)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(recorder.recentToolsSeen).toHaveLength(1)
    await dispose()
  })
})

describe('MemoryRecall recentTools suppression', () => {
  it('records tools from tools/post-execute and passes them to the selector', async () => {
    const { ctx, recall, recorder, dispose } = await mount()
    ctx.emit('tools/post-execute', { name: 'Bash' }, undefined, async () => ({}))
    ctx.emit('tools/post-execute', { name: 'Write' }, undefined, async () => ({}))

    drivePreStep(ctx)
    await until(() => recorder.recentToolsSeen.length > 0, 'selector invocation')
    expect(recorder.recentToolsSeen[0]).toEqual(['Bash', 'Write'])
    recorder.resolveLatest([])
    await dispose()
  })

  it('passes an empty tool list when no tools ran', async () => {
    const { ctx, recorder, dispose } = await mount()
    drivePreStep(ctx)
    await until(() => recorder.recentToolsSeen.length > 0, 'selector invocation')
    expect(recorder.recentToolsSeen[0]).toEqual([])
    recorder.resolveLatest([])
    await dispose()
  })

  it('dispose stops tracking tools from post-execute', async () => {
    const { ctx, recall, recorder, dispose } = await mount()
    recall.dispose()
    ctx.emit('tools/post-execute', { name: 'Bash' }, undefined, async () => ({}))

    drivePreStep(ctx)
    // Give any (should-be-absent) listener a chance to run, then assert none.
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(recorder.recentToolsSeen).toHaveLength(0)
    await dispose()
  })
})

describe('SubagentMemorySelector agentOptions forwarding', () => {
  const parent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
  const CANDIDATES = [
    { path: '/root/a.md', filename: 'a.md', description: 'A' },
    { path: '/root/b.md', filename: 'b.md', description: 'B' },
  ]

  it('forwards agentOptions onto the subagents.start request', async () => {
    const requests: Array<Record<string, unknown>> = []
    const ctx = new Context()
    ctx.provide('subagents' as never, {
      start: async (_name: string, request: Record<string, unknown>) => {
        requests.push(request)
        return {
          result: Promise.resolve({ stopReason: 'completed', structured: { files: [] } }),
        }
      },
    } as never)
    const selector = new SubagentMemorySelector(ctx, parent, 'fork', { provider: 'p', model: 'flash-1' })
    await selector.select('q', CANDIDATES, new AbortController().signal, [])
    expect(requests).toHaveLength(1)
    expect(requests[0]!['agentOptions']).toEqual({ provider: 'p', model: 'flash-1' })
  })
})

describe('memory apply() recall model stamping', () => {
  const agent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent

  /** Boot apply() with a recording subagents service and optional routes/config. */
  async function mountApply(options: {
    routes?: Record<string, { provider?: string; model?: string }>
    config?: Record<string, unknown>
  }): Promise<{ calls: Array<{ name: string; request: Record<string, unknown> }>; dispose: () => Promise<void> }> {
    const calls: Array<{ name: string; request: Record<string, unknown> }> = []
    const ctx = new Context()
    await ctx.plugin(FakeMemoryFs)
    const fs = ctx.fs as FakeMemoryFs
    fs.seed('/root/projects/work-repo/MEMORY.md', '# memory')
    fs.seed('/root/projects/work-repo/bash.md', topicBody('Bash reference documentation', 'reference'))
    ctx.provide('systemPrompt' as never, {
      section: (_def: unknown) => {},
    } as never)
    ctx.provide('subagents' as never, {
      start: async (name: string, request: Record<string, unknown>) => {
        calls.push({ name, request })
        return {
          result: Promise.resolve({ stopReason: 'completed', structured: { files: [] } }),
        }
      },
    } as never)
    if (options.routes !== undefined) {
      ctx.provide('ccModelRoutes' as never, {
        resolve: (model: string | undefined) => model === undefined ? undefined : options.routes?.[model.toLowerCase()],
      } as never)
    }
    applyMemory(ctx, { sectionEnabled: false, memoryHome: '/root', ...(options.config ?? {}) })
    drivePreStep(ctx, agent)
    await until(() => calls.length > 0, 'recall start')
    return { calls, dispose: async () => { await ctx.fiber.dispose() } }
  }

  it('defaults to no agentOptions (inherit) even when haiku is configured', async () => {
    const { calls, dispose } = await mountApply({
      routes: { haiku: { provider: 'orchestrix', model: 'flash-1' } },
    })
    expect(calls[0]!.request['agentOptions']).toBeUndefined()
    await dispose()
  })

  it('stamps resolve(haiku) when recallUseSmallFast is true and haiku is configured', async () => {
    const { calls, dispose } = await mountApply({
      routes: { haiku: { provider: 'orchestrix', model: 'flash-1' } },
      config: { recallUseSmallFast: true },
    })
    expect(calls[0]!.request['agentOptions']).toEqual({ provider: 'orchestrix', model: 'flash-1' })
    await dispose()
  })

  it('omits agentOptions when recallUseSmallFast is true but no ccModelRoutes is mounted', async () => {
    const { calls, dispose } = await mountApply({ config: { recallUseSmallFast: true } })
    expect(calls[0]!.request['agentOptions']).toBeUndefined()
    await dispose()
  })

  it('explicit recallAgentOptions wins and haiku is not consulted', async () => {
    const { calls, dispose } = await mountApply({
      routes: { haiku: { provider: 'orchestrix', model: 'flash-1' } },
      config: { recallUseSmallFast: true, recallAgentOptions: { model: 'explicit' } },
    })
    expect(calls[0]!.request['agentOptions']).toEqual({ model: 'explicit' })
    await dispose()
  })
})
