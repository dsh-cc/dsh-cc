import { describe, expect, it } from 'vitest'
import {
  formatCallCard,
  formatResultCard,
  type ToolCallView,
  type ToolResultView,
} from '@dsh-cc/tui/tool-card.ts'

describe('formatCallCard', () => {
  it('renders a generic pending card from the title, not the raw JSON args', () => {
    const view: ToolCallView = { card: 'generic', title: 'Read src/index.ts' }
    expect(formatCallCard(view, { name: 'Read', args: '{"path":"src/index.ts"}' })).toEqual({
      title: 'Read src/index.ts',
      body: undefined,
    })
  })

  it('renders a terminal pending card as the command', () => {
    const view: ToolCallView = { card: 'terminal', title: 'ls -la', cwd: '/tmp' }
    expect(formatCallCard(view, { name: 'Bash', args: '{"command":"ls -la"}' })).toEqual({
      title: 'ls -la',
      body: 'cwd /tmp',
    })
  })

  it('renders a diff pending card with a +/− summary', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Write foo.ts',
      diffs: [{ path: 'foo.ts', oldText: 'a\n', newText: 'a\nb\n' }],
    }
    const formatted = formatCallCard(view, { name: 'Write', args: '{}' })
    expect(formatted.title).toBe('Write foo.ts')
    expect(formatted.body).toContain('foo.ts')
    expect(formatted.body).toMatch(/\+/)
  })

  it('falls back to the tool name when no view is supplied', () => {
    expect(formatCallCard(undefined, { name: 'Sleep', args: '{"duration":1}' })).toEqual({
      title: 'Sleep',
      body: '{"duration":1}',
    })
  })
})

describe('formatResultCard', () => {
  it('keeps the pending title for a generic result and uses reformatted content', () => {
    const view: ToolResultView = {
      card: 'generic',
      content: [{ type: 'text', text: '12 lines' }],
    }
    expect(formatResultCard(view, { pendingTitle: 'Read src/index.ts', fallback: 'raw' })).toEqual({
      title: 'Read src/index.ts',
      body: '12 lines',
      error: false,
    })
  })

  it('renders terminal output and an exit-code pill', () => {
    const view: ToolResultView = { card: 'terminal', output: 'ok\n', exitCode: 0 }
    expect(formatResultCard(view, { pendingTitle: 'ls -la', fallback: '' })).toEqual({
      title: 'ls -la',
      body: 'exit 0\nok',
      error: false,
    })
  })

  it('marks a non-zero exit as an error', () => {
    const view: ToolResultView = { card: 'terminal', output: 'nope', exitCode: 1 }
    expect(formatResultCard(view, { pendingTitle: 'false', fallback: '' }).error).toBe(true)
  })

  it('renders applied diffs on completion', () => {
    const view: ToolResultView = {
      card: 'diff',
      title: 'Wrote foo.ts',
      diffs: [{ path: 'foo.ts', oldText: null, newText: 'hello\n' }],
    }
    const formatted = formatResultCard(view, { pendingTitle: 'Write foo.ts', fallback: 'ok' })
    expect(formatted.title).toBe('Wrote foo.ts')
    expect(formatted.body).toContain('foo.ts')
  })

  it('falls back to the raw result text when no view is supplied', () => {
    expect(formatResultCard(undefined, { pendingTitle: 'Sleep', fallback: 'slept' })).toEqual({
      title: 'Sleep',
      body: 'slept',
      error: false,
    })
  })
})
