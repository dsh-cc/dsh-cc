import { describe, expect, it, vi } from 'vitest'
import type { Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import { TuiBands } from '@dsh-cc/tui/bands.ts'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import { createInitialState } from '@dsh-cc/tui/store.ts'

/** Inert pi-tui terminal: the root only needs its size here. */
class QuietTerminal implements PiTerminal {
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number { return 60 }
	get rows(): number { return 24 }
	get kittyProtocolActive(): boolean { return false }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

/** Driver fake with the same shape as root-provider-overlay.spec.ts, plus the current session id. */
function fakeDriver(): Driver {
	const state = createInitialState()
	const noop = (): void => {}
	const asyncNoop = async (): Promise<void> => {}
	const driver = {
		state,
		statusLine: 'test · status',
		statusLineIn: () => 'test · status',
		currentSessionId: 'session-1',
		cwd: process.cwd(),
		promptHistory: [] as string[],
		bashHistory: [] as string[],
		subscribe(listener: (s: typeof state) => void) { listener(state); return noop },
		recallQueued: () => undefined,
		listSessions: async () => [],
		listCommands: () => [],
		...Object.fromEntries([
			'setDraft', 'interrupt', 'toggleThinking', 'toggleGlobalCollapse', 'answerApproval', 'questionMove',
			'questionToggle', 'questionPick', 'questionType', 'questionBackspace', 'questionSubmit', 'questionCancel',
			'modelPickerMove', 'modelPickerSubmit', 'modelPickerCancel', 'effortPickerMove', 'effortPickerCancel',
			'permissionPickerMove', 'permissionPickerCancel', 'sessionSwitcherMove', 'sessionSwitcherType',
			'sessionSwitcherBackspace', 'sessionSwitcherToggleScope', 'sessionSwitcherCancel', 'toggleTodoPanel',
			'todoPanelMove', 'todoPanelClose', 'usagePanelClose', 'showNotice', 'markExitAttempt', 'steerQueued',
		].map(name => [name, noop])),
		...Object.fromEntries([
			'submit', 'cyclePermissionMode', 'openModelPicker', 'openEffortPicker', 'effortPickerSubmit',
			'openPermissionPicker', 'permissionPickerSubmit', 'openSessionSwitcher', 'sessionSwitcherSubmit',
			'switchSession', 'dispose',
		].map(name => [name, asyncNoop])),
	}
	return driver as never
}

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

describe('plugin bands in the root layout', () => {
	it('draws band lines above the editor and statusline, and nothing when no band shows', () => {
		const bands = new TuiBands()
		const root = buildRoot(fakeDriver(), { terminal: new QuietTerminal(), bands })
		const before = root.tui.render(60).map(strip)
		const dispose = bands.register({ id: 'inbox', tone: 'accent', render: ({ sessionId }) => `📥 2 waiting for ${sessionId} · /inbox` })
		const after = root.tui.render(60).map(strip)
		expect(after.length).toBe(before.length + 1)
		const bandRow = after.findIndex(line => line.includes('📥 2 waiting for session-1 · /inbox'))
		const statusRow = after.findIndex(line => line.includes('test · status'))
		expect(bandRow).toBeGreaterThanOrEqual(0)
		expect(bandRow).toBeLessThan(statusRow)
		dispose()
		expect(root.tui.render(60).map(strip)).toEqual(before)
		root.destroy()
	})

	it('a refresh schedules a render; destroy stops listening', () => {
		const bands = new TuiBands()
		const root = buildRoot(fakeDriver(), { terminal: new QuietTerminal(), bands })
		const requestRender = vi.spyOn(root.tui, 'requestRender')
		const calls = (): number => requestRender.mock.calls.length
		let before = calls()
		bands.refresh()
		expect(calls()).toBe(before + 1)
		root.destroy()
		before = calls()
		bands.refresh()
		expect(calls()).toBe(before)
	})

	it('mounts unchanged without a bands registry', () => {
		const root = buildRoot(fakeDriver(), { terminal: new QuietTerminal() })
		expect(root.tui.render(60).some(line => strip(line).includes('test · status'))).toBe(true)
		root.destroy()
	})
})
