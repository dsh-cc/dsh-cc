/**
 * Standalone helpers and constants extracted from the root mount: OS URL
 * opening, active-task text capping, window-title sanitizing, and the
 * double-press quit window.
 * Deliberately a leaf — must not import root.ts.
 * @module @dsh-cc/tui/components/root-utils
 */

import { spawn } from 'node:child_process'

/** How long after the first idle Ctrl+C a second press still quits (ms). */
export const DOUBLE_PRESS_WINDOW_MS = 2000

/** Cap the active-task text shown in the todo strip (ellipsis past the cap). */
const TODO_ACTIVE_CAP = 60

export function truncateActive(content: string): string {
	return content.length > TODO_ACTIVE_CAP ? `${content.slice(0, TODO_ACTIVE_CAP - 1)}…` : content
}

/** Cap the terminal window title (chars, post-sanitize). */
const WINDOW_TITLE_CAP = 120

// C0 controls (ESC/BEL included — they terminate or inject OSC sequences),
// DEL, and C1 controls. The session-title service already normalizes; this
// is defense-in-depth on an LLM-derived string crossing into the terminal.
// eslint-disable-next-line no-control-regex
const WINDOW_TITLE_CONTROL_CHARS = /[\x00-\x1f\x7f\x80-\x9f]/g

/**
 * Make a string safe for an OSC 0 window-title write: strip control
 * characters, trim, cap the length, and fall back to 'dsh-cc' when nothing
 * printable remains.
 */
export function sanitizeWindowTitle(title: string): string {
	const cleaned = title.replace(WINDOW_TITLE_CONTROL_CHARS, '').trim()
	if (cleaned.length === 0) return 'dsh-cc'
	return cleaned.length > WINDOW_TITLE_CAP ? cleaned.slice(0, WINDOW_TITLE_CAP) : cleaned
}

/**
 * Open an OSC 8 hyperlink with the OS handler. Fullscreen mouse capture takes
 * over the terminal's native link activation, so clicks are routed here.
 */
export function openSystemUrl(url: string): void {
	const child = process.platform === 'win32'
		? spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
		: spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
	child.on('error', () => {})
	child.unref()
}
