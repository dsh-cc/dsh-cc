/**
 * Brief-rendering unit tests (design §5 item 2): fixed strings present,
 * 500-todo budget elision ≤ maxLines, head/tail shape, and the degenerate
 * empty-shadow form (design §4).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { BRIEF_TITLE, MICROCOMPACT_STUB_SENTENCE, NOT_VERIFIED_WARNING, renderBrief } from '../src/brief.ts'
import { applyEvent, createShadow, LAST_USER_MAX_CHARS } from '../src/shadow.ts'

function ev<K extends keyof SessionEventMap>(type: K, time: number, data: unknown): SessionEvent<K> {
  return { type, seq: 0, time, data } as unknown as SessionEvent<K>
}

function shadowWithTodos(n: number) {
  let shadow = createShadow()
  shadow = applyEvent(shadow, ev('todo/write', 10, {
    todos: Array.from({ length: n }, (_, i) => ({ content: `task ${i + 1}`, status: i % 2 === 0 ? 'completed' : 'pending' })),
  }))
  return shadow
}

describe('fixed strings', () => {
  it('title, stub sentence and not-verified warning are always present', () => {
    const brief = renderBrief(createShadow(), { maxLines: 120, includeVerified: true })
    expect(brief).toContain(BRIEF_TITLE)
    expect(brief).toContain(MICROCOMPACT_STUB_SENTENCE)
    expect(brief).toContain(NOT_VERIFIED_WARNING)
  })

  it('verified lines carry the §3.3 template shape', () => {
    let shadow = createShadow()
    shadow = applyEvent(shadow, ev('tool/call', 10, { callId: 'c', name: 'bash', arguments: JSON.stringify({ command: 'npx vitest run' }) }))
    shadow = applyEvent(shadow, ev('tool/result', 1727347200000, {
      message: { id: 'm', role: 'tool', source: { kind: 'tool', callId: 'c' }, content: [{ type: 'text', text: '[exit code: 0]' }] },
    }))
    const brief = renderBrief(shadow, { maxLines: 120, includeVerified: true })
    expect(brief).toContain('- Verified done (execution receipts):')
    expect(brief).toContain('  - 1727347200000 tests green (vitest) [bash ok]')
  })

  it('include-verified false drops the receipts section', () => {
    let shadow = createShadow()
    shadow = applyEvent(shadow, ev('tool/call', 10, { callId: 'c', name: 'bash', arguments: JSON.stringify({ command: 'npx vitest run' }) }))
    shadow = applyEvent(shadow, ev('tool/result', 20, {
      message: { id: 'm', role: 'tool', source: { kind: 'tool', callId: 'c' }, content: [{ type: 'text', text: '[exit code: 0]' }] },
    }))
    expect(renderBrief(shadow, { maxLines: 120, includeVerified: true })).toContain('Verified done')
    expect(renderBrief(shadow, { maxLines: 120, includeVerified: false })).not.toContain('Verified done')
  })

  it('git commit receipts render the commit label', () => {
    let shadow = createShadow()
    shadow = applyEvent(shadow, ev('tool/call', 10, { callId: 'g', name: 'bash', arguments: JSON.stringify({ command: 'git commit -m "x"' }) }))
    shadow = applyEvent(shadow, ev('tool/result', 999, {
      message: { id: 'm', role: 'tool', source: { kind: 'tool', callId: 'g' }, content: [{ type: 'text', text: '[main abc123] x\n[exit code: 0]' }] },
    }))
    expect(renderBrief(shadow, { maxLines: 120, includeVerified: true })).toContain('  - 999 commit created (git commit) [bash ok]')
  })
})

describe('todo budget elision', () => {
  it('500 todos elide to ≤ maxLines with head-2/3 + tail-1/3 shape', () => {
    const maxLines = 120
    const brief = renderBrief(shadowWithTodos(500), { maxLines, includeVerified: true })
    const lines = brief.split('\n')
    expect(lines.length).toBeLessThanOrEqual(maxLines)
    const marker = lines.find((line) => /^\u2026 \(\d+ elided\)$/.test(line.trim()))
    expect(marker).toBeDefined()
    expect(marker).toContain('elided')
    // Head and tail survive: first and last tasks are present.
    expect(brief).toContain('task 1')
    expect(brief).toContain('task 500')
    expect(brief).toContain('Todo snapshot (verbatim):')
  })

  it('small lists render verbatim with no elision marker', () => {
    const brief = renderBrief(shadowWithTodos(3), { maxLines: 120, includeVerified: true })
    expect(brief).not.toMatch(/elided/)
    expect(brief).toContain('task 1')
    expect(brief).toContain('task 3')
  })
})

describe('degenerate form (empty shadow / post-restart, design §4)', () => {
  it('empty shadow: stub sentence + not-verified warning, no data sections', () => {
    const brief = renderBrief(createShadow(), { maxLines: 120, includeVerified: true })
    expect(brief).toContain('- Goal: none recorded')
    expect(brief).not.toContain('Verified done')
    expect(brief).not.toContain('Todo snapshot')
    expect(brief).not.toContain('Last user instruction')
    expect(brief.split('\n').length).toBeLessThanOrEqual(120)
  })

  it('empty shadow with a known last user: stub + last-user line + warning', () => {
    let shadow = createShadow()
    shadow = applyEvent(shadow, ev('user/message', 4242, { content: [{ type: 'text', text: 'fix the flaky test' }], source: { kind: 'user' } }))
    const brief = renderBrief(shadow, { maxLines: 120, includeVerified: true })
    expect(brief).toContain('Note: tool results may have been replaced by microcompact placeholder stubs')
    expect(brief).toContain('- Last user instruction at 4242: fix the flaky test')
    expect(brief).toContain(NOT_VERIFIED_WARNING.split('\n')[0]!)
  })

  it('lastUserText is bound to the first 200 chars', () => {
    let shadow = createShadow()
    shadow = applyEvent(shadow, ev('user/message', 1, { content: [{ type: 'text', text: 'y'.repeat(300) }], source: { kind: 'user' } }))
    const brief = renderBrief(shadow, { maxLines: 120, includeVerified: true })
    expect(brief).toContain('y'.repeat(LAST_USER_MAX_CHARS))
    expect(brief).not.toContain('y'.repeat(LAST_USER_MAX_CHARS + 1))
  })
})
