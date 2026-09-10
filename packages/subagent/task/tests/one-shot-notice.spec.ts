/**
 * Tests for the parent-scoped subagent-child notice (W2c, addendum
 * 2026-09-10): on agent/pre-step, ONLY the agent whose session id matches a
 * ledger row's parentId gets one folded observe-only line — delivered by
 * REWRITING the enter decision's message batch (NOT `agent.inject()`: a
 * durable pending inbox message re-opens turns forever, the phantom-loop
 * bug), with a dedicated MessageSourceMap kind. Zero emission otherwise;
 * internal-only activity yields a folded count, never per-child rows.
 * Dedupe is per agent OBJECT: the same fold text is appended once; a changed
 * fold appends again.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent, PreStepDecision, UserMessage } from '@deepseek-ai/dsh-agent'
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

const enter = (): PreStepDecision => ({ kind: 'enter', messages: [] })

/** Appended notice messages from the returned decision. */
function appendedTexts(decision: PreStepDecision): string[] {
  if (decision.kind !== 'enter') return []
  return decision.messages.flatMap((message: UserMessage) =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('subagent child notice', () => {
  it('case 1: a session with no active children returns the decision unmodified', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const ledger = createOneShotLedger({ bus, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    const listener = ctx.preStepListener()
    const { agent, injected } = fakeAgent('p1')
    const decision = enter()
    const returned = await listener?.({ agent }, async () => decision)
    expect(returned).toBe(decision)
    expect(injected).toEqual([])
    ledger.dispose()
  })

  it('case 2: an active non-internal child appends exactly one folded line to the matching parent via the enter decision', async () => {
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
    const returned = await ctx.preStepListener()?.({ agent: matching.agent }, async () => enter())
    expect(returned?.kind).toBe('enter')
    const texts = appendedTexts(returned!)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('researcher')
    // A second session's agent sees NOTHING.
    expect(appendedTexts(await ctx.preStepListener()?.({ agent: bystander.agent }, async () => enter()) ?? { kind: 'reject' })).toEqual([])
    ledger.dispose()
  })

  it('case 3: internal-only activity yields exactly `[observe] +N internal`', async () => {
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
    const returned = await ctx.preStepListener()?.({ agent: fakeAgent('p1').agent }, async () => enter())
    const texts = appendedTexts(returned!)
    expect(texts).toEqual(['[observe] +2 internal'])
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
    const decision = enter()
    expect(await ctx.preStepListener()?.({ agent: fakeAgent('p1').agent }, async () => decision)).toBe(decision)
    ledger.dispose()
  })

  it('case 5: children with unresolvable parentage are never injected into any session', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const ledger = createOneShotLedger({ bus, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    bus.emit('subagent/start', { runId: 'r1', id: 'orphan', provider: 'fork' })
    const decision = enter()
    expect(await ctx.preStepListener()?.({ agent: fakeAgent('p1').agent }, async () => decision)).toBe(decision)
    ledger.dispose()
  })

  it('case 6: the appended message is a user message with the cc-subagent-children source kind; agent.inject is never called', async () => {
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
    const { agent, injected } = fakeAgent('p1')
    const injectSpy = vi.spyOn(agent as unknown as { inject: unknown }, 'inject')
    const returned = await ctx.preStepListener()?.({ agent }, async () => enter())
    const message = (returned as { messages: UserMessage[] }).messages[0]!
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: expect.stringContaining('researcher') }])
    expect(message.source).toEqual({ kind: 'cc-subagent-children' })
    expect(injectSpy).not.toHaveBeenCalled()
    expect(injected).toEqual([])
    ledger.dispose()
  })

  it('case 7: an identical fold across two consecutive pre-steps appends once; a changed set appends again', async () => {
    const bus = new FakeBus()
    const ctx = new FakeCtx()
    const agents = {
      get(id: string) {
        return id === 'c1'
          ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'researcher' } }] } }
          : id === 'c2'
            ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'writer' } }] } }
            : undefined
      },
    }
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    mountSubagentChildNotice(ctx as never, ledger)
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'spawn' })
    const { agent } = fakeAgent('p1')
    const first = appendedTexts((await ctx.preStepListener()?.({ agent }, async () => enter()))!)
    expect(first).toHaveLength(1)
    // Same active set: no duplicate append.
    expect(appendedTexts((await ctx.preStepListener()?.({ agent }, async () => enter()))!)).toHaveLength(0)
    // A second child appears: the fold changes, so append again.
    bus.emit('subagent/start', { runId: 'r2', id: 'c2', provider: 'spawn' })
    const third = appendedTexts((await ctx.preStepListener()?.({ agent }, async () => enter()))!)
    expect(third).toHaveLength(1)
    expect(third[0]).toContain('writer')
    ledger.dispose()
  })

  it('case 8: a non-enter decision passes through untouched', async () => {
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
    const { agent } = fakeAgent('p1')
    const reject: PreStepDecision = { kind: 'reject' }
    expect(await ctx.preStepListener()?.({ agent }, async () => reject)).toBe(reject)
    ledger.dispose()
  })
})
