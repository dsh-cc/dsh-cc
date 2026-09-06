/**
 * Syntax highlighting for fenced code blocks. highlight.js (common-languages
 * subset, pinned ^11) tokenizes source into an HTML string of
 * `<span class="hljs-...">` elements; a tiny stack-based walker converts that
 * HTML into ANSI-styled lines. Styles never bleed across rows: every SGR
 * opener is closed at the line end and reopened on the next line. Unknown or
 * unsupported languages fall back to the unstyled source split by newlines.
 *
 * We import `highlight.js/lib/common` (not the full 190-language bundle) — it
 * ships ~36 common languages and resolves cleanly under the repo's ESM
 * `moduleResolution: bundler` tsconfig (the package's `exports` map points the
 * `./lib/common` subpath at the ESM build with sibling `.d.ts` files).
 * @module @dsh-cc/tui/components/code-theme
 */

import hljs from 'highlight.js/lib/common'
import { defaultTheme, type Theme } from './theme.ts'

/** ANSI style applied to a text run, or undefined for unstyled. */
type AnsiStyle = (text: string) => string

/**
 * Map of highlight.js scope (the class name with the `hljs-` prefix stripped)
 * to an SGR style, derived from the injected theme. Kept intentionally small —
 * this is a terminal, not an IDE. Unmapped scopes render unstyled.
 */
function styleByScope(theme: Theme): Record<string, AnsiStyle> {
  return {
    keyword: theme.warning,
    literal: theme.accent,
    number: theme.accent,
    // No dedicated string color → strings fall back to the accent.
    string: theme.accent,
    comment: theme.muted,
    title: theme.bold,
    function: theme.bold,
    'function_': theme.bold,
    'title.function_': theme.bold,
    built_in: theme.accent,
    attr: theme.italic,
    attribute: theme.italic,
    type: theme.accent,
    class: theme.bold,
    meta: theme.italic,
    regexp: theme.accent,
    variable: theme.italic,
  }
}

/** Decode the HTML entities highlight.js emits back to raw source characters. */
function decodeEntities(s: string): string {
  // `&amp;` MUST be decoded last so a literal `&amp;` in source (emitted as
  // `&amp;amp;`) round-trips correctly; a single-pass global replace does not
  // re-scan replaced text, so this is safe.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** Resolve the innermost open span to an SGR style (undefined = unstyled). */
function styleForStackTop(stack: readonly string[], styles: Record<string, AnsiStyle>): AnsiStyle | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const attr = stack[i]
    if (!attr) continue
    for (const part of attr.split(/\s+/)) {
      const scope = part.startsWith('hljs-') ? part.slice(5) : part
      const style = styles[scope]
      if (style) return style
    }
  }
  return undefined
}

/**
 * Convert highlight.js HTML (only `<span class="hljs-...">`, `</span>`, and
 * entity-escaped text) into ANSI-styled lines. The returned array length
 * always equals the number of source lines; ANSI codes never span lines.
 */
function htmlToAnsiLines(html: string, styles: Record<string, AnsiStyle>): string[] {
  const lines: string[] = []
  let current = ''
  const stack: string[] = []

  // The only `<` characters in hljs output are tag starts; text `<` is `&lt;`.
  const parts = html.split(/(<\/?span\b[^>]*>)/)
  for (const part of parts) {
    if (part === '') continue
    if (part === '</span>') {
      stack.pop()
      continue
    }
    if (part.startsWith('<span')) {
      const m = /class="([^"]*)"/.exec(part)
      stack.push(m ? m[1]! : '')
      continue
    }
    // Text node: decode entities, then split on newlines so each line opens
    // and closes its own SGR codes (no cross-line bleed).
    const text = decodeEntities(part)
    const segs = text.split('\n')
    for (let i = 0; i < segs.length; i++) {
      if (i > 0) {
        lines.push(current)
        current = ''
      }
      const seg = segs[i]
      if (!seg) continue
      const style = styleForStackTop(stack, styles)
      current += style ? style(seg) : seg
    }
  }
  lines.push(current)
  return lines
}

/**
 * Highlight `code` (written in `lang`) and return ANSI-styled lines.
 *
 * - Styles come from the injected `theme` (default: the built-in palette).
 * - Unknown or unsupported `lang` → plain `code.split('\n')` (never throws).
 * - Empty `code` → `['']`.
 * - The returned array length always matches `code.split('\n').length`.
 */
export function highlightCodeAnsi(code: string, lang?: string, theme: Theme = defaultTheme): string[] {
  if (code === '') return ['']
  if (!lang || !hljs.getLanguage(lang)) return code.split('\n')
  try {
    const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
    return htmlToAnsiLines(result.value, styleByScope(theme))
  } catch {
    return code.split('\n')
  }
}
