import { describe, expect, it } from 'vitest'
import { Config } from '@dsh-cc/tui'
import { highlightCodeAnsi } from '@dsh-cc/tui/components/code-theme.ts'
import { renderDiffLines } from '@dsh-cc/tui/components/diff-card.ts'
import { createMarkdownTheme } from '@dsh-cc/tui/components/markdown-theme.ts'
import { TranscriptView, renderRowText } from '@dsh-cc/tui/components/transcript.ts'
import {
  createEditorTheme,
  createTheme,
  defaultTheme,
  type ThemeOverrides,
} from '@dsh-cc/tui/components/theme.ts'

describe('createTheme defaults', () => {
  it('matches the historical fixed palette role by role', () => {
    // The six configurable roles map onto the previous fixed palette:
    // accent=cyan, success=green, error=red, warning=yellow, muted=faint
    // (the old `dim`), highlight=magenta.
    expect(defaultTheme.accent('x')).toBe('\x1b[36mx\x1b[0m')
    expect(defaultTheme.success('x')).toBe('\x1b[32mx\x1b[0m')
    expect(defaultTheme.error('x')).toBe('\x1b[31mx\x1b[0m')
    expect(defaultTheme.warning('x')).toBe('\x1b[33mx\x1b[0m')
    expect(defaultTheme.muted('x')).toBe('\x1b[2mx\x1b[0m')
    expect(defaultTheme.highlight('x')).toBe('\x1b[35mx\x1b[0m')
    // Attribute stylers are fixed and carried on the theme too.
    expect(defaultTheme.bold('x')).toBe('\x1b[1mx\x1b[0m')
    expect(defaultTheme.italic('x')).toBe('\x1b[3mx\x1b[0m')
    expect(defaultTheme.underline('x')).toBe('\x1b[4mx\x1b[0m')
    expect(defaultTheme.strikethrough('x')).toBe('\x1b[9mx\x1b[0m')
  })

  it('builds the identical palette from no argument or an empty override', () => {
    for (const built of [createTheme(), createTheme(undefined), createTheme({})]) {
      expect(built.accent('x')).toBe(defaultTheme.accent('x'))
      expect(built.success('x')).toBe(defaultTheme.success('x'))
      expect(built.error('x')).toBe(defaultTheme.error('x'))
      expect(built.warning('x')).toBe(defaultTheme.warning('x'))
      expect(built.muted('x')).toBe(defaultTheme.muted('x'))
      expect(built.highlight('x')).toBe(defaultTheme.highlight('x'))
    }
  })

  it('derives the editor theme from the palette (accent focus, muted rest)', () => {
    const editor = createEditorTheme(defaultTheme)
    expect(editor.borderColor('x')).toBe('\x1b[36mx\x1b[0m')
    expect(editor.selectList.selectedPrefix('x')).toBe('> ')
    expect(editor.selectList.selectedText('x')).toBe('\x1b[36mx\x1b[0m')
    expect(editor.selectList.description('x')).toBe('\x1b[2mx\x1b[0m')
    expect(editor.selectList.scrollInfo('x')).toBe('\x1b[2mx\x1b[0m')
    expect(editor.selectList.noMatch('x')).toBe('\x1b[2mx\x1b[0m')
  })
})

describe('createTheme overrides', () => {
  it('accepts basic ANSI color names per role', () => {
    expect(createTheme({ accent: 'red' }).accent('x')).toBe('\x1b[31mx\x1b[0m')
    expect(createTheme({ error: 'brightRed' }).error('x')).toBe('\x1b[91mx\x1b[0m')
    expect(createTheme({ muted: 'gray' }).muted('x')).toBe('\x1b[90mx\x1b[0m')
  })

  it('accepts raw SGR code strings per role', () => {
    expect(createTheme({ accent: '91' }).accent('x')).toBe('\x1b[91mx\x1b[0m')
    expect(createTheme({ error: '1;31' }).error('x')).toBe('\x1b[1;31mx\x1b[0m')
    expect(createTheme({ highlight: '38;5;208' }).highlight('x')).toBe('\x1b[38;5;208mx\x1b[0m')
  })

  it('leaves every other role at its default when one is overridden', () => {
    const theme = createTheme({ warning: '95' })
    expect(theme.warning('x')).toBe('\x1b[95mx\x1b[0m')
    expect(theme.accent('x')).toBe(defaultTheme.accent('x'))
    expect(theme.success('x')).toBe(defaultTheme.success('x'))
    expect(theme.error('x')).toBe(defaultTheme.error('x'))
    expect(theme.muted('x')).toBe(defaultTheme.muted('x'))
    expect(theme.highlight('x')).toBe(defaultTheme.highlight('x'))
  })

  it('overrides all six roles at once', () => {
    const overrides: ThemeOverrides = {
      accent: '91',
      success: '92',
      error: '93',
      warning: '94',
      muted: '95',
      highlight: '96',
    }
    const theme = createTheme(overrides)
    expect(theme.accent('x')).toBe('\x1b[91mx\x1b[0m')
    expect(theme.success('x')).toBe('\x1b[92mx\x1b[0m')
    expect(theme.error('x')).toBe('\x1b[93mx\x1b[0m')
    expect(theme.warning('x')).toBe('\x1b[94mx\x1b[0m')
    expect(theme.muted('x')).toBe('\x1b[95mx\x1b[0m')
    expect(theme.highlight('x')).toBe('\x1b[96mx\x1b[0m')
  })

  it('derives the editor theme from overridden roles', () => {
    const editor = createEditorTheme(createTheme({ accent: 'red', muted: '90' }))
    expect(editor.borderColor('x')).toBe('\x1b[31mx\x1b[0m')
    expect(editor.selectList.selectedText('x')).toBe('\x1b[31mx\x1b[0m')
    expect(editor.selectList.description('x')).toBe('\x1b[90mx\x1b[0m')
  })
})

describe('createTheme invalid overrides fall back to defaults', () => {
  it('falls back per role on an unknown color name', () => {
    expect(createTheme({ accent: 'chartreuse' }).accent('x')).toBe(defaultTheme.accent('x'))
  })

  it('falls back on empty or malformed SGR code strings', () => {
    expect(createTheme({ error: '' }).error('x')).toBe(defaultTheme.error('x'))
    expect(createTheme({ error: 'abc;31' }).error('x')).toBe(defaultTheme.error('x'))
    expect(createTheme({ error: '31;abc' }).error('x')).toBe(defaultTheme.error('x'))
    expect(createTheme({ error: '-1' }).error('x')).toBe(defaultTheme.error('x'))
    expect(createTheme({ error: ' ' }).error('x')).toBe(defaultTheme.error('x'))
  })

  it('falls back when a value is not a string (defensive)', () => {
    expect(createTheme({ accent: 42 as never }).accent('x')).toBe(defaultTheme.accent('x'))
  })

  it('keeps valid roles while falling back on the invalid ones', () => {
    const theme = createTheme({ accent: 'red', muted: 'nope' })
    expect(theme.accent('x')).toBe('\x1b[31mx\x1b[0m')
    expect(theme.muted('x')).toBe(defaultTheme.muted('x'))
  })
})

describe('theme injection through the render components', () => {
  it('styles code keywords with the overridden warning role', () => {
    const lines = highlightCodeAnsi('const x = 1', 'typescript', createTheme({ warning: '95' }))
    expect(lines[0]).toContain('\x1b[95mconst\x1b[0m')
  })

  it('keeps default code highlighting byte-identical without a theme', () => {
    const lines = highlightCodeAnsi('const x = 1', 'typescript')
    expect(lines[0]).toContain('\x1b[33mconst\x1b[0m')
    expect(lines[0]).toContain('\x1b[36m1\x1b[0m')
  })

  it('renders a user row with the overridden accent', () => {
    const row = { kind: 'user' as const, text: 'hi' }
    expect(renderRowText(row, undefined, createTheme({ accent: '31' }))).toBe('\x1b[31m> hi\x1b[0m')
  })

  it('keeps the default row rendering byte-identical without a theme', () => {
    expect(renderRowText({ kind: 'user' as const, text: 'hi' })).toBe('\x1b[36m> hi\x1b[0m')
    expect(renderRowText({ kind: 'status' as const, text: 'done' })).toBe('\x1b[2mdone\x1b[0m')
  })

  it('colors diff additions with the overridden success role', () => {
    const lines = renderDiffLines(
      [{ path: 'a.txt', oldText: null, newText: 'foo' }],
      undefined,
      createTheme({ success: '92' }),
    )
    expect(lines.some(line => line.includes('\x1b[92m+ foo\x1b[0m'))).toBe(true)
  })

  it('keeps default diff rendering byte-identical without a theme', () => {
    const lines = renderDiffLines([{ path: 'a.txt', oldText: null, newText: 'foo' }])
    expect(lines.some(line => line.includes('\x1b[32m+ foo\x1b[0m'))).toBe(true)
  })

  it('maps markdown link styling to the overridden accent', () => {
    const mdTheme = createMarkdownTheme(createTheme({ accent: '31' }))
    expect(mdTheme.link('x')).toBe('\x1b[31mx\x1b[0m')
  })

  it('styles a transcript status row with the injected muted role', () => {
    const view = new TranscriptView(createTheme({ muted: '90' }))
    view.setRows([{ kind: 'status', text: 'done' }])
    expect(view.render(80).join('\n')).toContain('\x1b[90mdone\x1b[0m')
  })

  it('keeps a default TranscriptView byte-identical without a theme', () => {
    const view = new TranscriptView()
    view.setRows([{ kind: 'status', text: 'done' }])
    expect(view.render(80).join('\n')).toContain('\x1b[2mdone\x1b[0m')
  })
})

describe('theme plugin config schema', () => {
  it('parses a full theme block', () => {
    const parsed = Config({
      theme: {
        accent: 'red',
        success: 'green',
        error: 'blue',
        warning: 'magenta',
        muted: 'gray',
        highlight: 'cyan',
      },
    })
    expect(parsed.theme).toEqual({
      accent: 'red',
      success: 'green',
      error: 'blue',
      warning: 'magenta',
      muted: 'gray',
      highlight: 'cyan',
    })
  })

  it('parses a partial theme block, dropping unset roles', () => {
    expect(Config({ theme: { error: 'brightRed' } }).theme).toEqual({ error: 'brightRed' })
    expect(Config({ theme: {} }).theme).toEqual({})
  })

  it('yields an empty override (all defaults) when theme is unset', () => {
    expect(Config({}).theme).toEqual({})
  })
})
