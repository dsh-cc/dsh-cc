import { describe, expect, it } from 'vitest'
import { rowsToMarkdown } from '@dsh-cc/tui/export-markdown.ts'
import { whaleBannerArt } from '@dsh-cc/tui/harness/boot-banner.ts'
import type { TranscriptRow } from '@dsh-cc/tui/store.ts'

/** Drop the phantom empty element a trailing newline produces on split. */
function lines(text: string): string[] {
  const parts = text.split('\n')
  return parts.at(-1) === '' ? parts.slice(0, -1) : parts
}

describe('rowsToMarkdown', () => {
  it('renders an empty transcript as an empty document', () => {
    expect(rowsToMarkdown([])).toBe('')
  })

  it('renders user rows as blockquotes (one `> ` per source line)', () => {
    const md = rowsToMarkdown([{ kind: 'user', text: 'Fix the bug' }])
    expect(md).toBe('> Fix the bug\n')
  })

  it('keeps multi-line user text inside one blockquote', () => {
    const md = rowsToMarkdown([{ kind: 'user', text: 'line one\nline two' }])
    expect(md).toBe('> line one\n> line two\n')
  })

  it('renders assistant rows verbatim', () => {
    const md = rowsToMarkdown([{ kind: 'assistant', text: 'Done — all tests pass.' }])
    expect(md).toBe('Done — all tests pass.\n')
  })

  it('folds thinking rows into a collapsed <details> block', () => {
    const md = rowsToMarkdown([{ kind: 'thinking', text: 'weighing options' }])
    expect(md).toBe(
      '<details>\n<summary>thinking</summary>\n\nweighing options\n\n</details>\n',
    )
  })

  it('renders a running tool row as a `tool <name>` fence with the running marker', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Bash',
      args: '{"command":"ls"}',
      title: 'Bash',
      running: true,
    }])
    expect(md).toBe('```tool Bash\n…running\n```\n')
  })

  it('renders a finished tool row without a result with the running marker', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Read',
      args: '',
      title: 'Read',
      running: false,
    }])
    expect(md).toBe('```tool Read\n…running\n```\n')
  })

  it('renders a finished tool row with a result inside the fence', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Bash',
      args: '',
      title: 'Bash',
      running: false,
      result: 'total 0',
    }])
    expect(md).toBe('```tool Bash\ntotal 0\n```\n')
  })

  it('renders an explicit empty result as an empty fence (no running marker)', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Bash',
      args: '',
      title: 'Bash',
      running: false,
      result: '',
    }])
    expect(md).toBe('```tool Bash\n\n```\n')
  })

  it('marks an errored tool result with ⚠', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Bash',
      args: '',
      title: 'Bash',
      running: false,
      result: 'boom',
      error: true,
    }])
    expect(md).toBe('```tool Bash\n⚠ boom\n```\n')
  })

  it('renders diffs as a diff fence; oldText null means a new file', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Write',
      args: '',
      title: 'Write',
      running: false,
      diffs: [{ path: 'src/new.ts', oldText: null, newText: 'const a = 1\nconst b = 2\n' }],
    }])
    expect(md).toBe(
      '```diff\n'
      + '--- /dev/null\n'
      + '+++ b/src/new.ts\n'
      + '+const a = 1\n'
      + '+const b = 2\n'
      + '```\n',
    )
  })

  it('renders an edit diff with ---/+++ headers and -/+ body lines', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Edit',
      args: '',
      title: 'Edit',
      running: false,
      diffs: [{
        path: 'f.txt',
        oldText: 'old line\nshared\n',
        newText: 'new line\nshared\n',
      }],
    }])
    expect(md).toBe(
      '```diff\n'
      + '--- a/f.txt\n'
      + '+++ b/f.txt\n'
      + '-old line\n'
      + '-shared\n'
      + '+new line\n'
      + '+shared\n'
      + '```\n',
    )
  })

  it('skips the summary fence for a finished diff-only row (no bogus running marker)', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Edit',
      args: '',
      title: 'Edit',
      running: false,
      diffs: [{ path: 'f.txt', oldText: 'a\n', newText: 'b\n' }],
    }])
    expect(md).toBe('```diff\n--- a/f.txt\n+++ b/f.txt\n-a\n+b\n```\n')
  })

  it('renders status rows as italics and error status rows with ⚠', () => {
    const plain = rowsToMarkdown([{ kind: 'status', text: 'Model is now p/m.' }])
    expect(plain).toBe('*Model is now p/m.*\n')
    const failed = rowsToMarkdown([{ kind: 'status', text: 'Turn failed', error: true }])
    expect(failed).toBe('⚠ *Turn failed*\n')
  })

  it('does not double the ⚠ on an error row whose text already carries it', () => {
    const md = rowsToMarkdown([{ kind: 'status', text: '⚠ Turn failed: boom', error: true }])
    expect(md).toBe('*⚠ Turn failed: boom*\n')
  })

  it('skips banner rows (no raw SGR or block glyphs in the document)', () => {
    const md = rowsToMarkdown([
      { kind: 'banner', text: whaleBannerArt() },
      { kind: 'status', text: 'dsh cc-mode — m · /cwd · /tui-help for keys' },
    ])
    expect(md).toContain('dsh cc-mode')
    expect(md).not.toContain('█')
    expect(md).not.toContain('▀')
    expect(md).not.toContain('\x1b[')
  })

  it('joins blocks with blank lines and ends the document with one newline', () => {
    const rows: TranscriptRow[] = [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
      { kind: 'status', text: 'done' },
    ]
    const md = rowsToMarkdown(rows)
    const blocks = md.trimEnd().split('\n\n')
    expect(blocks).toEqual(['> hi', 'hello', '*done*'])
    expect(md.endsWith('\n') && !md.endsWith('\n\n')).toBe(true)
  })

  it('never emits a stray -/+ marker for a trailing newline in diff texts', () => {
    const md = rowsToMarkdown([{
      kind: 'tool',
      callId: 'c1',
      name: 'Write',
      args: '',
      title: 'Write',
      running: false,
      diffs: [{ path: 'f.txt', oldText: 'a\n', newText: 'a\nb\n' }],
    }])
    expect(md.split('\n').filter(line => line === '-')).toEqual([])
    // Full old text as minus lines, then the new text as plus lines — no
    // phantom marker for the trailing newline of either side.
    expect(md).toContain('-a\n+a\n+b')
    expect(lines('x\n')).toEqual(['x'])
  })
})

describe('compact rows', () => {
  it('exports a compact row as an italic one-liner plus a details summary block', () => {
    const md = rowsToMarkdown([{
      kind: 'compact',
      trigger: 'manual',
      items: 328,
      tokens: 119542,
      summary: '## Primary Request\n- foo',
    }])
    expect(md).toBe(
      '*Compacted 328 messages (~119542 tokens)*\n\n'
      + '<details>\n<summary>compacted summary</summary>\n\n'
      + '## Primary Request\n- foo\n\n</details>\n',
    )
  })

  it('prefixes Auto-compacted for the auto trigger', () => {
    const md = rowsToMarkdown([{ kind: 'compact', trigger: 'auto', items: 4, tokens: 500, summary: '' }])
    expect(md).toBe('*Auto-compacted 4 messages (~500 tokens)*\n')
  })
})
