/**
 * Masked single-line text input (dsh-cc-side, first-party): a drop-in
 * companion to pi-tui's `Input` for secrets (API keys). Display shows one
 * `•` per grapheme instead of the raw characters; `getValue()` and `onSubmit`
 * still receive the raw value. Key handling mirrors `Input`'s behavior using
 * pi-tui's own public helpers — the vendored package itself is untouched.
 * @module @dsh-cc/tui/components/masked-input
 */
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	getKeybindings,
	sliceByColumn,
	visibleWidth,
} from '@dsh-cc/pi-tui'

// pi-tui's segmenter/word-navigation helpers are not part of the package's
// public root surface, and deep `src/` imports are forbidden (check:deep-imports
// — they do not survive the lib emit). The grapheme segmenter is a one-liner,
// so it is instantiated locally; word-jump keys are deliberately not bound
// (secrets are single-token entries; the control-char filter below swallows
// those key sequences harmlessly instead).
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export class MaskedInput implements Component, Focusable {
	private value = ''
	private cursor = 0
	private pasteBuffer = ''
	private isInPaste = false
	public onSubmit?: (value: string) => void
	public onEscape?: () => void
	focused = false

	getValue(): string {
		return this.value
	}

	setValue(value: string): void {
		this.value = value
		this.cursor = Math.min(this.cursor, value.length)
	}

	handleInput(data: string): void {
		// Bracketed paste mode buffering (same protocol as Input).
		if (data.includes('\x1b[200~')) {
			this.isInPaste = true
			this.pasteBuffer = ''
			data = data.replace('\x1b[200~', '')
		}
		if (this.isInPaste) {
			this.pasteBuffer += data
			const endIndex = this.pasteBuffer.indexOf('\x1b[201~')
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex)
				this.isInPaste = false
				const remaining = this.pasteBuffer.substring(endIndex + 6)
				this.pasteBuffer = ''
				// Newlines are never part of a single-line secret.
				this.value = this.value.slice(0, this.cursor) + pasteContent.replace(/[\r\n\t]/g, '') + this.value.slice(this.cursor)
				this.cursor += pasteContent.replace(/[\r\n\t]/g, '').length
				if (remaining) this.handleInput(remaining)
			}
			return
		}

		const kb = getKeybindings()
		if (kb.matches(data, 'tui.select.cancel')) {
			if (this.onEscape) this.onEscape()
			return
		}
		if (kb.matches(data, 'tui.input.submit') || data === '\n') {
			if (this.onSubmit) this.onSubmit(this.value)
			return
		}
		if (kb.matches(data, 'tui.editor.deleteCharBackward')) {
			if (this.cursor > 0) {
				const graphemes = [...segmenter.segment(this.value.slice(0, this.cursor))]
				const len = graphemes[graphemes.length - 1]?.segment.length ?? 1
				this.value = this.value.slice(0, this.cursor - len) + this.value.slice(this.cursor)
				this.cursor -= len
			}
			return
		}
		if (kb.matches(data, 'tui.editor.deleteCharForward')) {
			if (this.cursor < this.value.length) {
				const graphemes = [...segmenter.segment(this.value.slice(this.cursor))]
				const len = graphemes[0]?.segment.length ?? 1
				this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + len)
			}
			return
		}
		if (kb.matches(data, 'tui.editor.cursorLeft')) {
			if (this.cursor > 0) {
				const graphemes = [...segmenter.segment(this.value.slice(0, this.cursor))]
				this.cursor -= graphemes[graphemes.length - 1]?.segment.length ?? 1
			}
			return
		}
		if (kb.matches(data, 'tui.editor.cursorRight')) {
			if (this.cursor < this.value.length) {
				const graphemes = [...segmenter.segment(this.value.slice(this.cursor))]
				this.cursor += graphemes[0]?.segment.length ?? 1
			}
			return
		}
		if (kb.matches(data, 'tui.editor.cursorLineStart')) {
			this.cursor = 0
			return
		}
		if (kb.matches(data, 'tui.editor.cursorLineEnd')) {
			this.cursor = this.value.length
			return
		}
		// cursorWordLeft/Right intentionally unbound — see the header comment.

		// Printable input only — never let control characters into a secret.
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0)
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
		})
		if (!hasControlChars) {
			this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor)
			this.cursor += data.length
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		// Bullets are one column wide, so display text and cursor offsets derive
		// from grapheme counts without ever exposing a raw substring.
		const prompt = '> '
		const availableWidth = width - prompt.length
		if (availableWidth <= 0) return [prompt]

		const displayValue = '•'.repeat([...segmenter.segment(this.value)].length)
		const graphemesBeforeCursor = [...segmenter.segment(this.value.slice(0, this.cursor))].length
		const totalWidth = displayValue.length

		let visibleText = ''
		let cursorDisplay = graphemesBeforeCursor
		if (totalWidth < availableWidth) {
			visibleText = displayValue
		} else {
			const scrollWidth = graphemesBeforeCursor === totalWidth ? availableWidth - 1 : availableWidth
			const cursorCol = graphemesBeforeCursor
			if (scrollWidth > 0) {
				const halfWidth = Math.floor(scrollWidth / 2)
				let startCol = 0
				if (cursorCol < halfWidth) {
					startCol = 0
				} else if (cursorCol > totalWidth - halfWidth) {
					startCol = Math.max(0, totalWidth - scrollWidth)
				} else {
					startCol = Math.max(0, cursorCol - halfWidth)
				}
				visibleText = sliceByColumn(displayValue, startCol, scrollWidth, true)
				cursorDisplay = Math.max(0, cursorCol - startCol)
			} else {
				visibleText = ''
				cursorDisplay = 0
			}
		}

		const marker = this.focused ? CURSOR_MARKER : ''
		const beforeCursor = visibleText.slice(0, cursorDisplay)
		const atCursor = visibleText.slice(cursorDisplay, cursorDisplay + 1) || ' '
		const afterCursor = visibleText.slice(cursorDisplay + 1)
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor
		const visualLength = visibleWidth(textWithCursor)
		const padding = ' '.repeat(Math.max(0, availableWidth - visualLength))
		return [prompt + textWithCursor + padding]
	}
}
