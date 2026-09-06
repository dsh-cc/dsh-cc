/**
 * Live working line rendered above the editor: a braille spinner plus a
 * per-tick message (elapsed time, output-token delta). The component owns its
 * own 80ms interval — it is the SINGLE file in tui/src allowed to create one
 * (whitelisted in tests/no-polling.spec.ts; any new exemption means touching
 * that test first).
 * @module @dsh-cc/tui/components/working-line
 */

import { Text } from '@dsh-cc/pi-tui'

/** Spinner frames — the same braille set as pi-tui's Loader. */
const FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Frame interval in ms — matches pi-tui's Loader default. */
const TICK_MS = 80

/** A function that wraps text in an SGR style (same shape as the theme roles). */
type Styler = (text: string) => string

/**
 * Self-driving status row: `start()` shows the line and ticks the spinner,
 * `stop()` tears the interval down and blanks the text (an empty Text renders
 * zero lines, so an idle row collapses). The message is re-evaluated through
 * `messageFn` on every tick, so elapsed time and token deltas keep moving
 * even when no driver events arrive. Not auto-started: the root starts/stops
 * it on `state.turn` anchor jumps.
 */
export class WorkingLine extends Text {
  private frameIndex = 0
  private intervalId: ReturnType<typeof setInterval> | undefined
  private readonly spinnerColorFn: Styler
  private readonly messageColorFn: Styler
  private readonly messageFn: () => string
  private readonly onDirty: () => void

  constructor(
    spinnerColorFn: Styler,
    messageColorFn: Styler,
    messageFn: () => string,
    onDirty: () => void,
  ) {
    super('', 0, 0)
    this.spinnerColorFn = spinnerColorFn
    this.messageColorFn = messageColorFn
    this.messageFn = messageFn
    this.onDirty = onDirty
  }

  /** (Re)arm the tick loop. Stops first, so a double start leaves no orphan. */
  start(): void {
    this.stop()
    this.tick()
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length
      this.tick()
    }, TICK_MS)
  }

  /** Tear the interval down and collapse the row (explicit blank, no freeze). */
  stop(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    this.setText('')
    this.onDirty()
  }

  private tick(): void {
    const message = this.messageFn()
    if (message.length === 0) {
      this.setText('')
      this.onDirty()
      return
    }
    const frame = FRAMES[this.frameIndex] ?? FRAMES[0]!
    this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(message)}`)
    this.onDirty()
  }
}
