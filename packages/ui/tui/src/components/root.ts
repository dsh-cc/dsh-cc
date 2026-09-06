/**
 * Root pi-tui mount: regular mode inlines on the main screen; fullscreen mode
 * takes over the alternate screen with a docked layout.
 * @module @dsh-cc/tui/components/root
 */

import {
	Container,
	Editor,
	Key,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
	getKeybindings,
	isKeyRelease,
	type Component,
	type TUI,
	type TuiMode,
} from '@dsh-cc/pi-tui'
import type { Driver } from '../state/driver-types.ts'
import { overlayOpen, renderOverlayChildren, routeOverlayInput } from './overlay-host.ts'
import { todoSummary } from '../store.ts'
import { formatWorkingLine } from '../working-line.ts'
import { buildArgCompleters } from './arg-completers.ts'
import { attachBashMode } from './root-bash.ts'
import { resetEditorHistory } from './editor-history.ts'
import { TuiAutocompleteProvider } from './completion.ts'
import { DOUBLE_PRESS_WINDOW_MS, openSystemUrl, sanitizeWindowTitle, truncateActive } from './root-utils.ts'
import { createEditorTheme, createTheme } from './theme.ts'
import { TranscriptView } from './transcript.ts'
import { WorkingLine } from './working-line.ts'

import type { BuildRootOptions, RootHandle } from './root-types.ts'

export type { BuildRootOptions, RootHandle }

/**
 * Build the pi-tui render tree.
 *
 * Children order: title · transcript · queue chips · todo strip · notice ·
 * [approval] · [question] · working line · editor · statusline. The transcript and overlays
 * rebuild on every driver emit; the editor is persistent so it retains focus
 * and cursor state across renders.
 *
 * In regular mode the children render inline into the main screen. In
 * fullscreen mode the TUI enters the alternate screen: the title and transcript
 * scroll inside a primary ScrollView while the remaining chrome docks at the
 * bottom (the dock keeps its intrinsic height and yields rows first under
 * pressure, with the editor never squeezed below 1 row and the statusline
 * never below 1).
 */
export function buildRoot(driver: Driver, opts: BuildRootOptions = {}): RootHandle {
	const terminal = opts.terminal ?? new ProcessTerminal()
	const mode: TuiMode = opts.uiMode ?? 'regular'
	const theme = createTheme(opts.theme)
	const tui: TUI = mode === 'fullscreen'
		? new TuiAltScreen(terminal, undefined, undefined, {
			mouse: opts.mouse ?? true,
			openUrl: openSystemUrl,
		})
		: new TuiMainScreen(terminal)

	const title = new Text(theme.bold('dsh cc-mode'), 0, 0)
	const transcript = new TranscriptView(theme)

	// Pending-steer chip line. Collapses to zero lines when the queue is empty
	// (Text.render returns [] for blank content), so it takes no vertical space.
	const queueLine = new Text('', 0, 0)

	// Session todo strip (`☐ done/total · active task`), same persistent-Text
	// pattern: blank content collapses it to zero lines when no todos exist.
	const todoLine = new Text('', 0, 0)

	// Transient notice line (e.g. the "Press Ctrl+C again to exit" hint), same
	// persistent-Text pattern: blank content collapses it to zero lines when no
	// notice is parked.
	const noticeLine = new Text('', 0, 0)

	// Live working line (claude-code style spinner row). Visibility is driven
	// purely by the `state.turn` anchor (the subscribe below starts/stops it
	// on undefined→set jumps); the message re-evaluates on every spinner tick,
	// so elapsed time and token deltas keep moving with no driver events.
	// stop() blanks it, and an empty Text collapses to zero lines.
	const workingLine = new WorkingLine(
		theme.accent,
		theme.muted,
		() => {
			const s = driver.state
			return s.turn === undefined ? '' : formatWorkingLine(s.turn, s.hud?.tokens?.output ?? 0, Date.now())
		},
		() => tui.requestRender(),
	)

	// Dynamic overlay slot (approval/question boxes). Cleared and rebuilt on
	// every state change so they appear and disappear with the driver state.
	const overlays = new Container()

	const editor = new Editor(tui, createEditorTheme(theme))
	// Seed the editor's ↑/↓ recall from persisted history (oldest first —
	// addToHistory unshifts, so the last-seeded/newest becomes index 0 and is
	// recalled on the first ↑ press). The reference is tracked so a /resume
	// history rebind (new array identity) reseeds the stack in the subscribe
	// callback below.
	let seededHistory = driver.promptHistory
	resetEditorHistory(editor, seededHistory)

	const bashMode = attachBashMode({ editor, driver, tui, theme })
	const { bashRunning, inShellMode, browseBashHistory, resetBashHistoryBrowsing } = bashMode

	// Slash-command + @-file autocomplete. The provider is rebuilt only when the
	// driver's command catalog changes identity (driver.listCommands() returns a
	// stable reference until commands/change fires) — cheap reference compare on
	// every state emit, rebuild only when the catalog actually moved.
	// Argument completers (`/model`, `/effort`, `/permissions`, `/resume`) are driver-backed and fetch per
	// request, so a single map built once at mount never goes stale.
	const argCompleters = buildArgCompleters(driver)
	let lastCatalog = driver.listCommands()
	let autocompleteProvider = new TuiAutocompleteProvider(lastCatalog, driver.cwd, undefined, argCompleters)
	editor.setAutocompleteProvider(autocompleteProvider)

	// D5: the statusline string is width-dependent — rebuild it from
	// driver.statusLineIn on every render, so a resize applies immediately.
	const statusline = new class extends Text {
		override render(width: number): string[] {
			this.setText(driver.statusLineIn(terminal.columns))
			return super.render(width)
		}
	}(driver.statusLineIn(terminal.columns), 0, 0)

	// Ordered chrome shared by the inline mount and the fullscreen exit replay.
	const chrome: Component[] = [title, transcript, queueLine, todoLine, noticeLine, overlays, workingLine, editor, statusline]

	if (tui instanceof TuiAltScreen) {
		// Fullscreen (alternate screen): transcript scrolls inside the primary
		// ScrollView; the rest of the chrome docks at the bottom.
		const body = new VStack()
		body.addChild(title)
		body.addChild(transcript)
		const scrollView = new ScrollView(body, {
			follow: 'end',
			primary: true,
			overscroll: 'chain',
			scrollbar: 'auto',
		})
		const dock = new VStack()
		dock.addChild(queueLine, { shrink: 1, minSize: 0 })
		dock.addChild(todoLine, { shrink: 1, minSize: 0 })
		dock.addChild(noticeLine, { shrink: 1, minSize: 0 })
		dock.addChild(overlays, { shrink: 1, minSize: 0 })
		dock.addChild(workingLine, { shrink: 1, minSize: 0 })
		dock.addChild(editor, { shrink: 1, minSize: 1 })
		dock.addChild(statusline, { shrink: 1, minSize: 1 })
		const layoutRoot = new VStack()
		layoutRoot.addChild(scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
		layoutRoot.addChild(dock, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 })
		tui.setLayoutRoot(layoutRoot)
	} else {
		for (const child of chrome) tui.addChild(child)
	}

	// Free ctrl+c from the editor's copy keybinding so the global listener
	// owns the quit path.
	getKeybindings().setUserBindings({ 'tui.input.copy': [] })

	// Global key handler — runs BEFORE editor dispatch. Printable text belongs to
	// the editor; this listener owns only overlays and global chords. Anything it
	// does not consume falls through to the focused editor.
	const removeInputListener = tui.addInputListener((data: string) => {
		// Kitty protocol flag 2 (report event types) delivers a release event
		// after every physical press. pi-tui filters releases only on the
		// focused-component path — this listener chain gets them raw, so drop
		// them here before any routing. Otherwise one keypress double-fires
		// overlay navigation (the /model picker moved two rows per press).
		// Repeats are kept: holding a key must still autoscroll.
		if (isKeyRelease(data)) return { consume: true }
		const live = driver.state
		// Ctrl+C arrives as a raw \x03 byte in raw mode (never a SIGINT). Treat it
		// as an escape hatch: interrupt when busy; quit when idle — but only on a
		// double press, so a stray Ctrl+C never kills the session. When an overlay
		// is open and the agent is idle, fall through so the overlay's own key
		// handling (esc to dismiss, etc.) owns it.
		if (data === '\x03') {
			if (live.busy) {
				driver.interrupt()
				return { consume: true }
			}
			if (overlayOpen(live)) {
				return undefined
			}
			const now = Date.now()
			const lastAttempt = live.lastExitAttemptAt
			if (lastAttempt !== undefined && now - lastAttempt <= DOUBLE_PRESS_WINDOW_MS) {
				opts.onQuit?.()
				return { consume: true }
			}
			// First press: anchor the window and hint. The window expires
			// naturally — no per-keystroke timer resets.
			driver.markExitAttempt(now)
			driver.showNotice('Press Ctrl+C again to exit')
			return { consume: true }
		}
		// Any parked overlay (approval, question, pickers, panels) owns the key:
		// routed through the shared overlay host and consumed so the editor
		// never sees typing, arrows, or enter while a modal is open.
		if (routeOverlayInput(driver, live, data)) return { consume: true }
		if (matchesKey(data, 'shift+tab')) {
			driver.cyclePermissionMode()
			return { consume: true }
		}
		if (matchesKey(data, Key.ctrl('o'))) {
			driver.toggleGlobalCollapse()
			return { consume: true }
		}
		if (matchesKey(data, Key.ctrl('t'))) {
			driver.toggleTodoPanel()
			return { consume: true }
		}
		if (matchesKey(data, Key.ctrl('s'))) {
			// Queue-jump: inject the outbox into the running turn now.
			driver.steerQueued()
			return { consume: true }
		}
		if (bashRunning()) {
			// A local `!` command is in flight: the composer is disabled and
			// every key is swallowed until it settles. Ctrl+C above still owns
			// interrupt/quit; the stall is bounded by the command's timeout.
			return { consume: true }
		}
		if (inShellMode() && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
			// Bash history browsing: the root-owned stack from driver.bashHistory,
			// consumed here so the editor's built-in prompt navigation never
			// interleaves with it (the editor never sees these arrows).
			browseBashHistory(matchesKey(data, Key.up))
			return { consume: true }
		}
		if (matchesKey(data, Key.up) && editor.getText().length === 0 && live.queued.length > 0) {
			// Empty composer + ↑ recalls the most recent queued entry for editing.
			// A non-empty composer (or empty queue) falls through so the editor's
			// own history navigation keeps working.
			const recalled = driver.recallQueued()
			if (recalled !== undefined) {
				editor.setText(recalled)
				return { consume: true }
			}
		}
		if (matchesKey(data, Key.ctrl('b'))) {
			// Ctrl+B promotion of a foreground subagent wait (plan §3.4). While
			// busy, promote EVERY armed foreground collect of this session
			// (via the driver → root-realm `ccCollectorRegistry`) and echo one
			// status line; busy with nothing promotable (no armed collect,
			// env kill switch, or driver without the seam) is a consumed
			// no-op — Ctrl+B here is NEVER treated as Esc. Idle falls through
			// to the editor's `tui.editor.cursorLeft` binding, unchanged.
			// tmux: Ctrl+B is the default prefix — double-press passes a
			// literal Ctrl+B through (`send-prefix`); the Ctrl+X Ctrl+B chord
			// is P1 (not implemented).
			if (!live.busy) return undefined
			const promoted = driver.promoteForegroundCollects?.() ?? 0
			if (promoted > 0) {
				driver.showNotice(`Moved ${promoted} subagent(s) to background — /agents to inspect`)
			}
			return { consume: true }
		}
		if (matchesKey(data, Key.escape)) {
			if (inShellMode()) {
				// Bash mode owns Esc FIRST — this branch must stay above the
				// busy-interrupt path: in shell mode Esc leaves the mode (the
				// buffer clears via onChange, which also restores the border)
				// and never interrupts the agent, even while busy.
				editor.setText('')
				resetBashHistoryBrowsing()
				return { consume: true }
			}
			if (live.busy) {
				driver.interrupt()
				return { consume: true }
			}
			return undefined
		}
		return undefined
	})

	// Rebuild transcript + overlays + statusline on every driver emit.
	// `undefined` until the subscribe's immediate first callback seeds the
	// turn-anchor tracker — that first call acts, so a boot into an
	// already-running session (turn set before mount) starts the line.
	let workingLineLive: boolean | undefined
	// Window-title tracker for the session/title effect below: the subscribe
	// fires on every state emit, so only real transitions reach the terminal.
	let lastWindowTitle: string | undefined
	const unsubscribe = driver.subscribe((state) => {
		// Terminal window title mirrors the framework's session/title fold
		// (fallback 'dsh-cc' before the first title lands or after switching
		// to an untitled session). One expression covers boot, resume-boot
		// (history folds before this subscription exists, so the first call
		// already carries the resumed title), live updates, and switches.
		// Gated on a real TTY: piped/headless runs must not leak OSC bytes.
		const windowTitle = sanitizeWindowTitle(state.title ?? 'dsh-cc')
		if (process.stdout.isTTY && windowTitle !== lastWindowTitle) {
			lastWindowTitle = windowTitle
			terminal.setTitle(windowTitle)
		}

		// /resume rebinds prompt history onto the switched session's project
		// (a new array identity); reseed the editor's recall stack when it
		// moves. Submits also replace the array — the reseed is then
		// content-equivalent and only resets the (already exited) browsing
		// state.
		const liveHistory = driver.promptHistory
		if (liveHistory !== seededHistory) {
			seededHistory = liveHistory
			resetEditorHistory(editor, liveHistory)
		}

		transcript.setRows(state.rows, {
			thinkingExpanded: state.thinkingExpanded,
			toolOutputExpanded: state.toolOutputExpanded,
			compactExpanded: state.compactExpanded,
		})

		queueLine.setText(
			state.queued.length === 0
				? ''
				: state.queued.map(text => theme.muted(`⏵ queued: ${text}`)).join('\n'),
		)
		queueLine.invalidate()

		const summary = todoSummary(state)
		todoLine.setText(
			summary === undefined
				? ''
				: theme.muted(`☐ ${summary.done}/${summary.total}${summary.active === undefined ? '' : ` · ${truncateActive(summary.active)}`}`),
		)
		todoLine.invalidate()

		noticeLine.setText(state.notice === undefined ? '' : theme.muted(state.notice))
		noticeLine.invalidate()

		// Working line lifecycle tracks the turn anchor: start on the
		// undefined→set jump, stop on the reverse. Seeded by the first
		// (immediate) subscribe call — see workingLineLive above.
		const turnLive = state.turn !== undefined
		if (workingLineLive !== turnLive) {
			workingLineLive = turnLive
			if (turnLive) workingLine.start()
			else workingLine.stop()
		}

		// Overlay boxes (approval/question/pickers/panels) rebuild from the
		// state on every emit via the shared overlay host.
		renderOverlayChildren(overlays, state, theme)

		// Refresh the autocomplete provider when the command catalog moves
		// (reference equality with the last-seen array). The driver keeps the
		// cached array stable across state emits until commands/change fires, so
		// this is a cheap guard that rebuilds only on an actual catalog change.
		const latestCatalog = driver.listCommands()
		if (latestCatalog !== lastCatalog) {
			lastCatalog = latestCatalog
			autocompleteProvider = new TuiAutocompleteProvider(latestCatalog, driver.cwd, undefined, argCompleters)
			editor.setAutocompleteProvider(autocompleteProvider)
		}

		tui.requestRender()
	})

	tui.setFocus(editor)

	return {
		get tui() {
			return tui
		},
		get mode() {
			return mode
		},
		editor,
		destroy() {
			// Stop the working line first: it must not tick after teardown —
			// this covers the quit-mid-turn path (the stopForExit chrome replay
			// would otherwise bake a live spinner frame into scrollback) and the
			// no-polling suite's no-dangling-interval invariant.
			workingLine.stop()
			removeInputListener()
			unsubscribe()
		},
		stopForExit() {
			if (!(tui instanceof TuiAltScreen)) {
				tui.stop()
				return
			}
			// Fullscreen exit (transcript form): leave the alternate
			// screen without repainting, then replay the chrome through a one-shot
			// main-screen renderer so native scrollback ends up with the same
			// inline layout a regular session would have produced.
			tui.stop({ preserveScreen: true })
			const replay = new TuiMainScreen(terminal)
			for (const child of chrome) replay.addChild(child)
			replay.renderNow()
			replay.stop()
		},
	}
}
