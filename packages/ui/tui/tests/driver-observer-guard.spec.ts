import { describe, expect, it, vi } from 'vitest'
import { attachSessionEvents } from '@dsh-cc/tui/harness/driver-agent.ts'
import { createInitialState, enqueue, setBusy, setTurnActive, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * W1-B: attachSessionEvents observer resilience. A throwing fold/presenter or
 * bookkeeping step is caught: a visible notice with the event seq/type is
 * surfaced, later events still fold, and a poisoned `turn/end` still clears
 * busy + the turn anchor and drains the outbox (the incident pin).
 */

type Handler = (session: unknown, event: unknown) => void

function makeRt(overrides: {
  state?: TuiState
  poisonNextEmit?: boolean
  flushQueue?: () => void
} = {}) {
  let state = overrides.state ?? createInitialState()
  let poisonNextEmit = overrides.poisonNextEmit ?? false
  const handlers = new Set<Handler>()
  const agentSession = { id: 's1' }
  const showNotice = vi.fn()
  const flushQueue = overrides.flushQueue ?? vi.fn()
  const rt: Record<string, unknown> = {
    emit(next: unknown) {
      if (poisonNextEmit) { poisonNextEmit = false; throw new Error('poison emit') }
      state = next as TuiState
    },
    state: () => state,
    current: { handle: {}, agent: { session: agentSession } },
    ctx: {
      on: (_event: string, handler: Handler) => {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      },
    },
    liveMode: () => 'default',
    presenters: {
      presentCall: () => { throw new Error('poisoned presenter') },
      presentResult: () => undefined,
    },
    flushQueue,
    showNotice,
  }
  attachSessionEvents(rt as never)
  const fire = (event: unknown): void => {
    for (const handler of handlers) handler(agentSession, event)
  }
  return { fire, state: () => state, showNotice, flushQueue }
}

describe('attachSessionEvents observer guard (W1-B)', () => {
  it('a poisoned fold does not veto later events; notice carries seq and type', () => {
    const { fire, state, showNotice } = makeRt()

    expect(() => fire({ type: 'tool/call', seq: 7, data: { name: 'Bash', args: '{}' } })).not.toThrow()
    expect(showNotice).toHaveBeenCalledTimes(1)
    expect(showNotice.mock.calls[0]?.[0]).toContain('7')
    expect(showNotice.mock.calls[0]?.[0]).toContain('tool/call')

    // A subsequent good event still folds: turn/start anchors the working line.
    fire({ type: 'turn/start', seq: 8, data: {} })
    expect(state().busy).toBe(true)
    expect(state().turn).toBeDefined()
  })

  it('incident pin: turn/start then poisoned turn/end → busy cleared, turn cleared, queue flushed', () => {
    let state = setTurnActive(setBusy(createInitialState(), true), { startedAt: 1 })
    state = enqueue(state, 'queued chip')
    // The flush (the turn/end bookkeeping that follows the fold) throws once,
    // so without the guard the callback dies mid-way and busy stays latched.
    let poisoned = true
    const flushQueue = vi.fn(() => {
      if (poisoned) { poisoned = false; throw new Error('poison flush') }
    })
    const { fire, state: read, showNotice } = makeRt({ state, flushQueue })

    expect(() => fire({ type: 'turn/end', seq: 9, data: {} })).not.toThrow()

    expect(read().busy).toBe(false)
    expect(read().turn).toBeUndefined()
    // The poisoned first flush is retried by the catch path; without the
    // guard it is invoked exactly once and the throw escapes the observer.
    expect(flushQueue).toHaveBeenCalledTimes(2)
    expect(showNotice).toHaveBeenCalledTimes(1)
    expect(showNotice.mock.calls[0]?.[0]).toContain('9')
    expect(showNotice.mock.calls[0]?.[0]).toContain('turn/end')
  })
})
