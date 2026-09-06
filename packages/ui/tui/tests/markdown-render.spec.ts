import { describe, expect, it } from 'vitest'
import {
  TranscriptView,
  TRANSCRIPT_LINE_BUDGET,
} from '@dsh-cc/tui/components/transcript.ts'
import type { TranscriptRow } from '@dsh-cc/tui/store.ts'

describe('markdown transcript rendering', () => {
  it('renders assistant markdown with markers transformed', () => {
    const view = new TranscriptView()
    const md = [
      '# Heading',
      '',
      'This is **bold** and `code`.',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '- item one',
      '- item two',
    ].join('\n')
    view.setRows([{ kind: 'assistant', text: md }])
    const lines = view.render(80)
    const joined = lines.join('\n')

    // Visible content is present.
    expect(joined).toContain('Heading')
    expect(joined).toContain('bold') // from **bold**
    // R2b: fenced ts code now flows through highlightCode, so the `const`
    // keyword and `1` literal carry SGR styling — assert the styled form and
    // a stripped-content fallback rather than the bare source substring.
    expect(joined).toContain('\x1b[33mconst\x1b[0m')
    expect(joined.replace(/\x1b\[[0-9;]*m/g, '')).toContain('const x = 1')
    expect(joined).toContain('item one')
    expect(joined).toContain('item two')

    // Raw markdown markers are transformed away by styling.
    expect(joined).not.toContain('**')
    // Level-1 heading strips the leading "# " prefix.
    expect(joined).not.toContain('# Heading')
  })

  it('renders HTML as literal text without control-sequence corruption', () => {
    const view = new TranscriptView()
    const html = '<div onclick="x">hi</div> <script>alert(1)</script>'
    view.setRows([{ kind: 'assistant', text: html }])
    const lines = view.render(80)
    const joined = lines.join('\n')

    // HTML is literal text — no interpretation, no script execution.
    expect(joined).toContain('alert(1)')
    expect(joined).toContain('<script>')

    // No clear-screen escape sequence leaks from the HTML payload.
    expect(joined).not.toContain('\x1b[2J')
  })

  it('renders a single large assistant row without crashing', () => {
    const view = new TranscriptView()
    const line = 'x'.repeat(20)
    const bigText = `${line}\n`.repeat(5000)
    view.setRows([{ kind: 'assistant', text: bigText }])
    const lines = view.render(80)
    // Render completed without error; content is present.
    expect(lines.length).toBeGreaterThan(0)
  })

  it('clips oldest rows over the line budget and keeps newest content', () => {
    const view = new TranscriptView()
    const rows: TranscriptRow[] = []
    for (let i = 0; i < 2500; i++) {
      rows.push({ kind: 'user', text: `line ${i}`.padEnd(20) })
    }
    view.setRows(rows)
    const lines = view.render(80)
    const joined = lines.join('\n')

    // Clip indicator appears.
    expect(joined).toContain('earlier output hidden')

    // Newest content is still rendered.
    expect(joined).toContain('line 2499')

    // Oldest content was clipped.
    expect(joined).not.toContain('line 0')
  })

  it('reuses child components for unchanged row references', () => {
    const view = new TranscriptView()
    const row1: TranscriptRow = { kind: 'assistant', text: 'first' }
    const row2: TranscriptRow = { kind: 'user', text: 'second' }
    view.setRows([row1, row2])
    const child0 = view.children[0]
    const child1 = view.children[1]

    // Append a new row — row1 and row2 keep their references.
    const row3: TranscriptRow = { kind: 'status', text: 'third' }
    view.setRows([row1, row2, row3])

    // Unchanged prefix children are reused by reference (no constructor re-invoked).
    expect(view.children[0]).toBe(child0)
    expect(view.children[1]).toBe(child1)
    // New row gets a fresh child.
    expect(view.children[2]).not.toBe(child0)
    expect(view.children[2]).not.toBe(child1)
  })

  it(`does not clip at exactly ${TRANSCRIPT_LINE_BUDGET} source lines`, () => {
    const view = new TranscriptView()
    const rows: TranscriptRow[] = []
    for (let i = 0; i < TRANSCRIPT_LINE_BUDGET; i++) {
      rows.push({ kind: 'user', text: `line ${i}` })
    }
    view.setRows(rows)
    const joined = view.render(80).join('\n')
    expect(joined).not.toContain('earlier output hidden')
  })

  it('clips when exceeding the budget boundary by one', () => {
    const view = new TranscriptView()
    const rows: TranscriptRow[] = []
    for (let i = 0; i < TRANSCRIPT_LINE_BUDGET + 1; i++) {
      rows.push({ kind: 'user', text: `line ${i}` })
    }
    view.setRows(rows)
    const joined = view.render(80).join('\n')
    expect(joined).toContain('earlier output hidden')
  })

  it('highlights a fenced ts code block with ANSI-styled keywords via the vendored Markdown', () => {
    const view = new TranscriptView()
    const md = ['```ts', 'const x = 1', '```'].join('\n')
    view.setRows([{ kind: 'assistant', text: md }])
    const joined = view.render(80).join('\n')

    // The keyword SGR (yellow = 33) wraps `const`; the number SGR (cyan = 36) wraps `1`.
    expect(joined).toContain('\x1b[33mconst\x1b[0m')
    expect(joined).toContain('\x1b[36m1\x1b[0m')
    // Raw source is recoverable by stripping ANSI.
    expect(joined.replace(/\x1b\[[0-9;]*m/g, '')).toContain('const x = 1')
  })

  it('renders an unknown-language fence as plain text without keyword SGR', () => {
    const view = new TranscriptView()
    const md = ['```frobnicate', 'const x = 1', '```'].join('\n')
    view.setRows([{ kind: 'assistant', text: md }])
    const joined = view.render(80).join('\n')

    // Plain source line is present verbatim (no SGR splitting the keyword).
    expect(joined).toContain('const x = 1')
    // No keyword SGR was emitted for an unknown language.
    expect(joined).not.toContain('\x1b[33mconst')
  })
})
