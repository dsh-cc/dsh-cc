/**
 * Single-writer terminal lease: raw mode + DEC-mode reset on every exit path.
 * Replaces ad-hoc setRawMode/process.on wiring with a checked handle so a
 * second mount fails loudly instead of double-registering handlers.
 * @module @dsh-cc/tui/terminal/lease
 */

const RESET = [
  '\x1b[?1000l',
  '\x1b[?1002l',
  '\x1b[?1003l',
  '\x1b[?1006l',
  '\x1b[?2004l',
  '\x1b[?25h',
].join('')

const EXIT_ALT = '\x1b[?1049l'

export interface TerminalLeaseOptions {
  fullscreen?: boolean
  onSignal?: (signal: NodeJS.Signals) => void
}

export interface TerminalLease {
  release(): void
}

export class TerminalLeaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalLeaseError'
  }
}

let current: TerminalLease | undefined

/**
 * Active lease, if any. Test-only introspection so a leaked mount is visible.
 */
export function activeLease(): TerminalLease | undefined {
  return current
}

/**
 * Force-release any held lease. Test isolation helper — never ship in runtime
 * paths. Calls `release()` so listeners come down and stdout is reset.
 */
export function resetTerminalForTests(): void {
  current?.release()
}

/**
 * Acquire the terminal: enable raw mode on stdin (when it is a TTY), arm
 * exit/SIGINT/SIGTERM handlers that reset the terminal, and return a handle.
 * A second acquire while a lease is held throws `TerminalLeaseError` —
 * double-mount is a loud bug, not a silent overwrite.
 */
export function acquireTerminal(options?: TerminalLeaseOptions): TerminalLease {
  if (current !== undefined) {
    throw new TerminalLeaseError('terminal lease already held')
  }
  const fullscreen = options?.fullscreen === true
  const onSignal = options?.onSignal

  const stdin = process.stdin
  const didSetRaw = typeof stdin.setRawMode === 'function' && stdin.isTTY === true
  if (didSetRaw) {
    stdin.setRawMode(true)
  }

  const writeReset = (): void => {
    const payload = fullscreen ? RESET + EXIT_ALT : RESET
    try {
      process.stdout.write(payload)
    } catch {
      // Best-effort: a closed fd must not throw out of an exit handler.
    }
  }

  const onExit = (): void => {
    writeReset()
  }
  const onSignalHandler = (signal: NodeJS.Signals): void => {
    try {
      onSignal?.(signal)
    } finally {
      release()
    }
  }

  process.on('exit', onExit)
  process.on('SIGINT', onSignalHandler)
  process.on('SIGTERM', onSignalHandler)

  let released = false
  function release(): void {
    if (released) return
    released = true
    current = undefined
    writeReset()
    process.off('exit', onExit)
    process.off('SIGINT', onSignalHandler)
    process.off('SIGTERM', onSignalHandler)
    if (didSetRaw) {
      try {
        stdin.setRawMode(false)
      } catch {
        // Best-effort: a closed fd must not throw.
      }
    }
  }

  const lease: TerminalLease = { release }
  current = lease
  return lease
}
