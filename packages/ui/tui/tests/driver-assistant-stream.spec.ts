import { describe, expect, it, vi } from 'vitest'
import { attachSessionEvents } from '@dsh-cc/tui/harness/driver-agent.ts'
import { createInitialState, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * The `agent/assistant-stream` listener folds frames only for the CURRENT
 * agent's session; foreign-session frames and malformed payloads are dropped
 * without throwing.
 */

type Handler = (payload: unknown) => void

function makeRt(sessionId: string) {
  let state: TuiState = createInitialState()
  const handlers = new Set<Handler>()
  let streamHandler: Handler | undefined
  attachSessionEvents({
    emit(next: TuiState) { state = next },
    state: () => state,
    current: { handle: {}, agent: { session: { id: 's-current' } } },
    ctx: {
      on: (event: string, handler: Handler) => {
        handlers.add(handler)
        if (event === 'agent/assistant-stream') streamHandler = handler
        return () => { handlers.delete(handler) }
      },
    },
    liveMode: () => 'default',
    presenters: undefined,
    flushQueue: vi.fn(),
    showNotice: vi.fn(),
  } as never)
  const fire = (payload: unknown): void => {
    for (const handler of handlers) handler(payload)
  }
  const fireStream = (payload: unknown): void => {
    if (streamHandler !== undefined) streamHandler(payload)
  }
  return { fire: fireStream, state: () => state }
}

const START = { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }

describe('driver assistant-stream listener', () => {
  it('folds frames for the current session, ignores foreign sessions', () => {
    const { fire, state } = makeRt('s-current')
    fire({ agent: { session: { id: 's-current' } }, frame: START })
    fire({ agent: { session: { id: 's-current' } }, frame: { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'live' } } })
    expect(state().rows).toContainEqual({ kind: 'assistant', text: 'live', streamKey: '1:1:assistant' })

    fire({ agent: { session: { id: 's-other' } }, frame: { type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: 'X' } } })
    expect(state().rows).toContainEqual({ kind: 'assistant', text: 'live', streamKey: '1:1:assistant' })
  })

  it('malformed payloads are dropped without throwing', () => {
    const { fire, state } = makeRt('s-current')
    expect(() => fire(undefined)).not.toThrow()
    expect(() => fire({ agent: undefined, frame: undefined })).not.toThrow()
    expect(() => fire({ agent: { session: { id: 's-current' } }, frame: { type: 'bogus' } })).not.toThrow()
    expect(state().rows).toEqual([])
  })
})
