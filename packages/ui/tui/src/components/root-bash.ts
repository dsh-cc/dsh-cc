/**
 * `!` shell-mode behavior for the root pi-tui mount, factored out of
 * components/root.ts so that file stays under its line budget.
 *
 * Shell mode is derived, not stored: the composer is in shell mode exactly
 * while its text starts with `!`. The border switches to the warning role
 * so the mode is visible, ↑/↓ browse the bash-only history stack, and Esc
 * exits the mode ahead of the generic busy-interrupt branch (the ordering
 * in root.ts's input listener is deliberate). Paste normalization lives at
 * the driver's submit — a `!`-prefixed line runs locally no matter how it
 * got into the buffer.
 * @module @dsh-cc/tui/components/root-bash
 */

import type { Editor, TUI } from '@dsh-cc/pi-tui'
import type { Theme } from './theme.ts'
import type { Driver } from '../state/driver-types.ts'
import { parseSlash } from '../slash.ts'

export interface AttachBashModeArgs {
	editor: Editor
	driver: Driver
	tui: TUI
	theme: Theme
}

export interface BashModeHandle {
  /** True while a `!` command is in flight; the composer is disabled. */
  bashRunning(): boolean
  inShellMode(): boolean
  browseBashHistory(towardsOlder: boolean): void
  resetBashHistoryBrowsing(): void
}

/**
 * Install the `!` shell-mode state and the editor change/submit hooks that
 * drive it. Owns the bash-history browsing stack; assigns editor.onChange /
 * editor.onSubmit exactly as root.ts did inline, so behavior is unchanged.
 */
export function attachBashMode(args: AttachBashModeArgs): BashModeHandle {
  const { editor, driver, tui, theme } = args

  let bashBrowsing = false
  let bashBrowsingIndex = -1
  let bashDraft = ''
  let bashRecallApplied = false
  let bashRunning = false

  const inShellMode = (): boolean => editor.getText().startsWith('!')

  const resetBashHistoryBrowsing = (): void => {
    bashBrowsing = false
    bashBrowsingIndex = -1
    bashDraft = ''
  }

  /**
   * Browse the bash history stack (driver-owned, newest-first). ↑ walks
   * toward older entries; ↓ walks back and restores the pre-browsing draft
   * past the newest. Recalled entries are re-prefixed with `!` so the buffer
   * stays shell-shaped and Enter re-runs them through the same submit path.
   */
  const browseBashHistory = (towardsOlder: boolean): void => {
    const entries = driver.bashHistory
    if (entries.length === 0) return
    if (!bashBrowsing) {
      bashBrowsing = true
      bashBrowsingIndex = -1
      bashDraft = editor.getText()
    }
    if (towardsOlder) {
      if (bashBrowsingIndex + 1 >= entries.length) return // clamped at the oldest
      bashBrowsingIndex += 1
    } else {
      bashBrowsingIndex -= 1
      if (bashBrowsingIndex < 0) {
        // Down past the newest entry: restore the pre-browsing draft.
        const draft = bashDraft
        resetBashHistoryBrowsing()
        bashRecallApplied = true
        editor.setText(draft)
        bashRecallApplied = false
        return
      }
    }
    bashRecallApplied = true
    editor.setText(`!${entries[bashBrowsingIndex]}`)
    bashRecallApplied = false
  }

  // Mirror the shell-mode border on every buffer change: the warning role
  // while the buffer holds a `!`-prefixed line, the accent role otherwise.
  const syncShellModeBorder = (): void => {
    const styler = inShellMode() ? theme.warning : theme.accent
    if (editor.borderColor !== styler) {
      editor.borderColor = styler
      tui.requestRender()
    }
  }

  editor.onChange = (text: string): void => {
    driver.setDraft(text)
    syncShellModeBorder()
    // Any buffer change that was not a bash recall ends history browsing,
    // so the next ↑ starts fresh (mirrors the editor's own navigation).
    if (!bashRecallApplied) resetBashHistoryBrowsing()
  }
  editor.onSubmit = (text: string): void => {
    if (text.startsWith('!')) {
      // Shell command: never a composer prompt. While the driver runs it,
      // the composer is disabled — the input listener swallows every key
      // until submit settles (bounded by the command's own timeout).
      resetBashHistoryBrowsing()
      bashRunning = true
      void driver.submit(text)
        .catch(() => {})
        .then(() => {
          bashRunning = false
          tui.requestRender()
        })
      return
    }
    const parsed = parseSlash(text)
    // Only prompts join editor recall; slash commands are not prompts.
    if (parsed.kind === 'none') editor.addToHistory(text)
    // Submit is fire-and-forget. Quit/exit finalization — including the
    // /quit worktree-exit confirmation — is owned by the driver's quit path
    // (config.onQuit), not by the onSubmit special-case it used to have here.
    void driver.submit(text)
  }

  return { bashRunning: () => bashRunning, inShellMode, browseBashHistory, resetBashHistoryBrowsing }
}
