import { describe, expect, it } from 'vitest'
import { createInitialState, clearRows, enqueue, setSessionTitle } from '@dsh-cc/tui/store.ts'
import { applySessionEvent } from '@dsh-cc/tui/transcript.ts'
import {
  dropRowsInRange,
  extractCompactSummary,
  isCompactCheckpointSource,
  shouldEchoCommandResult,
} from '@dsh-cc/tui/compact-fold.ts'
import errorInfoPair from './fixtures/tool-result-error-info-pair.json' with { type: 'json' }
import errorPair from './fixtures/tool-result-error-pair.json' with { type: 'json' }
import readPair from './fixtures/tool-result-read-pair.json' with { type: 'json' }

/** Build a compact checkpoint user/message replace event (real 0.1.5 shape). */
function compactCheckpoint(
  seq: number,
  opts: { sourceCommandId?: string; start?: number; end?: number } = {},
): {
  type: 'user/message'
  seq: number
  surfaceOp: { op: 'replace'; startSeq: number; endSeq: number }
  data: Record<string, unknown>
} {
  const source: Record<string, unknown> = {
    kind: 'plugin',
    plugin: 'compact',
    compactionId: 'cca-1',
    ...opts.sourceCommandId === undefined ? {} : { sourceCommandId: opts.sourceCommandId },
  }
  return {
    type: 'user/message',
    seq,
    surfaceOp: { op: 'replace', startSeq: opts.start ?? 10, endSeq: opts.end ?? 20 },
    data: {
      content: [
        { type: 'text', text: 'This is an automatically generated checkpoint...\n\n<compacted-summary>' },
        { type: 'text', text: '## Primary Request\n- foo' },
        { type: 'text', text: '</compacted-summary>' },
      ],
      source,
    },
  }
}

/** A preceding compaction/summary metering event for the checkpoint above. */
function compactSummary(
  seq: number,
  opts: { items?: number; tokens?: number; sourceCommandId?: string } = {},
): { type: 'compaction/summary'; seq: number; data: Record<string, unknown> } {
  return {
    type: 'compaction/summary',
    seq,
    data: {
      compactionId: 'cca-1',
      summary: [{ type: 'text', text: '## Primary Request\n- foo' }],
      shadowedRange: { start: 10, end: 20 },
      shadowedSeqs: Array.from({ length: opts.items ?? 3 }, (_, i) => 10 + i),
      shadowedTokenCount: opts.tokens ?? 120,
      ...opts.sourceCommandId === undefined ? {} : { sourceCommandId: opts.sourceCommandId },
      provider: 'p',
      model: 'm',
    },
  }
}

describe('applySessionEvent', () => {
  it('appends user text and streams assistant deltas', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'hi', source: { kind: 'user' } } })
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { text: 'hel' } })
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { text: 'lo' } })
    expect(state.rows).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
    ])
    expect(state.busy).toBe(true)
    state = applySessionEvent(state, { type: 'turn/end' })
    expect(state.busy).toBe(false)
  })

  it('unwraps the live {turn, step, chunk} assistant/chunk envelope', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { blockType: 'text', index: 0, type: 'block-start' } } })
    expect(state.busy).toBe(true)
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { index: 0, text: 'MOCK OK', type: 'text-delta' } } })
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'MOCK OK' })
  })

  it('updates a tool row in place from call to result', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'tool/call',
      data: { callId: '1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    state = applySessionEvent(state, {
      type: 'tool/result',
      data: { callId: '1', name: 'bash', text: 'ok' },
    })
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      kind: 'tool',
      callId: '1',
      running: false,
      title: 'bash',
      result: 'ok',
    })
  })

  it('uses presentCall/presentResult views when a presenter is supplied', () => {
    let state = createInitialState()
    const presenters = {
      presentCall: () => ({ card: 'terminal' as const, title: 'ls -la', cwd: '/tmp' }),
      presentResult: () => ({ card: 'terminal' as const, output: 'ok', exitCode: 0 }),
    }
    state = applySessionEvent(state, {
      type: 'tool/call',
      data: { callId: '1', name: 'Bash', arguments: '{"command":"ls -la"}' },
    }, presenters)
    expect(state.rows[0]).toMatchObject({ kind: 'tool', title: 'ls -la', body: 'cwd /tmp', running: true })
    state = applySessionEvent(state, {
      type: 'tool/result',
      data: { callId: '1', name: 'Bash', text: 'ok' },
    }, presenters)
    expect(state.rows[0]).toMatchObject({ kind: 'tool', title: 'ls -la', running: false, error: false })
    expect((state.rows[0] as { body?: string }).body).toContain('exit 0')
  })

  it('folds permission/mode and plan/mode into the footer', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'permission/mode', data: { mode: 'acceptEdits' } })
    expect(state.permissionMode).toBe('acceptEdits')
    state = applySessionEvent(state, { type: 'plan/mode', data: { active: true } })
    expect(state.permissionMode).toBe('plan')
  })

  it('extracts text from a UserMessage content-block array', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi there' }], source: { kind: 'user' } },
    })
    expect(state.rows).toEqual([{ kind: 'user', text: 'hi there' }])
  })

  it('concatenates only text blocks from mixed UserMessage content', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'user/message',
      data: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', attachment: {} as never },
          { type: 'text', text: ' world' },
        ],
        source: { kind: 'user' },
      },
    })
    expect(state.rows).toEqual([{ kind: 'user', text: 'hello world' }])
  })

  it('leaves the queue untouched when a user/message lands (chips clear driver-side only)', () => {
    let state = createInitialState()
    state = enqueue(state, 'hello')
    state = enqueue(state, 'still here')
    expect(state.queued).toEqual(['hello', 'still here'])
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'hello', source: { kind: 'user' } } })
    // The fold renders the row only; chip clearing happens synchronously in
    // the driver (flush / Ctrl+S / interrupt / recall), never event-driven.
    expect(state.queued).toEqual(['hello', 'still here'])
    expect(state.rows).toEqual([{ kind: 'user', text: 'hello' }])
  })

  it('adds the user row on user/message with no queue interaction', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'other', source: { kind: 'user' } } })
    expect(state.queued).toEqual([])
    expect(state.rows).toEqual([{ kind: 'user', text: 'other' }])
  })

  describe('user/message source routing', () => {
    const CLAUDE_MD = [
      '<system-reminder>',
      '# Workspace instructions',
      ...Array.from({ length: 40 }, (_, i) => `Rule ${i}: filler CLAUDE.md line`),
      '</system-reminder>',
    ].join('\n')

    it('renders a user row for human input (kind user)', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      })
      expect(state.rows).toEqual([{ kind: 'user', text: 'hi' }])
    })

    it('hides plugin-injected instructions (CLAUDE.md payload)', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'workspace-instructions', form: 'instructions' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a plugin-injected skill catalog', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'The following skills are available: find-docs, lark-im…' }],
          source: { kind: 'plugin', plugin: 'skills', form: 'catalog' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a plugin-injected runtime-context snapshot', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'Current runtime context: today is 2026-08-26.' }],
          source: {
            kind: 'plugin',
            plugin: 'runtime-context',
            form: 'snapshot',
            sections: [{ name: 'date', text: 'today is 2026-08-26' }],
          },
        },
      })
      expect(next).toBe(state)
    })

    it('renders an unknown plugin notice form as exactly one dim status row', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'Elided compaction detail:\n' + CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'compaction', form: 'notice', summary: 'Compacted 12 messages' },
        },
      })
      // `compaction` here is NOT the compact checkpoint plugin — a plain
      // notice-form plugin message renders its summary as a status row.
      expect(state.rows).toEqual([{ kind: 'status', text: 'Compacted 12 messages' }])
    })

    it('hides a notice form without a string summary', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'compaction', form: 'notice' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a relay-form plugin message', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'relayed subagent chatter' }],
          source: { kind: 'plugin', plugin: 'subagent', form: 'relay' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a plugin message with no form', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'workspace-instructions' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides tool-sourced user messages', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'tool_result body' }],
          source: { kind: 'tool' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides messages with a missing source', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: CLAUDE_MD }] },
      })
      expect(next).toBe(state)
    })

    it('hides messages with an unknown source kind', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'time-travel' },
        },
      })
      expect(next).toBe(state)
    })

    it('adds no row for kind user with no text blocks and leaves the queue alone', () => {
      let state = createInitialState()
      state = enqueue(state, '')
      expect(state.queued).toEqual([''])
      state = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'image', attachment: {} as never }],
          source: { kind: 'user' },
        },
      })
      expect(state.queued).toEqual([''])
      expect(state.rows).toEqual([])
    })

    it('adds no row for kind user with whitespace-only text and leaves the queue alone', () => {
      let state = createInitialState()
      state = enqueue(state, '   ')
      state = applySessionEvent(state, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } },
      })
      expect(state.queued).toEqual(['   '])
      expect(state.rows).toEqual([])
    })
  })

  describe('diff card propagation', () => {
    it('stores diffs on the tool row when presentCall returns a diff card', () => {
      let state = createInitialState()
      const presenters = {
        presentCall: () => ({
          card: 'diff' as const,
          title: 'Edit foo.ts',
          diffs: [{ path: 'foo.ts', oldText: 'a\n', newText: 'b\n' }],
        }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: '1', name: 'Edit', arguments: '{"path":"foo.ts"}' },
      }, presenters)
      const row = state.rows[0]
      expect(row).toMatchObject({ kind: 'tool', callId: '1', title: 'Edit foo.ts', running: true })
      expect((row as { diffs?: unknown }).diffs).toEqual([
        { path: 'foo.ts', oldText: 'a\n', newText: 'b\n' },
      ])
    })

    it('stores diffs on the tool row when presentResult returns a diff card', () => {
      let state = createInitialState()
      const diffs = [{ path: 'bar.ts', oldText: null, newText: 'hi\n' }]
      const presenters = {
        presentCall: () => ({ card: 'diff' as const, title: 'Write bar.ts', diffs }),
        presentResult: () => ({ card: 'diff' as const, title: 'Wrote bar.ts', diffs }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: '2', name: 'Write', arguments: '{"path":"bar.ts"}' },
      }, presenters)
      state = applySessionEvent(state, {
        type: 'tool/result',
        data: { callId: '2', name: 'Write', text: 'ok' },
      }, presenters)
      const row = state.rows[0]
      expect(row).toMatchObject({ kind: 'tool', callId: '2', running: false })
      expect((row as { diffs?: unknown }).diffs).toEqual(diffs)
    })

    it('leaves diffs undefined when the presenter returns a non-diff card', () => {
      let state = createInitialState()
      const presenters = {
        presentCall: () => ({ card: 'terminal' as const, title: 'ls', cwd: '/tmp' }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: '3', name: 'Bash', arguments: '{"command":"ls"}' },
      }, presenters)
      const row = state.rows[0]
      expect((row as { diffs?: unknown }).diffs).toBeUndefined()
    })
  })

  it('ignores unknown durable event types', () => {
    const state = createInitialState()
    expect(applySessionEvent(state, { type: 'made-up/event', data: {} })).toBe(state)
  })

  describe('tool-call-delta streaming', () => {
    it('creates a pending tool row from a single tool-call-delta chunk', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":"ls"}' } },
      })
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        kind: 'tool',
        callId: 'call-1',
        name: 'bash',
        args: '{"command":"ls"}',
        title: 'bash',
        running: true,
      })
      expect(state.busy).toBe(true)
    })

    it('accumulates tool-call-delta args in place by callId', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '"ls -la"}' } },
      })
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        kind: 'tool',
        callId: 'call-1',
        name: 'bash',
        args: '{"command":"ls -la"}',
        running: true,
      })
    })

    it('accumulates interleaved tool-call-deltas independently per callId', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-a', name: 'bash', argumentsDelta: '{"a":' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'call-b', name: 'grep', argumentsDelta: '{"b":' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-a', argumentsDelta: '1}' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'call-b', argumentsDelta: '2}' } },
      })
      expect(state.rows).toHaveLength(2)
      expect(state.rows[0]).toMatchObject({ kind: 'tool', callId: 'call-a', args: '{"a":1}' })
      expect(state.rows[1]).toMatchObject({ kind: 'tool', callId: 'call-b', args: '{"b":2}' })
    })

    it('replaces a streamed tool row with the presenter card on durable tool/call', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'Bash', argumentsDelta: '{"command":"ls' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: ' -la"}' } },
      })
      const presenters = {
        presentCall: () => ({ card: 'terminal' as const, title: 'ls -la', cwd: '/tmp' }),
        presentResult: () => ({ card: 'terminal' as const, output: 'ok', exitCode: 0 }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'Bash', arguments: '{"command":"ls -la"}' },
      }, presenters)
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        kind: 'tool',
        callId: 'call-1',
        title: 'ls -la',
        body: 'cwd /tmp',
        running: true,
      })
    })

    it('finalizes a streamed tool row on durable tool/result', () => {
      let state = createInitialState()
      const presenters = {
        presentCall: () => ({ card: 'terminal' as const, title: 'ls -la', cwd: '/tmp' }),
        presentResult: () => ({ card: 'terminal' as const, output: 'done', exitCode: 0 }),
      }
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'Bash', argumentsDelta: '{"command":"ls -la"}' } },
      })
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'Bash', arguments: '{"command":"ls -la"}' },
      }, presenters)
      state = applySessionEvent(state, {
        type: 'tool/result',
        data: { callId: 'call-1', name: 'Bash', text: 'done' },
      }, presenters)
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({ kind: 'tool', callId: 'call-1', running: false, error: false })
      expect((state.rows[0] as { body?: string }).body).toContain('exit 0')
    })

    it('ignores a tool-call-delta arriving after the row was finalized by tool/result', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      })
      state = applySessionEvent(state, {
        type: 'tool/result',
        data: { callId: 'call-1', name: 'bash', text: 'ok' },
      })
      const before = state.rows[0]
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: 'garbage' } },
      })
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toBe(before)
      expect(state.rows[0]).toMatchObject({ kind: 'tool', callId: 'call-1', running: false, result: 'ok' })
    })
  })

  describe('turn/end reason folding', () => {
    it('completed reason clears busy and adds no status row (regression)', () => {
      let state = createInitialState()
      state = applySessionEvent(state, { type: 'turn/start' })
      state = applySessionEvent(state, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
      expect(state.busy).toBe(false)
      // No status row appended on a clean completion.
      expect(state.rows.filter(r => r.kind === 'status')).toHaveLength(0)
    })

    it('error reason clears busy and upserts a red-flagged status row with the verbatim message', () => {
      let state = createInitialState()
      state = applySessionEvent(state, { type: 'turn/start' })
      state = applySessionEvent(state, {
        type: 'turn/end',
        data: {
          reason: {
            kind: 'error',
            error: { message: 'prompt variable "{{model}}" has no value for this assembly' },
          },
        },
      })
      expect(state.busy).toBe(false)
      const statusRows = state.rows.filter(r => r.kind === 'status')
      expect(statusRows).toHaveLength(1)
      const row = statusRows[0] as { kind: 'status'; text: string; error?: boolean }
      expect(row.error).toBe(true)
      expect(row.text).toContain('{{model}}" has no value for this assembly')
      expect(row.text).toMatch(/^⚠ Turn failed:/)
    })

    it('blocked reason upserts a dim status row', () => {
      let state = createInitialState()
      state = applySessionEvent(state, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
      expect(state.busy).toBe(false)
      const row = state.rows.at(-1)
      expect(row?.kind).toBe('status')
      expect((row as { text: string }).text).toBe('⚠ Turn blocked')
      expect((row as { error?: boolean }).error).toBeFalsy()
    })

    it('max-tokens reason upserts a dim status row', () => {
      let state = createInitialState()
      state = applySessionEvent(state, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
      expect(state.busy).toBe(false)
      const row = state.rows.at(-1)
      expect(row?.kind).toBe('status')
      expect((row as { text: string }).text).toBe('⚠ Reached the token ceiling')
      expect((row as { error?: boolean }).error).toBeFalsy()
    })

    it('error reason without a message falls back to a generic row', () => {
      let state = createInitialState()
      state = applySessionEvent(state, { type: 'turn/end', data: { reason: { kind: 'error' } } })
      expect(state.busy).toBe(false)
      const row = state.rows.at(-1)
      expect(row?.kind).toBe('status')
      expect((row as { text: string }).text).toBe('⚠ Turn failed')
      expect((row as { error?: boolean }).error).toBe(true)
    })

    it('error reason with a non-string message falls back to a generic row', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { message: 42 } } },
      })
      expect(state.busy).toBe(false)
      const row = state.rows.at(-1)
      expect(row?.kind).toBe('status')
      expect((row as { text: string }).text).toBe('⚠ Turn failed')
      expect((row as { error?: boolean }).error).toBe(true)
    })

    it('absent reason clears busy and adds no status row', () => {
      let state = createInitialState()
      state = applySessionEvent(state, { type: 'turn/start' })
      state = applySessionEvent(state, { type: 'turn/end' })
      expect(state.busy).toBe(false)
      expect(state.rows.filter(r => r.kind === 'status')).toHaveLength(0)
    })
  })
})

describe('compact checkpoint fold', () => {
  it('paints ONE compact row for a real checkpoint — manual trigger when sourceCommandId present', () => {
    let state = createInitialState()
    state = applySessionEvent(state, compactSummary(9, { sourceCommandId: 'cmd-1' }))
    state = applySessionEvent(state, compactCheckpoint(21, { sourceCommandId: 'cmd-1' }))
    expect(state.rows).toEqual([
      { kind: 'compact', trigger: 'manual', items: 3, tokens: 120, summary: '## Primary Request\n- foo', seq: 21 },
    ])
    expect(state.pendingCompact).toBeUndefined()
  })

  it('marks an auto trigger when no sourceCommandId is present anywhere', () => {
    let state = createInitialState()
    state = applySessionEvent(state, compactSummary(9))
    state = applySessionEvent(state, compactCheckpoint(21))
    expect(state.rows).toEqual([
      { kind: 'compact', trigger: 'auto', items: 3, tokens: 120, summary: '## Primary Request\n- foo', seq: 21 },
    ])
  })

  it('replace drops seq-tagged rows in range and keeps the tail', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'user/message', seq: 10, data: { text: 'old', source: { kind: 'user' } } })
    state = applySessionEvent(state, { type: 'assistant/chunk', seq: 12, data: { text: 'reply' } })
    state = applySessionEvent(state, {
      type: 'tool/call',
      seq: 15,
      data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    state = applySessionEvent(state, { type: 'user/message', seq: 30, data: { text: 'recent', source: { kind: 'user' } } })
    state = applySessionEvent(state, compactCheckpoint(21, { start: 10, end: 20 }))
    expect(state.rows).toEqual([
      { kind: 'compact', trigger: 'auto', items: 0, tokens: 0, summary: '## Primary Request\n- foo', seq: 21 },
      { kind: 'user', text: 'recent', seq: 30 },
    ])
  })

  it('legacy pre-0.1.5 start/end replace spelling still drops the range', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'user/message', seq: 10, data: { text: 'old', source: { kind: 'user' } } })
    state = applySessionEvent(state, { type: 'user/message', seq: 30, data: { text: 'recent', source: { kind: 'user' } } })
    state = applySessionEvent(state, {
      type: 'user/message',
      seq: 21,
      surfaceOp: { op: 'replace', start: 10, end: 20 },
      data: { text: 'folded', source: { kind: 'user' } },
    })
    // A non-checkpoint replacement only shrinks the transcript: the range row
    // (seq 10) is dropped, the replacing event adds no row of its own, and the
    // tail (seq 30) survives.
    expect(state.rows).toEqual([
      { kind: 'user', text: 'recent', seq: 30 },
    ])
  })

  it('assistant rows carry the last chunk seq and drop whole when it falls in range', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'assistant/chunk', seq: 11, data: { text: 'he' } })
    state = applySessionEvent(state, { type: 'assistant/chunk', seq: 19, data: { text: 'llo' } })
    expect(state.rows).toEqual([{ kind: 'assistant', text: 'hello', seq: 19 }])
    state = applySessionEvent(state, compactCheckpoint(21, { start: 10, end: 20 }))
    expect(state.rows).toEqual([
      { kind: 'compact', trigger: 'auto', items: 0, tokens: 0, summary: '## Primary Request\n- foo', seq: 21 },
    ])
  })

  it('non-compact plugin messages stay hidden and notice forms stay status rows', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'user/message',
      seq: 12,
      surfaceOp: { op: 'replace', start: 10, end: 20 },
      data: { content: [{ type: 'text', text: 'injected' }], source: { kind: 'plugin', plugin: 'skills', form: 'catalog' } },
    })
    expect(state.rows).toEqual([])
    state = applySessionEvent(state, {
      type: 'user/message',
      seq: 13,
      data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'some-plugin', form: 'notice', summary: 'note' } },
    })
    expect(state.rows).toEqual([{ kind: 'status', text: 'note', seq: 13 }])
  })

  it('a second replace covering the first compact row seq drops it — only newest remains', () => {
    let state = createInitialState()
    state = applySessionEvent(state, compactSummary(9, { sourceCommandId: 'cmd-1' }))
    state = applySessionEvent(state, compactCheckpoint(21, { sourceCommandId: 'cmd-1' }))
    state = applySessionEvent(state, compactSummary(40, { items: 5, tokens: 300 }))
    state = applySessionEvent(state, compactCheckpoint(41, { start: 15, end: 45 }))
    expect(state.rows).toEqual([
      { kind: 'compact', trigger: 'auto', items: 5, tokens: 300, summary: '## Primary Request\n- foo', seq: 41 },
    ])
  })

  it('full-list reduce equals live sequential apply (foldHistory is a plain reduce)', () => {
    const events: Parameters<typeof applySessionEvent>[1][] = [
      { type: 'user/message', seq: 1, data: { text: 'hello', source: { kind: 'user' } } },
      { type: 'assistant/chunk', seq: 2, data: { text: 'hi' } },
      { type: 'compaction/summary', seq: 9, data: compactSummary(9).data },
      compactCheckpoint(21, { sourceCommandId: 'cmd-1', start: 1, end: 20 }),
      { type: 'user/message', seq: 30, data: { text: 'next', source: { kind: 'user' } } },
    ]
    // Same reference shape as foldHistory: a plain reduce over the log.
    let reduced = createInitialState()
    for (const event of events) reduced = applySessionEvent(reduced, event)
    let sequential = createInitialState()
    for (const event of events) sequential = applySessionEvent(sequential, event)
    expect(reduced).toEqual(sequential)
    expect(reduced.rows).toEqual([
      { kind: 'compact', trigger: 'manual', items: 3, tokens: 120, summary: '## Primary Request\n- foo', seq: 21 },
      { kind: 'user', text: 'next', seq: 30 },
    ])
  })

  it('missing pendingCompact still paints a compact row with items=0 tokens=0', () => {
    let state = createInitialState()
    state = applySessionEvent(state, compactCheckpoint(21, { sourceCommandId: 'cmd-1' }))
    expect(state.rows).toEqual([
      { kind: 'compact', trigger: 'manual', items: 0, tokens: 0, summary: '## Primary Request\n- foo', seq: 21 },
    ])
  })

  it('compaction/summary alone paints no row', () => {
    let state = createInitialState()
    const next = applySessionEvent(state, compactSummary(9, { sourceCommandId: 'cmd-1' }))
    expect(next.rows).toEqual([])
    expect(next.pendingCompact).toEqual({ items: 3, tokens: 120, sourceCommandId: 'cmd-1' })
  })
})

describe('compact-fold helpers', () => {
  it('isCompactCheckpointSource duck-types the compact plugin source', () => {
    expect(isCompactCheckpointSource({ kind: 'plugin', plugin: 'compact' })).toBe(true)
    expect(isCompactCheckpointSource({ kind: 'plugin', plugin: 'compact', sourceCommandId: 'cmd-1' })).toBe(true)
    expect(isCompactCheckpointSource({ kind: 'plugin', plugin: 'compaction' })).toBe(false)
    expect(isCompactCheckpointSource({ kind: 'user' })).toBe(false)
    expect(isCompactCheckpointSource(undefined)).toBe(false)
    expect(isCompactCheckpointSource('compact')).toBe(false)
  })

  it('extractCompactSummary slices between the summary tags and trims', () => {
    expect(extractCompactSummary([
      { type: 'text', text: 'prelude\n\n<compacted-summary>' },
      { type: 'text', text: '## A\n- b' },
      { type: 'text', text: '</compacted-summary>' },
    ])).toBe('## A\n- b')
    expect(extractCompactSummary([{ type: 'text', text: 'no tags' }])).toBe('')
    expect(extractCompactSummary(undefined)).toBe('')
    expect(extractCompactSummary([
      { type: 'text', text: '</compacted-summary>' },
      { type: 'text', text: '<compacted-summary>' },
    ])).toBe('')
  })

  it('dropRowsInRange drops only tagged rows inside the inclusive range', () => {
    const rows = [
      { kind: 'user', text: 'a', seq: 5 },
      { kind: 'user', text: 'untagged' },
      { kind: 'status', text: 's', seq: 10 },
      { kind: 'user', text: 'b', seq: 11 },
    ] as never[]
    expect(dropRowsInRange(rows, 5, 10)).toEqual([
      { kind: 'user', text: 'untagged' },
      { kind: 'user', text: 'b', seq: 11 },
    ])
    expect(dropRowsInRange(rows, 100, 200)).toEqual(rows)
  })

  it('shouldEchoCommandResult suppresses success echo when a compact row exists', () => {
    const withCompact = [{ kind: 'compact', trigger: 'manual', items: 1, tokens: 1, summary: '' }]
    const noCompact = [{ kind: 'user', text: 'hi' }]
    expect(shouldEchoCommandResult(
      { kind: 'success', text: 'Compacted 3 history items (~10 tokens).', sourceEventSeq: 99 },
      withCompact as never[],
    )).toBe(false)
    expect(shouldEchoCommandResult(
      { kind: 'success', text: 'Compacted 3 history items (~10 tokens).', sourceEventSeq: 99 },
      noCompact as never[],
    )).toBe(true)
    expect(shouldEchoCommandResult({ kind: 'error', text: 'boom' }, withCompact as never[])).toBe(true)
    expect(shouldEchoCommandResult(undefined, withCompact as never[])).toBe(false)
  })
})

describe('session/title folding', () => {
  const titleEvent = (title: string, seq = 1) => ({
    type: 'session/title' as const,
    seq,
    data: { title, messageSeqs: [1], source: 'fallback' },
  })

  it('folds the title into state without adding a transcript row', () => {
    const state = applySessionEvent(createInitialState(), titleEvent('Fix login bug'), [])
    expect(state.title).toBe('Fix login bug')
    expect(state.rows).toEqual([])
  })

  it('last-wins across successive title events (fallback then provider)', () => {
    let state = applySessionEvent(createInitialState(), titleEvent('fallback title', 1), [])
    state = applySessionEvent(state, titleEvent('LLM title', 2), [])
    expect(state.title).toBe('LLM title')
  })

  it('ignores missing or empty titles', () => {
    const initial = createInitialState()
    expect(applySessionEvent(initial, { type: 'session/title', data: {} }, [])).toBe(initial)
    expect(applySessionEvent(initial, { type: 'session/title', data: { title: '' } }, [])).toBe(initial)
    expect(applySessionEvent(initial, { type: 'session/title' }, [])).toBe(initial)
  })

  it('clearRows preserves the session title', () => {
    const titled = applySessionEvent(createInitialState(), titleEvent('Keep me'), [])
    const cleared = clearRows(titled)
    expect(cleared.title).toBe('Keep me')
    expect(cleared.rows).toEqual([])
  })

  it('setSessionTitle clears on undefined and is same-reference when unchanged', () => {
    const titled = applySessionEvent(createInitialState(), titleEvent('T'), [])
    expect(setSessionTitle(titled, 'T')).toBe(titled)
    const cleared = setSessionTitle(titled, undefined)
    expect(cleared.title).toBeUndefined()
    expect(setSessionTitle(cleared, undefined)).toBe(cleared)
  })
})

describe('wrapped tool/result folding', () => {
  const callOf = (pair: { type: string }[]) => pair[0]
  const resultOf = (pair: { type: string }[]) => pair[1]

  it('fixtures are wrapped-shape pairs with tool-result blocks', () => {
    for (const pair of [readPair, errorPair, errorInfoPair]) {
      expect(callOf(pair).type).toBe('tool/call')
      expect(resultOf(pair).type).toBe('tool/result')
      const data = resultOf(pair).data as { message?: { content?: { type?: string; toolCallId?: unknown }[] } }
      expect(data.message?.content?.[0]?.type).toBe('tool-result')
      expect(data.message?.content?.[0]?.toolCallId).toBeTruthy()
    }
  })

  it('completes a read row from the wrapped fixture pair', () => {
    let state = createInitialState()
    state = applySessionEvent(state, callOf(readPair) as never)
    expect(state.rows.find((row) => row.kind === 'tool')).toMatchObject({ name: 'read', running: true })
    state = applySessionEvent(state, resultOf(readPair) as never)
    const resultRow = state.rows.find((row) => row.kind === 'tool' && !row.running)
    expect(resultRow).toMatchObject({
      kind: 'tool',
      callId: 'chatcmpl-tool-957d46bdc1f3c1e7',
      name: 'read',
      running: false,
      error: false,
    })
    expect((resultRow as { result?: string }).result?.length ?? 0).toBeGreaterThan(0)
    expect((resultRow as { title?: string }).title).toBe('read')
  })

  it('passes pending name, parsed args, and meta to presentResult', () => {
    let state = createInitialState()
    let seenName: string | undefined
    let seenArgs: unknown
    let seenResult: { content: unknown; isError: boolean; meta?: unknown } | undefined
    const presenters = {
      presentCall: () => ({ card: 'terminal' as const, title: 'Read file' }),
      presentResult: (name: string, args: unknown, result: { content: unknown; isError: boolean; meta?: unknown }) => {
        seenName = name
        seenArgs = args
        seenResult = result
        return { card: 'terminal' as const, output: 'x', exitCode: 0 }
      },
    }
    state = applySessionEvent(state, callOf(readPair) as never, presenters)
    state = applySessionEvent(state, resultOf(readPair) as never, presenters)
    const data = resultOf(readPair).data as {
      message?: { content?: { content?: unknown }[] }
    }
    expect(seenName).toBe('read')
    expect(seenArgs).toEqual({ file_path: 'docs/plans/2026-09-21-subagent-actor-contract-prompts.md' })
    expect(seenResult?.content).toEqual(data.message?.content?.[0]?.content)
    expect(seenResult?.isError).toBe(false)
    expect(seenResult?.meta).toEqual((resultOf(readPair).data as { meta?: unknown }).meta)
  })

  it.each([[errorPair], [errorInfoPair]])('marks the error fixture row red (%#)', (pair) => {
    let state = createInitialState()
    state = applySessionEvent(state, callOf(pair) as never)
    state = applySessionEvent(state, resultOf(pair) as never)
    const row = state.rows.find((item) => item.kind === 'tool' && !item.running)
    expect(row).toMatchObject({ error: true, running: false })
  })

  it('drops an unresolvable result without touching rows', () => {
    let state = createInitialState()
    state = applySessionEvent(state, callOf(readPair) as never)
    const before = state.rows
    state = applySessionEvent(state, {
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: 'orphan' }] } },
    })
    expect(state.rows).toBe(before)
  })

  it('appends a standalone completed row for a resolvable result with no pending call', () => {
    const state = applySessionEvent(createInitialState(), resultOf(readPair) as never)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ kind: 'tool', running: false, name: 'tool', title: 'tool' })
  })

  it('completes two consecutive read rows so the read-group collapse can fire', () => {
    // Second pair re-keyed to a distinct callId so two rows accumulate.
    const secondCall = JSON.parse(JSON.stringify(callOf(readPair)))
    const secondResult = JSON.parse(JSON.stringify(resultOf(readPair)))
    secondCall.data.callId = 'chatcmpl-tool-second'
    secondResult.data.message.source.callId = 'chatcmpl-tool-second'
    secondResult.data.message.content[0].toolCallId = 'chatcmpl-tool-second'
    let state = createInitialState()
    state = applySessionEvent(state, callOf(readPair) as never)
    state = applySessionEvent(state, resultOf(readPair) as never)
    state = applySessionEvent(state, secondCall as never)
    state = applySessionEvent(state, secondResult as never)
    const toolRows = state.rows.filter((row) => row.kind === 'tool')
    expect(toolRows).toHaveLength(2)
    expect(toolRows.filter((row) => !row.running)).toHaveLength(2)
  })
})
