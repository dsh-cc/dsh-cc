/**
 * Tiny SGR (Select Graphic Rendition) helpers and the configurable theme
 * palette. No chalk — just raw ANSI codes embedded in Text content, which
 * pi-tui's Text component preserves through word-wrap.
 *
 * {@link createTheme} derives the full theme from optional per-role overrides
 * ({@link ThemeOverrides}). An override value is either a basic ANSI color
 * name (`'red'`, `'brightCyan'`) or a raw SGR parameter string (`'31'`,
 * `'1;31'`, `'38;5;208'`); unknown names and malformed codes silently fall
 * back to the built-in default. The default palette is byte-identical to the
 * historical fixed palette, so an absent config changes nothing on screen.
 * @module @dsh-cc/tui/components/theme
 */

import type { EditorTheme } from '@dsh-cc/pi-tui'

/** Wrap text in an SGR sequence. */
export const sgr =
  (code: string) =>
  (text: string): string =>
    `\x1b[${code}m${text}\x1b[0m`

/** A function that wraps text in an SGR style. */
export type Styler = (text: string) => string

/** Fixed attribute stylers — part of the theme but not user-configurable. */
export const bold = sgr('1')
export const italic = sgr('3')
export const underline = sgr('4')
export const strikethrough = sgr('9')

/**
 * Per-role palette overrides. Every role is optional; `undefined` and invalid
 * values keep the built-in default for that role.
 */
export interface ThemeOverrides {
  /** Primary interactive accent (default: cyan). */
  accent?: string
  /** Success and addition color (default: green). */
  success?: string
  /** Error and removal color (default: red). */
  error?: string
  /** Warning and attention color (default: yellow). */
  warning?: string
  /** De-emphasized text (default: the faint SGR attribute). */
  muted?: string
  /** Secondary accent for special highlights (default: magenta). */
  highlight?: string
}

/** The resolved palette handed down the component tree. */
export interface Theme {
  accent: Styler
  success: Styler
  error: Styler
  warning: Styler
  muted: Styler
  highlight: Styler
  bold: Styler
  italic: Styler
  underline: Styler
  strikethrough: Styler
}

/**
 * Basic ANSI color names accepted by {@link ThemeOverrides} — the eight base
 * colors plus their bright variants (with `gray`/`grey` aliases). Anything
 * outside this table is treated as a raw SGR code string.
 */
const SGR_BY_COLOR_NAME: Record<string, string> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  brightBlack: '90',
  gray: '90',
  grey: '90',
  brightRed: '91',
  brightGreen: '92',
  brightYellow: '93',
  brightBlue: '94',
  brightMagenta: '95',
  brightCyan: '96',
  brightWhite: '97',
}

/** Raw SGR parameter string: `;`-separated non-negative integers. */
const SGR_CODE_PATTERN = /^\d+(;\d+)*$/

/** Resolve one override value to an SGR parameter string, or the fallback. */
function resolveSgr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const named = SGR_BY_COLOR_NAME[value]
  if (named !== undefined) return named
  if (SGR_CODE_PATTERN.test(value)) return value
  return fallback
}

/** Built-in default SGR code per configurable role (the historical palette). */
const DEFAULT_SGR_BY_ROLE: Record<keyof ThemeOverrides, string> = {
  accent: '36',
  success: '32',
  error: '31',
  warning: '33',
  muted: '2',
  highlight: '35',
}

/** Build a theme from optional overrides; invalid values keep the default. */
export function createTheme(overrides?: ThemeOverrides): Theme {
  const role = (name: keyof ThemeOverrides): Styler =>
    sgr(resolveSgr(overrides?.[name], DEFAULT_SGR_BY_ROLE[name]))
  return {
    accent: role('accent'),
    success: role('success'),
    error: role('error'),
    warning: role('warning'),
    muted: role('muted'),
    highlight: role('highlight'),
    bold,
    italic,
    underline,
    strikethrough,
  }
}

/** The built-in default theme — byte-identical to the historical fixed palette. */
export const defaultTheme: Theme = createTheme()

/** Derive the pi-tui editor theme from a palette: accent focus, muted rest. */
export function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: theme.accent,
    selectList: {
      selectedPrefix: () => '> ',
      selectedText: theme.accent,
      description: theme.muted,
      scrollInfo: theme.muted,
      noMatch: theme.muted,
    },
  }
}
