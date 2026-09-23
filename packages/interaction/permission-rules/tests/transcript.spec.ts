import { describe, expect, it } from 'vitest'
import { foldClassifierContext } from '../src/transcript.ts'

function userEvent(text: string, kind: string | undefined = 'user'): unknown {
  return {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text }],
      ...(kind === undefined ? {} : { source: { kind } }),
    },
  }
}

function toolEvent(name: string, args: unknown): unknown {
  return { type: 'tool/call', data: { name, arguments: args } }
}

describe('foldClassifierContext — userIntent', () => {
  it('folds human messages in order', () => {
    const out = foldClassifierContext(
      [userEvent('first'), userEvent('second'), userEvent('third')] as never[],
      { readOnlyTools: new Set() },
    )
    expect(out.userIntent).toBe('first\nsecond\nthird')
  })

  it('RED (A3): plugin-injected announcements (source.kind plugin) are EXCLUDED', () => {
    const out = foldClassifierContext(
      [userEvent('the real task'), userEvent('permission mode changed to auto', 'plugin')] as never[],
      { readOnlyTools: new Set() },
    )
    expect(out.userIntent).toBe('the real task')
  })

  it('missing source is not human-origin (excluded)', () => {
    const out = foldClassifierContext(
      [{ type: 'user/message', data: { content: [{ type: 'text', text: 'ghost' }] } }] as never[],
      { readOnlyTools: new Set() },
    )
    expect(out.userIntent).toBe('')
  })

  it('first-message pin: 7 messages keep the first plus the last 4, evicting the middle, order preserved', () => {
    const events = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map(t => userEvent(t))
    const out = foldClassifierContext(events as never[], { readOnlyTools: new Set() })
    expect(out.userIntent).toBe('m1\nm4\nm5\nm6\nm7')
  })

  it('per-message cap 400 chars', () => {
    const out = foldClassifierContext([userEvent('x'.repeat(500))] as never[], { readOnlyTools: new Set() })
    expect(out.userIntent.length).toBe(400)
  })

  it('section cap 1536 chars', () => {
    const events = Array.from({ length: 5 }, () => userEvent('y'.repeat(400)))
    const out = foldClassifierContext(events as never[], { readOnlyTools: new Set() })
    expect(out.userIntent.length).toBeLessThanOrEqual(1536)
  })

  it('non-text content blocks are skipped; malformed user events skipped', () => {
    const out = foldClassifierContext(
      [
        { type: 'user/message', data: { content: [{ type: 'image' }] } },
        { type: 'user/message', data: {} },
        { type: 'user/message' },
        'garbage',
        userEvent('real'),
      ] as never[],
      { readOnlyTools: new Set() },
    )
    expect(out.userIntent).toBe('real')
  })
})

describe('foldClassifierContext — toolHistory', () => {
  it('folds non-read-only tool calls as "<name>: <subject>"', () => {
    const out = foldClassifierContext(
      [toolEvent('Bash', { command: 'npm test' }), toolEvent('read', { file_path: 'a.ts' })] as never[],
      { readOnlyTools: new Set(['read']) },
    )
    expect(out.toolHistory).toBe('Bash: npm test')
  })

  it('read-only filtering is alias-normalized via ccToolAliases', () => {
    // 'bash' normalizes through ccToolAliases to Bash.
    const out = foldClassifierContext(
      [toolEvent('bash', { command: 'ls' })] as never[],
      { readOnlyTools: new Set(['Bash']) },
    )
    expect(out.toolHistory).toBe('')
  })

  it('keeps only the last 10 calls', () => {
    const events = Array.from({ length: 12 }, (_, i) => toolEvent('Bash', { command: `cmd-${i}` }))
    const out = foldClassifierContext(events as never[], { readOnlyTools: new Set() })
    const lines = out.toolHistory.split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('Bash: cmd-2')
    expect(lines[9]).toBe('Bash: cmd-11')
  })

  it('subject extractors: file_path, subagent prompt/description, fallback JSON', () => {
    const out = foldClassifierContext(
      [
        toolEvent('edit', { file_path: 'src/x.ts', body: 'huge' }),
        toolEvent('subagent', { description: 'd', prompt: 'do the thing' }),
        toolEvent('web_search', { query: 'q' }),
      ] as never[],
      { readOnlyTools: new Set() },
    )
    expect(out.toolHistory).toBe(
      ['edit: src/x.ts', 'subagent: do the thing', 'web_search: {"query":"q"}'].join('\n'),
    )
  })

  it('subject cap 120 chars; section cap 1536', () => {
    const out = foldClassifierContext([toolEvent('Bash', { command: 'z'.repeat(300) })] as never[], { readOnlyTools: new Set() })
    expect(out.toolHistory.length).toBeLessThanOrEqual(120 + 'Bash: '.length)
    const many = Array.from({ length: 30 }, (_, i) => toolEvent('Bash', { command: `w`.repeat(100) + i }))
    const out2 = foldClassifierContext(many as never[], { readOnlyTools: new Set() })
    expect(out2.toolHistory.length).toBeLessThanOrEqual(1536)
  })

  it('string arguments are parsed; malformed events skipped; never throws', () => {
    const out = foldClassifierContext(
      [
        toolEvent('Bash', '{"command":"echo hi"}'),
        toolEvent('Bash', 'not json at all'),
        { type: 'tool/call', data: {} },
        { type: 'tool/call' },
        null,
        toolEvent('Bash', { command: 'pwd' }),
      ] as never[],
      { readOnlyTools: new Set() },
    )
    expect(out.toolHistory).toBe(['Bash: echo hi', 'Bash: not json at all', 'Bash: pwd'].join('\n'))
  })

  it('empty session ⇒ empty strings', () => {
    expect(foldClassifierContext([], { readOnlyTools: new Set() })).toEqual({ userIntent: '', toolHistory: '' })
  })
})
