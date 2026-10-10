/**
 * M2 escalation tests (design doc §5.3): the `tools/pre-execute` waterfall
 * (`prepend:true`), the digest projection, clear/check rules, attempt-semantics
 * bounded escalation, the resolution seams, and the approval-absent fallback.
 * Each test mounts ONE rig (one shared state) and records the ambiguous
 * outcome through its own post-execute listener.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { digestKey } from '../src/digest.ts'
import { bashExec, contextsOf, enable, failureResult, fakeAgent, promotedResult, rig, successResult, tempHome, type Rig } from './rig.ts'

const nextAllow = async (): Promise<unknown> => ({ kind: 'allow' }) as unknown
const nextAsk = (reason: string): (() => Promise<unknown>) => async (): Promise<unknown> => ({ kind: 'ask', reason }) as unknown

/** Record an ambiguous outcome for `command` via the rig's post-execute listener. */
async function record(r: Rig, command: string, result: ToolExecutionResult, overrides: Record<string, unknown> = {}): Promise<void> {
  await r.post(bashExec(command, overrides), result, async () => ({ kind: 'accept' }))
}

describe('M2 escalation (tools/pre-execute, prepend:true)', () => {
  it('ambiguous outcome → same-effect call (reworded description, different timeoutMs) ⇒ ask with reason', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'git commit -m x', failureResult('fatal: something'))
    const decision = await r.pre(bashExec('git commit -m x', { description: 'try again', timeoutMs: 999, callId: 'c2' }), nextAllow)
    expect((decision as { kind: string }).kind).toBe('ask')
    expect((decision as { reason: string }).reason).toContain('identical retry of bash after git-mutation')
  })

  it('reworded description/different timeoutMs ⇒ SAME key (digest projection) — reason names tool+class+time', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const decision = await r.pre(bashExec('pnpm install', { description: 'retry the install', timeoutMs: 5000 }), nextAllow)
    expect((decision as { reason: string }).reason).toMatch(/^identical retry of bash after pkg-install at /)
  })

  it('retry after designated check (git status) ⇒ harder ask naming the check', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'git push', failureResult('remote hung up'))
    await r.post(bashExec('git status'), successResult(), async () => ({ kind: 'accept' }))
    const decision = await r.pre(bashExec('git push', { description: 'push again' }), nextAllow)
    expect((decision as { reason: string }).reason).toContain('a check (git status,')
    expect((decision as { reason: string }).reason).toContain('confirm the effect state before re-running')
  })

  it('write-partial retry after a successful read of the same path ⇒ harder ask naming the read', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    const editExec = { name: 'edit', arguments: { file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' }, agent: fakeAgent() } as unknown as ToolExecution
    await r.post(editExec, failureResult('EIO: mid-write failure'), async () => ({ kind: 'accept' }))
    await r.post({ name: 'read', arguments: { file_path: '/proj/a.ts' }, agent: fakeAgent() } as unknown as ToolExecution, successResult(), async () => ({ kind: 'accept' }))
    const decision = await r.pre(editExec, nextAllow)
    expect((decision as { reason: string }).reason).toContain('a check (read /proj/a.ts,')
  })

  it('mcp__ failure retry ⇒ passthrough (M1-only class, never set into the map)', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    const mcpExec = { name: 'mcp__srv__write', arguments: { q: 1 }, agent: fakeAgent() } as unknown as ToolExecution
    await r.post(mcpExec, failureResult('bridge dropped'), async () => ({ kind: 'accept' }))
    const decision = await r.pre(mcpExec, nextAllow)
    expect(decision).toEqual({ kind: 'allow' }) // delegated, not ours
    expect(r.state.sessions.get('s1')?.size ?? 0).toBe(0)
  })

  it('different-effect args ⇒ passthrough (different digest)', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const decision = await r.pre(bashExec('pnpm install lodash'), nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('same-digest clean success ⇒ fully cleared, passthrough', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    await r.post(bashExec('pnpm install'), successResult(), async () => ({ kind: 'accept' }))
    const decision = await r.pre(bashExec('pnpm install'), nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(r.state.sessions.get('s1')?.has(digestKey('bash', { command: 'pnpm install' }))).toBe(false)
  })

  it('same-digest success that re-matches ANY class ⇒ NOT cleared', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    await r.post(bashExec('pnpm install'), promotedResult(), async () => ({ kind: 'accept' }))
    const decision = await r.pre(bashExec('pnpm install'), nextAllow)
    expect((decision as { reason?: string }).reason).toBeDefined()
    expect(r.state.sessions.get('s1')?.has(digestKey('bash', { command: 'pnpm install' }))).toBe(true)
  })

  it('expiry ⇒ passthrough', async () => {
    vi.useFakeTimers()
    try {
      const home = tempHome()
      enable(home, { enabled: true, 'expire-minutes': 10 })
      const r = rig({ home, approval: {} })
      await record(r, 'pnpm install', failureResult('network dropped'))
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000))
      const decision = await r.pre(bashExec('pnpm install'), nextAllow)
      expect(decision).toEqual({ kind: 'allow' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalated entry never reset by a new outcome', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const exec = bashExec('pnpm install', { callId: 'c-owner' })
    await r.pre(exec, nextAllow) // returns ask; reservation reserved to c-owner
    await r.execute(bashExec('pnpm install', { callId: 'c-owner' }), async () => successResult()) // consume
    expect(r.state.sessions.get('s1')?.get(digestKey('bash', { command: 'pnpm install' }))?.escalated).toBe(true)
    await r.post(bashExec('pnpm install'), failureResult('network dropped'), async () => ({ kind: 'accept' }))
    const entry = r.state.sessions.get('s1')?.get(digestKey('bash', { command: 'pnpm install' }))
    expect(entry?.escalated).toBe(true)
    // and an identical retry passes through (no second ask)
    const decision = await r.pre(exec, nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('sibling race: two concurrent identical ⇒ exactly one ask, sibling denied with reason (not executed)', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    let release: (() => void) | undefined
    const slowNext = async (): Promise<unknown> => {
      await new Promise<void>((resolve) => { release = resolve })
      return { kind: 'allow' } as unknown
    }
    const first = r.pre(bashExec('pnpm install', { callId: 'c1' }), slowNext)
    const second = await r.pre(bashExec('pnpm install', { callId: 'c2' }), nextAllow)
    expect(second).toEqual({ kind: 'deny', reason: 'identical call is already awaiting confirmation' })
    release?.()
    const firstDecision = await first
    expect((firstDecision as { kind: string }).kind).toBe('ask')
  })

  it('rejection (terminal result without dispatch) does not consume ⇒ next identical retry asks again', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const exec = bashExec('pnpm install', { callId: 'c1' })
    await r.pre(exec, nextAllow)
    // terminal result WITHOUT dispatch evidence: bit released, entry un-escalated
    await r.result(exec, failureResult('denied by core'))
    const entry = r.state.sessions.get('s1')?.get(digestKey('bash', { command: 'pnpm install' }))
    expect(entry?.escalated).toBeUndefined()
    expect(entry?.askInFlight).toBeUndefined()
    // the next identical retry asks again
    const decision = await r.pre(exec, nextAllow)
    expect((decision as { kind: string }).kind).toBe('ask')
  })

  it('dispatch observed ⇒ latch consumed ⇒ next passes through', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const exec = bashExec('pnpm install', { callId: 'c1' })
    await r.pre(exec, nextAllow)
    await r.execute(bashExec('pnpm install', { callId: 'c1' }), async () => successResult())
    const entry = r.state.sessions.get('s1')?.get(digestKey('bash', { command: 'pnpm install' }))
    expect(entry?.escalated).toBe(true)
    const decision = await r.pre(exec, nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('approval absent + downstream allow ⇒ {kind:allow} + inject fallback with our source kind', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home }) // no approval service
    await record(r, 'pnpm install', failureResult('network dropped'))
    const agent = fakeAgent()
    const decision = await r.pre(bashExec('pnpm install', { agent, callId: 'c1' }), nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(agent.inject).toHaveBeenCalledTimes(1)
    const message = agent.inject.mock.calls[0]![0] as { content: { text: string }[]; source?: { kind?: string } }
    expect(message.source?.kind).toBe('retry-attendant')
  })

  it('approval absent + downstream ask ⇒ downstream ask preserved (no allow-override)', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const downstreamAsk = { kind: 'ask', reason: 'permission required' }
    const decision = await r.pre(bashExec('pnpm install', { callId: 'c1' }), async () => downstreamAsk)
    expect(decision).toEqual(downstreamAsk)
  })

  it('approval present + downstream ask ⇒ combined reason', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const decision = await r.pre(bashExec('pnpm install', { callId: 'c1' }), nextAsk('permission required'))
    expect((decision as { reason: string }).reason).toMatch(/\(also: permission required\)$/)
  })

  it('agent-less execution ⇒ passthrough with no state keying', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, approval: {} })
    const exec = { name: 'bash', arguments: { command: 'pnpm install' } } as unknown as ToolExecution
    const decision = await r.pre(exec, nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(r.state.sessions.size).toBe(0)
  })

  it('pre-execute inject vs post-result FIFO ordering pin: result, then inject, then additionalContexts', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home })
    await record(r, 'pnpm install', failureResult('network dropped'))
    const inbox: string[] = []
    const agent = fakeAgent()
    agent.inject.mockImplementation((message: { content: { text: string }[] }) => { inbox.push(message.content[0]!.text.slice(0, 20)) })
    // the loop's order: tool result is already queued, pre-execute of call N injects, post-execute appends.
    inbox.push('tool-result')
    await r.pre(bashExec('pnpm install', { agent, callId: 'c1' }), nextAllow)
    const decision = await r.post(bashExec('pnpm build'), promotedResult(), async () => ({ kind: 'accept', additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'ctx' }] }] }))
    for (const context of contextsOf(decision)) inbox.push(context.content![0]!.text)
    expect(inbox[0]).toBe('tool-result')
    expect(inbox[1]).toContain('[retry-attendant]')
    expect(inbox.filter((entry) => entry.includes('retry-attendant'))).toHaveLength(2)
  })

  it('forced internal throw in pre-execute ⇒ delegation passthrough + debug log', async () => {
    const home = tempHome()
    enable(home)
    const r = rig({ home, stateFor: (): never => { throw new Error('boom') } })
    const decision = await r.pre(bashExec('pnpm install'), nextAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(r.ctx.logger.debug).toHaveBeenCalledWith(expect.stringContaining('retry-attendant: pre-execute degraded to passthrough'))
  })
})
