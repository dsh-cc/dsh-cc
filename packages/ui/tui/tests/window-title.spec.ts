import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import { sanitizeWindowTitle } from '@dsh-cc/tui/components/root-utils.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import { createInitialState, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * Minimal pi-tui Terminal recording setTitle calls. The window-title effect
 * is the only surface under test here, so the rest of the interface no-ops.
 */
class TitleTerminal implements PiTerminal {
	readonly titles: string[] = []

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number { return 80 }
	get rows(): number { return 24 }
	get kittyProtocolActive(): boolean { return false }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(title: string): void { this.titles.push(title) }
	setProgress(): void {}
}

/** Minimal Driver fake: holds state, notifies subscribers. */
function fakeDriver(initial: TuiState = createInitialState()): Driver & { setState(next: TuiState): void } {
	let state = initial
	const listeners = new Set<(s: TuiState) => void>()
	const emit = (): void => { for (const l of listeners) l(state) }
	const noop = (): void => {}
	const asyncNoop = async (): Promise<void> => {}
	return {
		get state() { return state },
		get statusLine() { return 'test · status' },
		statusLineIn: () => 'test · status',
		get cwd() { return process.cwd() },
		get promptHistory() { return [] },
		get bashHistory() { return [] },
		subscribe(listener) {
			listeners.add(listener)
			listener(state)
			return () => { listeners.delete(listener) }
		},
		setDraft: noop,
		submit: asyncNoop,
		interrupt: noop,
		cyclePermissionMode: asyncNoop,
		toggleThinking: noop,
		toggleGlobalCollapse: noop,
		answerApproval: noop,
		questionMove: noop,
		questionToggle: noop,
		questionPick: noop,
		questionType: noop,
		questionBackspace: noop,
		questionSubmit: noop,
		questionCancel: noop,
		openModelPicker: asyncNoop,
		modelPickerMove: noop,
		modelPickerSubmit: noop,
		modelPickerCancel: noop,
		openEffortPicker: asyncNoop,
		effortPickerMove: noop,
		effortPickerSubmit: asyncNoop,
		effortPickerCancel: noop,
		openPermissionPicker: asyncNoop,
		permissionPickerMove: noop,
		permissionPickerSubmit: asyncNoop,
		permissionPickerCancel: noop,
		openSessionSwitcher: asyncNoop,
		sessionSwitcherMove: noop,
		sessionSwitcherType: noop,
		sessionSwitcherBackspace: noop,
		sessionSwitcherToggleScope: noop,
		sessionSwitcherSubmit: asyncNoop,
		sessionSwitcherCancel: noop,
		toggleTodoPanel: noop,
		todoPanelMove: noop,
		todoPanelClose: noop,
		usagePanelClose: noop,
		showNotice: noop,
		markExitAttempt: noop,
		steerQueued: noop,
		recallQueued: () => undefined,
		switchSession: asyncNoop,
		listSessions: async () => [],
		listCommands: () => [],
		dispose: asyncNoop,
		setState(next) { state = next; emit() },
	}
}

describe('window title effect', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

	beforeEach(() => {
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
	})

	afterEach(() => {
		if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
		else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
	})

	it('writes the dsh-cc fallback on boot before any session title lands', () => {
		const terminal = new TitleTerminal()
		const root = buildRoot(fakeDriver(), { terminal })
		expect(terminal.titles).toEqual(['dsh-cc'])
		root.destroy()
	})

	it('boots straight into the resumed title (no dsh-cc flash)', () => {
		const terminal = new TitleTerminal()
		const root = buildRoot(fakeDriver({ ...createInitialState(), title: 'Resumed work' }), { terminal })
		expect(terminal.titles).toEqual(['Resumed work'])
		root.destroy()
	})

	it('follows title transitions and reverts to the fallback when cleared', () => {
		const terminal = new TitleTerminal()
		const driver = fakeDriver()
		const root = buildRoot(driver, { terminal })

		driver.setState({ ...driver.state, title: 'Fix login bug' })
		driver.setState({ ...driver.state, title: 'Fix login bug, refined' })
		const { title: _dropped, ...untitled } = driver.state
		driver.setState(untitled)

		expect(terminal.titles).toEqual(['dsh-cc', 'Fix login bug', 'Fix login bug, refined', 'dsh-cc'])
		root.destroy()
	})

	it('does not rewrite the title on unrelated state emits', () => {
		const terminal = new TitleTerminal()
		const driver = fakeDriver()
		const root = buildRoot(driver, { terminal })

		driver.setState({ ...driver.state, busy: true })
		driver.setState({ ...driver.state, busy: false })

		expect(terminal.titles).toEqual(['dsh-cc'])
		root.destroy()
	})

	it('never writes OSC bytes when stdout is not a TTY', () => {
		Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true })
		const terminal = new TitleTerminal()
		const driver = fakeDriver()
		const root = buildRoot(driver, { terminal })
		driver.setState({ ...driver.state, title: 'Fix login bug' })
		expect(terminal.titles).toEqual([])
		root.destroy()
	})
})

describe('sanitizeWindowTitle', () => {
	it('strips OSC-terminating and C0/C1 control characters', () => {
		expect(sanitizeWindowTitle('fix\x1bthe\x07bug')).toBe('fixthebug')
		expect(sanitizeWindowTitle('a\nb\tc')).toBe('abc')
	})

	it('trims whitespace and falls back to dsh-cc when empty', () => {
		expect(sanitizeWindowTitle('  padded  ')).toBe('padded')
		expect(sanitizeWindowTitle('\x1b\x07')).toBe('dsh-cc')
	})

	it('caps the title length', () => {
		expect(sanitizeWindowTitle('x'.repeat(200))).toHaveLength(120)
	})
})
