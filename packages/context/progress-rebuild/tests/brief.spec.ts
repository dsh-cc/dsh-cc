import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyBudget,
  applyProgressRebuild,
  BRIEF_HEADER,
  BRIEF_MAX_BYTES,
  MAX_LINE_CHARS,
  NOT_VERIFIED_NOTE,
  renderBrief,
  STUB_MARKER_NOTE,
  VERIFIED_HEADER,
  truncateLine,
  type ProgressRebuildState,
  type VerifiedReceipt,
} from '../src/index.ts'

const OPTS = { maxLines: 120, includeVerified: true }

function emptyState(): ProgressRebuildState {
  return {
    goal: { current: null, seenGoalIds: [], failure: null },
    todos: null,
    verified: [],
    callIndex: [],
    lastUser: null,
  }
}

function withTodos(todos: { content: string; status: string }[]): ProgressRebuildState {
  return { ...emptyState(), todos }
}

describe('brief template (§5.2 fixed strings)', () => {
  it('renders the exact header, goal, note, and closing lines', () => {
    const brief = renderBrief(emptyState(), OPTS)
    expect(brief.text).toContain(BRIEF_HEADER)
    expect(brief.text).toContain('- Goal: none recorded')
    expect(brief.text).toContain(STUB_MARKER_NOTE)
    expect(brief.text).toContain(NOT_VERIFIED_NOTE)
    expect(brief.text).not.toContain(VERIFIED_HEADER) // no receipts → no section
  })

  it('renders goal objective with phase, and replay failure degrades the line', () => {
    const state: ProgressRebuildState = {
      ...emptyState(),
      goal: {
        current: { goal: { objective: 'ship the thing', phase: 'active' }, roundsStarted: 1, createdAt: 1, updatedAt: 2 },
        seenGoalIds: ['goal-1'],
        failure: null,
      },
    }
    expect(renderBrief(state, OPTS).text).toContain('- Goal: ship the thing (phase: active)')
    expect(renderBrief({ ...state, goal: { ...state.goal, failure: 'strict replay failure' } }, OPTS).text)
      .toContain('- Goal: goal state unavailable (replay failure)')
  })

  it('renders verified receipts and include-verified=false drops the whole section', () => {
    const receipt: VerifiedReceipt = { ts: 1_700_000_000_000, callId: 'c1', commandHead: 'pnpm presubmit' }
    const state: ProgressRebuildState = { ...emptyState(), verified: [receipt] }
    expect(renderBrief(state, OPTS).text).toContain(VERIFIED_HEADER)
    expect(renderBrief(state, OPTS).text).toContain(`- ${new Date(receipt.ts).toISOString()} \`pnpm presubmit\``)
    expect(renderBrief(state, { ...OPTS, includeVerified: false }).text).not.toContain(VERIFIED_HEADER)
  })

  it('renders the todo snapshot verbatim as checkbox lines and the last-user line', () => {
    const state: ProgressRebuildState = {
      ...emptyState(),
      todos: [
        { content: 'write tests', status: 'completed' },
        { content: 'run gates', status: 'pending' },
      ],
      lastUser: { ts: 1_700_000_000_000, seq: '7', text: 'please continue' },
    }
    const brief = renderBrief(state, OPTS)
    expect(brief.text).toContain('- Todo snapshot (verbatim):')
    expect(brief.text).toContain('  - [x] write tests')
    expect(brief.text).toContain('  - [ ] run gates')
    expect(brief.text).toContain(`- Last user instruction at ${new Date(state.lastUser.ts).toISOString()}: please continue`)
    expect(brief.sections).toBe(3)
  })
})

describe('brief budget (§5.2 both axes)', () => {
  it('500-todo fixture elides to ≤ max-lines AND ≤ 6 KiB with head/tail shape', () => {
    const todos = Array.from({ length: 500 }, (_v, i) => ({ content: `todo item number ${i + 1}`, status: 'pending' }))
    const brief = renderBrief(withTodos(todos), OPTS)
    expect(brief.text.split('\n').length).toBeLessThanOrEqual(OPTS.maxLines)
    expect(Buffer.byteLength(brief.text, 'utf8')).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
    // Tail preference: the last todos survive, early middle ones are elided.
    expect(brief.text).toContain('todo item number 500')
    expect(brief.text).toContain('todo item number 1')
    expect(brief.text).not.toContain('todo item number 300\n')
    expect(brief.text).toMatch(/earlier todos elided/)
  })

  it('a 10-KB single-line command/todo truncates at 240 chars per line', () => {
    const longCommand = 'x'.repeat(10 * 1024)
    const state: ProgressRebuildState = {
      ...emptyState(),
      verified: [{ ts: 1_700_000_000_000, callId: 'c1', commandHead: longCommand.slice(0, 200) }],
      todos: [{ content: longCommand, status: 'pending' }],
      lastUser: { ts: 1_700_000_000_000, seq: '1', text: longCommand },
    }
    const brief = renderBrief(state, OPTS)
    for (const line of brief.text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS)
    }
    expect(Buffer.byteLength(brief.text, 'utf8')).toBeLessThanOrEqual(BRIEF_MAX_BYTES)
  })

  it('applyBudget keeps the fixed sentences when only todos can be dropped', () => {
    const todos = Array.from({ length: 500 }, () => ({ content: 'filler', status: 'pending' }))
    const out = applyBudget(renderBrief(withTodos(todos), OPTS).text.split('\n'), 12)
    expect(out.length).toBeLessThanOrEqual(12)
    expect(out.join('\n')).toContain(BRIEF_HEADER)
    expect(out.join('\n')).toContain(NOT_VERIFIED_NOTE)
  })
})

describe('self-reference (§5.2)', () => {
  it('a user/message event with kind progress-rebuild does not change lastUser', () => {
    const before: ProgressRebuildState = {
      ...emptyState(),
      lastUser: { ts: 1_700_000_000_000, seq: '7', text: 'the genuine instruction' },
    }
    const briefEvent = {
      type: 'user/message',
      seq: 8,
      time: 1_700_000_050_000,
      data: {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: '## Resume after compaction (auto-generated, derived from session events — trust over prose memory)' }],
        source: { kind: 'progress-rebuild' },
      },
    } as unknown as SessionEvent
    expect(applyProgressRebuild(before, briefEvent)).toBe(before)
    // And a source-less genuine message still lands.
    const genuine = { ...briefEvent, data: { ...briefEvent.data, source: undefined } } as unknown as SessionEvent
    const after = applyProgressRebuild(before, genuine)
    expect(after.lastUser).not.toBeNull()
    expect(after.lastUser!.seq).toBe('8')
  })
})
