import { describe, expect, it } from 'vitest'
import { createLateInjectGuard } from '../src/late-inject.ts'

type StatusHandler = (p: { agent: unknown; status: string }) => void

function fakeCtx() {
  const handlers: StatusHandler[] = []
  const warnings: string[] = []
  const ctx = {
    on: (_name: string, h: StatusHandler) => { handlers.push(h) },
    logger: { warn: (m: string) => { warnings.push(m) } },
  }
  return { ctx, warnings, status: (agent: unknown, status: string) => handlers.forEach(h => h({ agent, status })) }
}

function fakeAgent(id: string) {
  const injected: unknown[] = []
  return { id, status: 'idle' as 'idle' | 'running', injected, inject(m: unknown) { injected.push(m) } }
}

describe('late detached-hook context guard', () => {
  const msg = { role: 'user', content: [] }

  it('drops context for a live child that already ran and is idle (would strand settlement)', () => {
    const { ctx, warnings, status } = fakeCtx()
    const live = new Set(['child'])
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: live })
    const child = fakeAgent('child')
    status(child, 'running')
    status(child, 'idle')
    expect(guard.stranded(child as never)).toBe(true)
    guard.inject(child as never, msg as never, 'SessionStart')
    expect(child.injected).toHaveLength(0)
    expect(warnings.join('\n')).toContain('SessionStart hook context resolved after subagent child finished its turn')
  })

  it('injects for a live child that has not run yet (first pre-step claims it)', () => {
    const { ctx } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set(['child']) })
    const child = fakeAgent('child')
    guard.inject(child as never, msg as never, 'SessionStart')
    expect(child.injected).toHaveLength(1)
  })

  it('injects for a running live child (nearest step boundary claims it)', () => {
    const { ctx, status } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set(['child']) })
    const child = fakeAgent('child')
    status(child, 'running')
    child.status = 'running'
    guard.inject(child as never, msg as never, 'SubagentStart')
    expect(child.injected).toHaveLength(1)
  })

  it('injects for an idle root agent that already ran (its next user turn claims it)', () => {
    const { ctx, status } = fakeCtx()
    const guard = createLateInjectGuard({ ctx: ctx as never, liveSubagentIds: new Set() })
    const root = fakeAgent('root')
    status(root, 'running')
    status(root, 'idle')
    guard.inject(root as never, msg as never, 'SessionStart')
    expect(root.injected).toHaveLength(1)
  })
})
