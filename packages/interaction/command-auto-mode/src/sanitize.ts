/**
 * Strip control characters (C0 except `\n`/`\t`, DEL, C1) from session/settings
 * text before it is rendered into command output. Slash-command text is shown
 * verbatim in the TUI, so settings-carried prose must never smuggle ANSI
 * escapes or terminal control sequences. Shared with the S5 `/auto-mode
 * review` surface.
 * @module @dsh-cc/command-auto-mode/sanitize
 */

export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, '')
}
