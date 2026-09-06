import { describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import type { Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import { createInitialState, setProviderOverlay, openProviderPanel, type TuiState } from '@dsh-cc/tui/store.ts'
import { moveCursor, type ProviderPanelState } from '@dsh-cc/tui/store/provider-panel.ts'

/**
 * Minimal pi-tui Terminal piping writes into @xterm/headless so the real
 * root.ts render tree can be asserted on as a grid (same harness as
 * vt-renderer.spec.ts).
 */
class VirtualTerminal implements PiTerminal {
	private readonly xterm: XtermTerminal
	private inputHandler?: (data: string) => void

	constructor(private readonly cols = 80, private readonly rows = 24) {
		this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
	}

	start(onInput: (data: string) => void): void { this.inputHandler = onInput }
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void { this.xterm.write(data) }
	get columns(): number { return this.cols }
	get rows(): number { return this.rows }
	get kittyProtocolActive(): boolean { return false }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	sendInput(data: string): void { this.inputHandler?.(data) }

	grid(): string[] {
		const lines: string[] = []
		for (let i = 0; i < this.rows; i++) {
			const base = this.xterm.buffer.active.baseY
			lines.push(this.xterm.buffer.active.getLine(base + i)?.translateToString(true) ?? '')
		}
		return lines
	}
}

/** Driver fake with the `/provider` runtime seam root.ts must route through. */
function fakeDriver(initial: TuiState): Driver & { providerRuntime: { panelPhase(): ProviderPanelState['phase'] | undefined; panelMove(delta: -1 | 1): void; panelSubmit(): void; panelCancel(): void } } {
	let state = initial
	const listeners = new Set<(s: TuiState) => void>()
	const emit = (): void => { for (const l of listeners) l(state) }
	const noop = (): void => {}
	const asyncNoop = async (): Promise<void> => {}
	const driver = {
		get state() { return state },
		get statusLine() { return 'test · status' },
		statusLineIn: () => 'test · status',
		get cwd() { return process.cwd() },
		get promptHistory() { return [] as string[] },
		get bashHistory() { return [] as string[] },
		subscribe(listener: (s: TuiState) => void) {
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
		setState(next: TuiState) { state = next; emit() },
		providerRuntime: {
			panelPhase: () => state.providerPanel?.phase,
			panelMove(delta: -1 | 1) {
				if (state.providerPanel === undefined) return
				state = setProviderOverlay(state, moveCursor(state.providerPanel, delta))
				emit()
			},
			panelSubmit: noop,
			panelCancel: noop,
		},
	}
	return driver as never
}

const ROWS = [
	{ route: 'deepseek-official', displayName: 'DeepSeek', section: 'configured' as const, isCurrent: true, modelCount: 3, credential: { badge: 'env' as const, warning: false } },
	{ route: 'openai', displayName: 'OpenAI', section: 'available' as const, isCurrent: false, modelCount: 12 },
]

describe('root routes and renders the /provider panel overlay', () => {
	it('renders the provider box in the real root tree', async () => {
		const vt = new VirtualTerminal()
		const driver = fakeDriver(setProviderOverlay(createInitialState(), openProviderPanel(ROWS)))
		const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
		root.tui.start()
		await new Promise(resolve => setTimeout(resolve, 60))

		const rendered = vt.grid().join('\n')
		expect(rendered).toContain('Providers')
		expect(rendered).toContain('Configured')
		expect(rendered).toContain('● deepseek-official')

		root.tui.stop()
		root.destroy()
	})

	it('routes keys into routeProviderPanelInput (cursor moves via panelMove)', async () => {
		const vt = new VirtualTerminal()
		const driver = fakeDriver(setProviderOverlay(createInitialState(), openProviderPanel(ROWS)))
		const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
		root.tui.start()
		await new Promise(resolve => setTimeout(resolve, 60))

		expect(driver.state.providerPanel?.cursor).toBe(0)
		vt.sendInput('j')
		await new Promise(resolve => setTimeout(resolve, 60))

		expect(driver.state.providerPanel?.cursor).toBe(1)

		root.tui.stop()
		root.destroy()
	})
})
