/**
 * Markdown theme derived from the injected TUI palette. Assistant rows pass
 * through the vendored Markdown component with this theme; fenced code blocks
 * are syntax-highlighted via the `highlightCode` seam (see `code-theme.ts`).
 * @module @dsh-cc/tui/components/markdown-theme
 */

import type { MarkdownTheme } from '@dsh-cc/pi-tui'
import { highlightCodeAnsi } from './code-theme.ts'
import { defaultTheme, type Theme } from './theme.ts'

/** Map a theme onto the vendored Markdown component's style hooks. */
export function createMarkdownTheme(theme: Theme = defaultTheme): MarkdownTheme {
  return {
    heading: theme.bold,
    link: theme.accent,
    linkUrl: (text: string) => theme.muted(theme.underline(text)),
    code: theme.warning,
    codeBlock: theme.warning,
    codeBlockBorder: theme.muted,
    quote: theme.italic,
    quoteBorder: theme.muted,
    hr: theme.muted,
    listBullet: theme.accent,
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: theme.strikethrough,
    underline: theme.underline,
    highlightCode: (code: string, lang?: string) => highlightCodeAnsi(code, lang, theme),
  }
}
