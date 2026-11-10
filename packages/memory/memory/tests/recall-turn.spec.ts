/**
 * `resolveRecallTurn` unit tests (design
 * docs/plans/2026-11-10-systemone-shadow-activation-fixes.md §2, §5).
 *
 * Every fixture uses the REAL harness event ordering: the turn's `turn/start`
 * is persisted before the first pre-step, while the turn's `user/message`
 * events land only in the request phase — AFTER the pre-step waterfall — so
 * they are deliberately absent from the snapshot at resolve time. Seeding a
 * user event as the origin (the old fixtures' shape) is the exact mistake that
 * hid the defect.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  INJECTED_SOURCE_DENYLIST,
  genuineUserQuery,
  isGenuineUserMessage,
  resolveRecallTurn,
} from '../src/recall-query.ts'
import type { RecallMessageLike } from '../src/recall-query.ts'

/** Build a fake agent whose session log the test controls. */
function makeAgent(events: unknown[]): Agent {
  const session = {
    id: 'session-1',
    header: { cwd: '/work/repo' },
    snapshotEvents: () => events,
  }
  return { session } as unknown as Agent
}

/** A genuine claimed user message. */
const user = (text: string): RecallMessageLike =>
  ({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** An injected claimed message. */
const injected = (kind: string, text: string): RecallMessageLike =>
  ({ content: [{ type: 'text', text }], source: { kind } })

/** A persisted `turn/start` event. */
const turnStart = (seq: number): unknown => ({ type: 'turn/start', seq, data: { turn: 3 } })

/** A persisted genuine `user/message` event. */
const userEvent = (seq: number, text: string): unknown => ({
  type: 'user/message',
  seq,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})

describe('isGenuineUserMessage (structural allowlist)', () => {
  it('accepts absent source, null source, and kind "user"', () => {
    expect(isGenuineUserMessage({ content: [{ type: 'text', text: 'hi' }] })).toBe(true)
    expect(isGenuineUserMessage({ content: [], source: null as never })).toBe(true)
    expect(isGenuineUserMessage(user('hi'))).toBe(true)
  })

  it('rejects a present source without a kind (the asymmetric cell)', () => {
    expect(isGenuineUserMessage({ content: [{ type: 'text', text: 'x' }], source: {} as never })).toBe(false)
  })

  it('rejects every injected kind, including kinds the denylist never carried', () => {
    for (const kind of ['memory', 'cc-subagent-children', 'cc-shell-glue', 'moa', 'brand-new-injector']) {
      expect(isGenuineUserMessage(injected(kind, 'x'))).toBe(false)
    }
  })
})

describe('genuineUserQuery (shared query construction)', () => {
  it('joins only the genuine texts', () => {
    const batch = [
      injected('cc-shell-glue', 'MCP: still connecting'),
      injected('hooks-claude-code', 'lane is ARMED'),
      user('我重启了当前进程'),
      injected('cc-shell-glue', 'MCP: servers ready'),
      injected('moa', 'routed → sketch'),
    ]
    expect(genuineUserQuery(batch)).toBe('我重启了当前进程')
  })

  it('normalizes multi-block content: non-empty text blocks, newline join, non-text skipped', () => {
    const message: RecallMessageLike = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'x' } as never,
        { type: 'text', text: '' },
        { type: 'text', text: 'second' },
      ],
      source: { kind: 'user' },
    }
    expect(genuineUserQuery([message])).toBe('first\nsecond')
  })

  it('returns an empty string for an injected-only batch', () => {
    expect(genuineUserQuery([injected('moa', 'routed')])).toBe('')
  })
})

describe('resolveRecallTurn (origin = the turn\'s turn/start seq)', () => {
  it('resolves a real-session batch whose user event is NOT yet persisted', () => {
    // Real ordering: turn/start in the log, this turn's user/message absent.
    const agent = makeAgent([userEvent(10, 'an older turn'), turnStart(20)])
    const batch = [
      injected('cc-shell-glue', 'MCP: still connecting'),
      injected('hooks-claude-code', 'the lane is ARMED'),
      user('现在shadow模式工作吗？'),
      injected('cc-shell-glue', 'MCP: servers ready'),
      injected('moa', 'routed → sketch'),
    ]
    expect(resolveRecallTurn(agent, batch)).toEqual({ query: '现在shadow模式工作吗？', originSeq: 20 })
  })

  it('resolves the newest turn/start when a later turn repeats earlier text', () => {
    const agent = makeAgent([turnStart(5), userEvent(6, 'continue'), turnStart(9)])
    expect(resolveRecallTurn(agent, [user('continue')])).toEqual({ query: 'continue', originSeq: 9 })
  })

  it('joins a multi-genuine batch into one query under the newest turn/start', () => {
    const agent = makeAgent([turnStart(4)])
    expect(resolveRecallTurn(agent, [user('first'), injected('moa', 'x'), user('second')]))
      .toEqual({ query: 'first\nsecond', originSeq: 4 })
  })

  it('returns undefined for an injected-only batch (no query)', () => {
    const agent = makeAgent([turnStart(4)])
    expect(resolveRecallTurn(agent, [injected('cc-shell-glue', 'notice')])).toBeUndefined()
  })

  it('returns undefined when the log has no turn/start (fail closed)', () => {
    const agent = makeAgent([userEvent(3, 'hello')])
    expect(resolveRecallTurn(agent, [user('hello')])).toBeUndefined()
  })

  it('returns undefined when the snapshot is unavailable', () => {
    const agent = { session: {} } as unknown as Agent
    expect(resolveRecallTurn(agent, [user('hello')])).toBeUndefined()
  })

  it('returns undefined for a genuine message with only empty text blocks', () => {
    const agent = makeAgent([turnStart(4)])
    const blank: RecallMessageLike = { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }
    expect(resolveRecallTurn(agent, [blank])).toBeUndefined()
  })

  it('returns undefined for a turn/start carrying a non-safe seq', () => {
    const agent = makeAgent([{ type: 'turn/start', seq: -1, data: {} }])
    expect(resolveRecallTurn(agent, [user('hi')])).toBeUndefined()
  })
})

describe('INJECTED_SOURCE_DENYLIST (inventory, non-operative)', () => {
  it('carries the observed real-session injected kinds', () => {
    for (const kind of [
      'cc-shell-glue',
      'hooks-claude-code',
      'moa',
      'agent-instructions',
      'runtime-context',
      'skill-catalog',
    ]) {
      expect(INJECTED_SOURCE_DENYLIST).toContain(kind)
    }
  })

  it('still carries the tripwire-pinned kinds', () => {
    expect(INJECTED_SOURCE_DENYLIST).toContain('completion-gate')
    expect(INJECTED_SOURCE_DENYLIST).toContain('progress-rebuild')
  })
})
