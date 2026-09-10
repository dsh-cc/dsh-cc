/**
 * Tests for the parent-scoped subagent-child notice (W2c): on agent/pre-step,
 * ONLY the agent whose session id matches a ledger row's parentId gets one
 * folded observe-only line via agent.inject + createUserMessage with a
 * dedicated MessageSourceMap kind. Zero emission otherwise; internal-only
 * activity yields a folded count, never per-child rows.
 */
import { describe, expect, it } from 'vitest'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountSubagentChildNotice } from '../src/one-shot-notice.ts'
import { createOneShotLedger } from '../src/one-shot-ledger.ts'

class FakeBus {
  private readonly listeners = new Map<string, { fn: (info: Record<string, unknown>) => void; disposed: boolean }[]>()
  on(event: string, fn: (info: Record<string, unknown>) => void): () => void {
    const record = { fn, disposed: false }
    const list = this.listeners.get(event) ?? []
    list.push(record)
    this.listeners.set(event, list)
    return () => {
      if (record.disposed) return
      record.disposed = true
    }
  }

  emit(event: string, info: Record<string, unknown>): void {
    for (const record of this.listeners.get(event) ?? []) {
      if (!record.disposed) record.fn(info)
    }
  }
}

interface CtorOpts { prepend?: boolean }

/** Fake cordis ctx capturing waterfall listeners. */
class FakeCtx {
  readonly listeners = new Map<string, {
    fn: (info: unknown, next: (decision: PreStepDecision) => Promise<PreStepDecision>) => Promise<PreStepDecision>
    disposed: boolean
    opts: unknown
  }[]>()

  on(event: string, fn: never, opts?: unknown): () => void {
    const record = { fn, disposed: false, opts }
    const list = this.listeners.get(event) ?? []
    list.push(record)
    this.listeners.set(event, list)
    return () => {
      record.disposed = true
    }
  }

  preStepListener():
    | ((info: unknown, next: (decision: PreStepDecision) => Promise<PreStepDecision>) => Promise<PreStepDecision>)
    | undefined {
    return this.listeners.get('agent/pre-step')?.find(r => !r.disposed)?.fn
  }
}

function fakeAgent(sessionId: string): { agent: Agent; injected: unknown[] } {
  const injected: unknown[] = []
  const agent = {
    session: { id: sessionId },
    inject(message: unknown) {
      injected.push(message)
    },
  } as unknown as Agent
  return { agent, injected }
}

const enter: PreStepDecision = { kind: 'enter', messages: [] }

describe('subagent child notice', () => {
  it('case 1: a session with no active children emits nothing', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const ledger = createOneShotLedger({ bus, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    const listener = ctx.preStepListener()
    const { agent, injected } = fakeAgent('p1')
    await listener?.({ agent }, async () => enter)
    expect(injected).toEqual([])
    ledger.dispose()
  })

  it('case 2: an active non-internal child yields exactly one folded line, only to the matching parent', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const agents = {
      get(id: string) {
        return id === 'c1'
          ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'researcher' } }] } }
          : undefined
      },
    }
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'spawn' })
    const matching = fakeAgent('p1')
    const bystander = fakeAgent('p2')
    await ctx.preStepListener()?.({ agent: matching.agent }, async () => enter)
    await ctx.preStepListener()?.({ agent: bystander.agent }, async () => enter)
    expect(matching.injected).toHaveLength(1)
    const message = matching.injected[0] as { role: string; content: { type: string; text: string }[]; source: { kind: string } }
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: expect.stringContaining('researcher') }])
    expect(message.source).toEqual({ kind: 'cc-subagent-children' })
    // A second session's agent sees NOTHING.
    expect(bystander.injected).toEqual([])
    ledger.dispose()
  })

  it('case 3: internal-only activity yields a folded count, never per-child rows', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const agents = {
      get(id: string) {
        return id === 'm1'
          ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'one-shot', label: 'memory-recall' } }] } }
          : id === 'm2'
            ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'one-shot', label: 'hook-prompt' } }] } }
            : undefined
      },
    }
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    bus.emit('subagent/start', { runId: 'r1', id: 'm1', provider: 'fork' })
    bus.emit('subagent/start', { runId: 'r2', id: 'm2', provider: 'fork' })
    const { agent, injected } = fakeAgent('p1')
    await ctx.preStepListener()?.({ agent }, async () => enter)
    expect(injected).toHaveLength(1)
    const text = (injected[0] as { content: { text: string }[] }).content[0].text
    expect(text).toContain('2')
    expect(text).not.toContain('memory-recall')
    expect(text).not.toContain('hook-prompt')
    ledger.dispose()
  })

  it('case 4: a settled child stops being reported', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const agents = {
      get(id: string) {
        return id === 'c1'
          ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'one-shot', label: 'work' } }] } }
          : undefined
      },
    }
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'fork' })
    bus.emit('subagent/end', { runId: 'r1', id: 'c1', provider: 'fork', stopReason: 'completed' })
    const { agent, injected } = fakeAgent('p1')
    await ctx.preStepListener()?.({ agent }, async () => enter)
    expect(injected).toEqual([])
    ledger.dispose()
  })

  it('case 5: children with unresolvable parentage are never injected into any session', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const ledger = createOneShotLedger({ bus, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    bus.emit('subagent/start', { runId: 'r1', id: 'orphan', provider: 'fork' })
    const { agent, injected } = fakeAgent('p1')
    await ctx.preStepListener()?.({ agent }, async () => enter)
    expect(injected).toEqual([])
    ledger.dispose()
  })
})
