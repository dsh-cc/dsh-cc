/**
 * Reset a pi-tui Editor's ↑/↓ prompt-recall stack from the dsh-cc TUI layer.
 *
 * pi-tui is vendored byte-pure (packages/ui/pi-tui/PORTING.md: re-vendoring
 * replaces `src/` wholesale, so local edits — like a `setHistory` method —
 * would be destroyed and are not allowed). The reset therefore reaches the
 * editor's private slots (`history`, `historyIndex`, `historyDraft`) through
 * a runtime cast instead; `addToHistory` (public) does the refilling so its
 * trim/dedup/cap rules still apply. These field names are stable across the
 * vendored line — re-vendoring to a new upstream SHA must re-check this
 * seam.
 *
 * @module @dsh-cc/tui/components/editor-history
 */

import type { Editor } from '@dsh-cc/pi-tui'

/** Runtime view of the Editor's private recall-browsing slots. */
interface EditorHistorySlots {
  history: string[]
  historyIndex: number
  historyDraft: unknown
}

/**
 * Replace the editor's recall stack wholesale (entries oldest-first,
 * matching the persisted order) and cancel any in-progress browsing. Used
 * when a session switch rebinds prompt history onto another project's
 * bucket.
 */
export function resetEditorHistory(editor: Editor, entries: readonly string[]): void {
  const slots = editor as unknown as EditorHistorySlots
  slots.history = []
  for (const entry of entries) editor.addToHistory(entry)
  slots.historyIndex = -1
  slots.historyDraft = null
}
