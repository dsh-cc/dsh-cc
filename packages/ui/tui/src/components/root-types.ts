/**
 * Public mount contracts for the root pi-tui component, split out of root.ts
 * to keep the factory under the line budget. Deliberately a leaf — must not
 * import root.ts.
 * @module @dsh-cc/tui/components/root-types
 */

import type { Editor, Terminal, TUI, TuiMode } from '@dsh-cc/pi-tui'
import type { ThemeOverrides } from './theme.ts'

export interface BuildRootOptions {
	terminal?: Terminal
	onQuit?: () => void
	/**
	 * 'regular' (default) renders inline into the main screen scrollback;
	 * 'fullscreen' enters the alternate screen on start: the transcript scrolls
	 * inside a primary ScrollView while the dock (queue, todos, overlays,
	 * editor, statusline) stays pinned at the bottom.
	 */
	uiMode?: TuiMode
	/** Fullscreen-only: mouse capture for wheel scrolling and app-owned selection. Default true. */
	mouse?: boolean
	/**
	 * Per-role palette overrides for the terminal theme. Every role accepts a
	 * basic ANSI color name or a raw SGR code string; invalid values keep the
	 * built-in default, so an absent (or partial) override renders exactly like
	 * the historical fixed palette.
	 */
	theme?: ThemeOverrides
}

export interface RootHandle {
	readonly tui: TUI
	readonly editor: Editor
	readonly mode: TuiMode
	destroy(): void
	/**
	 * Stop the surface. In fullscreen mode this leaves the alternate screen
	 * with the final frame preserved, then replays the chrome through a one-shot
	 * main-screen renderer so native scrollback ends up with the same inline
	 * layout a regular session would have produced.
	 */
	stopForExit(): void
}
