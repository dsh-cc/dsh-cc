import { describe, expect, it } from 'vitest'
import {
  MAX_DELTA_BYTES,
  MAX_TOOL_ARGS_BYTES,
  fullCursor,
  isGenuineUser,
  renderDelta,
  reviewWindow,
  type DeltaMessage,
} from '../src/delta.ts'

function msg(text: string, kind?: string): DeltaMessage {
  return {
    content: [{ type: 'text', text }],
    ...(kind === undefined ? {} : { source: { kind } }),
  }
}

describe('reviewWindow (§4.1 steps 3-4, snapshot decision)', () => {
  it('first observation initializes and skips (cold/resumed history never billed)', () => {
    const snapshot = [msg('old assistant line'), msg('old user line')]
    expect(reviewWindow(snapshot, undefined)).toEqual({ action: 'init' })
  })

  it('empty-after-filter window: advance cursor, skip with reason empty-window', () => {
    const cursor = { count: 0, tail: '' }
    expect(reviewWindow([], cursor)).toEqual({ action: 'skip', reason: 'empty-window' })
  })

  it('injected kinds are filtered out of the candidate window', () => {
    const cursor = { count: 0, tail: '' }
    const decision = reviewWindow(
      [msg('memory body', 'memory'), msg('advisory', 'advisor'), msg('turn-rules body', 'turn-rules'), msg('plugin', 'plugin')],
      cursor,
    )
    expect(decision).toEqual({ action: 'skip', reason: 'empty-window' }) // filtered window is empty
  })

  it('non-empty filtered window without a genuine user message: advance cursor, skip with reason no-genuine-user', () => {
    const cursor = { count: 0, tail: '' }
    expect(reviewWindow([msg('assistant line', 'model'), msg('tool line', 'cc-subagent-children')], cursor))
      .toEqual({ action: 'skip', reason: 'no-genuine-user' })
  })

  it('source-less OR kind-user messages both count as genuine user input', () => {
    expect(isGenuineUser(msg('hi'))).toBe(true)
    expect(isGenuineUser(msg('hi', 'user'))).toBe(true)
    expect(isGenuineUser(msg('hi', 'plugin'))).toBe(false)
    expect(isGenuineUser({ content: [{ type: 'image' }], source: undefined })).toBe(false)
  })

  it('review fires on a window containing a genuine user message, window returned', () => {
    const cursor = { count: 0, tail: '' }
    const decision = reviewWindow([msg('assistant line'), msg('new user prompt')], cursor)
    expect(decision.action).toBe('review')
    if (decision.action === 'review') expect(decision.window).toHaveLength(2)
  })

  it('injected kinds are dropped from an otherwise-reviewable window', () => {
    const cursor = { count: 0, tail: '' }
    const decision = reviewWindow(
      [msg('real user prompt'), msg('recalled body', 'memory')],
      cursor,
    )
    expect(decision.action).toBe('review')
    if (decision.action === 'review') expect(decision.window).toHaveLength(1)
  })

  it('rewritten history (compaction/rewind) resets and skips', () => {
    const original = [msg('a'), msg('b'), msg('c')]
    const cursor = fullCursor(original)
    const decision = reviewWindow([msg('compacted')], cursor)
    expect(decision.action).toBe('reset')
  })

  it('history shrank below the cursor count resets too', () => {
    const cursor = fullCursor([msg('a'), msg('b'), msg('c')])
    expect(reviewWindow([msg('a')], cursor).action).toBe('reset')
  })

  it('a grown snapshot with matching anchor reviews only the new tail', () => {
    const prefix = [msg('a'), msg('b')]
    const cursor = fullCursor(prefix)
    const decision = reviewWindow([...prefix, msg('new user prompt')], cursor)
    expect(decision.action).toBe('review')
    if (decision.action === 'review') expect(decision.window).toEqual([msg('new user prompt')])
  })
})

describe('renderDelta (§4.1)', () => {
  it('renders `[role] content` lines newest-tailed', () => {
    const text = renderDelta([msg('first', 'user'), { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }])
    expect(text).toBe('[user] first\n[assistant] reply')
  })

  it('renders tool-call blocks as `[assistant tool_use <name>] <args>`', () => {
    const text = renderDelta([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool-call', name: 'read_file', arguments: '{"path":"a.ts"}' },
      ],
    }])
    expect(text).toBe('[assistant] let me check\n[assistant tool_use read_file] {"path":"a.ts"}')
  })

  it('renders tool-result block text content', () => {
    const text = renderDelta([{
      role: 'tool',
      content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file body' }] }],
    }])
    expect(text).toBe('file body')
  })

  it('truncates tool-call args at 2000 bytes', () => {
    const args = JSON.stringify({ blob: 'x'.repeat(MAX_TOOL_ARGS_BYTES + 500) })
    const text = renderDelta([{
      role: 'assistant',
      content: [{ type: 'tool-call', name: 'write', arguments: args }],
    }])
    expect(text).toContain('[assistant tool_use write] ')
    expect(text.endsWith('…')).toBe(true)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_ARGS_BYTES + 80)
  })

  it('over the cap drops OLDEST lines and prepends the marker', () => {
    const big = 'x'.repeat(MAX_DELTA_BYTES)
    const window = [msg('drop-me-old', 'user'), { role: 'assistant', content: [{ type: 'text', text: big }] }]
    const text = renderDelta(window)
    expect(text.startsWith('[truncated ')).toBe(true)
    expect(text).not.toContain('drop-me-old')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_DELTA_BYTES + 40)
  })

  it('under the cap renders verbatim', () => {
    expect(renderDelta([msg('tiny')])).toBe('[user] tiny')
  })
})
