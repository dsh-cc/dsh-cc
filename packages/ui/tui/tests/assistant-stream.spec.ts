import { describe, expect, it } from 'vitest'
import { applyStreamFrame, foldSettledMessage } from '@dsh-cc/tui/assistant-stream.ts'
import { applySessionEvent, type SessionEventLike } from '@dsh-cc/tui/transcript.ts'
import { createInitialState, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * Assistant-stream folding: live `agent/assistant-stream` frames paint scratch
 * reply/thinking rows; the durable `assistant/message` settle fold replaces
 * them (or backfills from a cold replay).
 */

const START = { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 2 } as const

function chunk(attemptId: string, revision: number, chunkBody: unknown) {
  return { type: 'chunk', attemptId, revision, index: revision, time: 1, chunk: chunkBody }
}

function text(...deltas: string[]) {
  return deltas.map((text, i) => chunk('a1', 2 + i, { type: 'text-delta', index: 1, text }))
}

function reasoning(...deltas: string[]) {
  return deltas.map((text, i) => chunk('a1', 20 + i, { type: 'reasoning-delta', index: 0, text }))
}

function frame(state: TuiState, frames: readonly unknown[]): TuiState {
  return frames.reduce((acc, frame) => applyStreamFrame(acc, frame as never), state)
}

function settled(state: TuiState, event: SessionEventLike): TuiState {
  return applySessionEvent(state, event)
}

describe('assistant-stream live frames', () => {
  it('live text/reasoning deltas upsert one scratch row per (turn, step, kind)', () => {
    let state = frame(createInitialState(), [START, ...text('Hel', 'lo'), ...reasoning('th'), ...text('!')])
    const keys = state.rows.filter(row => row.kind === 'assistant' || row.kind === 'thinking')
    expect(keys).toHaveLength(2)
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'Hello!', streamKey: '1:2:assistant' })
    expect(state.rows).toContainEqual({ kind: 'thinking', text: 'th', streamKey: '1:2:thinking' })
    expect(state.rows.filter(row => row.kind === 'assistant')).toHaveLength(1)
  })

  it('a retry start resets scratch; abandoned end clears the residue', () => {
    let state = frame(createInitialState(), [START, ...text('first attempt')])
    state = frame(state, [{ type: 'end', attemptId: 'a1', revision: 9, index: 1, outcome: { kind: 'abandoned' } }])
    expect(state.rows.filter(row => row.kind === 'assistant')).toEqual([])
    // Attempt two paints clean after a fresh start.
    state = frame(state, [{ type: 'start', attemptId: 'a2', revision: 1, turn: 1, step: 2 }])
    state = frame(state, text('second').map(f => ({ ...f, attemptId: 'a2' })))
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'second', streamKey: '1:2:assistant' })
    // Chunks for an unknown attempt are ignored.
    state = applyStreamFrame(state, chunk('a1', 99, { type: 'text-delta', index: 1, text: 'ghost' }) as never)
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'second', streamKey: '1:2:assistant' })
  })
})

describe('assistant-stream settle fold', () => {
  // Oracle-shaped durable stream: packed runs + raw chunk records.
  const stream = [
    { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1, 0], texts: ['thin', 'king'] },
    { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } } },
    { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
    { type: 'text-chunks', time0: 3, index: 1, dt: [1, 1], texts: ['Hel', 'lo'] },
    { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } } },
  ]

  it('settle replaces live scratch rows with seq-tagged finals (no duplicates)', () => {
    let state = frame(createInitialState(), [START, ...text('Hel'), ...reasoning('thi')])
    state = settled(state, { type: 'assistant/message', seq: 7, data: { turn: 1, step: 2, message: {}, stream } })
    expect(state.rows.filter(row => row.kind === 'assistant' || row.kind === 'thinking')).toEqual([
      { kind: 'thinking', text: 'thinking', seq: 7 },
      { kind: 'assistant', text: 'Hello', seq: 7 },
    ])
    expect(state.busy).toBe(false)
  })

  it('settle from a cold state (replay, no live frames) still produces rows', () => {
    const state = settled(createInitialState(), { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: {}, stream } })
    expect(state.rows).toContainEqual({ kind: 'thinking', text: 'thinking', seq: 3 })
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'Hello', seq: 3 })
  })

  it('settle falls back to legacy message.content blocks when the stream is absent', () => {
    const state = settled(createInitialState(), {
      type: 'assistant/message',
      seq: 4,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'reasoning', text: 'why' }, { type: 'text', text: 'answer' }] },
      },
    })
    expect(state.rows).toContainEqual({ kind: 'thinking', text: 'why', seq: 4 })
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'answer', seq: 4 })
  })

  it('an interrupted settle paints the partial text (flag does not suppress)', () => {
    const state = settled(createInitialState(), {
      type: 'assistant/message',
      seq: 8,
      data: {
        turn: 1,
        step: 4,
        interrupted: true,
        message: {},
        // Partial stream: one packed run, no block-end, no finish.
        stream: [{ type: 'text-chunks', time0: 1, index: 1, dt: [1, 1], texts: ['par', 'tial'] }],
      },
    })
    expect(state.rows).toEqual([{ kind: 'assistant', text: 'partial', seq: 8 }])
  })

  it('settle emits rows in first-block order when text precedes reasoning', () => {
    const stream = [
      { type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'first' } } },
      { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'later' } } },
    ]
    const state = settled(createInitialState(), { type: 'assistant/message', seq: 9, data: { turn: 1, step: 1, message: {}, stream } })
    expect(state.rows.map(row => row.kind)).toEqual(['assistant', 'thinking'])
  })

  it('a reasoning/tool-call-only step produces no empty reply row', () => {
    const state = settled(createInitialState(), {
      type: 'assistant/message',
      seq: 5,
      data: { turn: 1, step: 3, message: { content: [{ type: 'reasoning', text: 'plan' }] } },
    })
    expect(state.rows).toEqual([{ kind: 'thinking', text: 'plan', seq: 5 }])
    expect(state.rows.some(row => row.kind === 'assistant' && row.text === '')).toBe(false)
  })

  it('a seq inside a shadowed compaction span inserts nothing', () => {
    let state = settled(createInitialState(), {
      type: 'user/message',
      seq: 1,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 },
      data: { content: [{ type: 'text', text: 'compact' }], source: { kind: 'plugin', plugin: 'compact' } },
    })
    expect(state.shadowedThrough).toBe(9)
    state = settled(state, { type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, message: {}, stream } })
    expect(state.rows.filter(row => row.kind === 'assistant' || row.kind === 'thinking')).toEqual([])
  })

  it('durable assistant/attempt events produce no rows', () => {
    const state = settled(createInitialState(), { type: 'assistant/attempt', seq: 6, data: { turn: 1, step: 1 } })
    expect(state.rows).toEqual([])
  })
})
