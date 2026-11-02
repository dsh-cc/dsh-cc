import { describe, expect, it } from 'vitest'
import { createLateInjectGuard } from '../src/late-inject.ts'

type Handler = (p: never) => void

/**
 * Fake ctx that routes handlers by EVENT NAME: `agent/status` and
 * `agent/inbox/claimed` fire independently, so the running-but-unclaimed case
 * (the pre-fix injection regime) is expressible.
 */
function fakeCtx() {
  const handlers: Record<string, Handler[]> = { 'agent/status': [], 'agent/inbox/claimed': [] }
  const warnings: string[] = []
  const ctx = {
    on: (name: string, h: Handler) => { (handlers[name] ??= []).push(h) },
    logger: { warn: (m: string) => { warnings.push(m) } },
  }
  return {
    ctx,
    warnings,
    status: (agent: unknown, status: string) =>
      handlers['agent/status']!.forEach(h => (h as unknown as (p: { agent: unknown; status: string }) => void)({ agent, status })),
    claimed: (agent: unknown) =>
      handlers['agent/inbox/claimed']!.forEach(h => (h as unknown as (p: { agent: unknown }) => void)({ agent })),
  }
}

function fakeAgent(id: string) {
  const injected: unknown[] = []
  return { id, status: 'idle' as 'idle' | 'running', injected, inject(m: unknown) { injected.push(m) } }
}

const IDLE_WARN = 'finished its turn; dropped (an idle child cannot claim injected context'
const CLAIMED_WARN = 'claimed its first input; dropped (it can no longer precede the work'

describe('late detached-hook context guard', () => {
  const msg = { role: 'user', content: [] }

  it('injects for a running live child that has claimed nothing (context precedes the work)', () => {
    const { ctx, status } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set(['child']) })
    const child = fakeAgent('child')
    status(child, 'running')
    child.status = 'running'
    expect(guard.stranded(child as never)).toBe(false)
    guard.inject(child as never, msg as never, 'SubagentStart')
    expect(child.injected).toHaveLength(1)
  })

  it('drops context for a running live child after its first inbox claim (would re-open the turn)', () => {
    const { ctx, warnings, status, claimed } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set(['child']) })
    const child = fakeAgent('child')
    status(child, 'running')
    child.status = 'running'
    claimed(child)
    expect(guard.stranded(child as never)).toBe(true)
    guard.inject(child as never, msg as never, 'SessionStart')
    expect(child.injected).toHaveLength(0)
    expect(warnings.join('\n')).toContain(CLAIMED_WARN)
    expect(warnings.join('\n')).not.toContain(IDLE_WARN)
  })

  it('drops context for a live child that already ran and is idle (would strand settlement)', () => {
    const { ctx, warnings, status, claimed } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set(['child']) })
    const child = fakeAgent('child')
    claimed(child)
    status(child, 'running')
    status(child, 'idle')
    expect(guard.stranded(child as never)).toBe(true)
    guard.inject(child as never, msg as never, 'SessionStart')
    expect(child.injected).toHaveLength(0)
    expect(warnings.join('\n')).toContain(IDLE_WARN)
    expect(warnings.join('\n')).not.toContain(CLAIMED_WARN)
  })

  it('injects for a live child that has not run yet (first pre-step claims it)', () => {
    const { ctx } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set(['child']) })
    const child = fakeAgent('child')
    expect(guard.stranded(child as never)).toBe(false)
    guard.inject(child as never, msg as never, 'SessionStart')
    expect(child.injected).toHaveLength(1)
  })

  it('injects for an idle root agent that already ran (its next user turn claims it)', () => {
    const { ctx, status, claimed } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set() })
    const root = fakeAgent('root')
    claimed(root)
    status(root, 'running')
    status(root, 'idle')
    expect(guard.stranded(root as never)).toBe(false)
    guard.inject(root as never, msg as never, 'SessionStart')
    expect(root.injected).toHaveLength(1)
  })
})
