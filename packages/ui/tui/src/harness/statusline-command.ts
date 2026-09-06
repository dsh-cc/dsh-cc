/**
 * Status-line command runner: 300 ms-debounced execution of the configured
 * command with the CC-shaped JSON payload on stdin. Kill-in-flight on every
 * new trigger, generation-guarded settles (a superseded run's late result is
 * discarded), update({ immediate: true }) bypass for settings-driven command
 * changes, blank-on-failure (non-zero exit, killed, timeout, overrun, spawn
 * throw, empty stdout), COLUMNS/LINES from the terminal-size getter at spawn
 * time, a 60 s hard cap with a 64 KiB stdout cap, and a dispose that aborts,
 * clears, and quiets.
 * @module @dsh-cc/tui/harness/statusline-command
 */

import type { ShellExecutorLike, ShellRunResultLike } from '../state/driver-types.ts'

/** Injectable collaborators of the status-line runner. */
export type StatusLineCommandDeps = {
  /** The deployment's shell executor (resolve→run seam). */
  executor: ShellExecutorLike
  /** Current terminal dimensions, read at spawn time for COLUMNS/LINES. */
  terminalSize: () => { columns: number; rows: number }
  /** Notified after every generation that lands (success or blank). */
  onSettled: (line: string) => void
  /** Debounce delay in ms (default 300); overridable for tests. */
  debounceMs?: number
  /** Hard per-run cap in ms (default 60_000). */
  timeoutMs?: number
  /** Stdout cap in bytes (default 64 KiB). */
  stdoutMaxBytes?: number
}

/** Options of {@link StatusLineCommand.update}. */
export type StatusLineUpdateOptions = {
  /** Skip the debounce (settings-driven `command` changes). */
  immediate?: boolean
  /** Working directory for the child (defaults to the driver cwd). */
  workdir?: string
}

/** Handle of the running status-line command. */
export type StatusLineCommand = {
  /** Trigger a (debounced by default) run with a fresh payload. */
  update(config: { command: string }, payload: unknown, options?: StatusLineUpdateOptions): void
  /** The last settled rows (0–3, '\n'-joined; empty string until a run succeeds). */
  latest(): string
  /** Abort in-flight, clear all timers, and make later settles no-ops. */
  dispose(): void
}

/** Debounce delay per the CC contract (C5). */
const DEFAULT_DEBOUNCE_MS = 300
/** dsh-cc's undocumented-by-CC guard against hung scripts. */
const DEFAULT_TIMEOUT_MS = 60_000
/** dsh-cc's stdout hard cap. */
const DEFAULT_STDOUT_MAX_BYTES = 64 * 1024
/** Max rows of the command's stdout kept (multi-row CC status line, capped). */
const MAX_STATUSLINE_ROWS = 3

/**
 * Create the status-line command runner. Pure with respect to the injected
 * executor; owns exactly one debounce timer and one hard-cap timer at a time.
 */
export function createStatusLineCommand(deps: StatusLineCommandDeps): StatusLineCommand {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdoutMaxBytes = deps.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES

  let disposed = false
  let generation = 0
  let latestLine = ''
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight: { controller: AbortController; capTimer: ReturnType<typeof setTimeout> } | undefined

  /** Abort the in-flight child and forget it (trigger-time kill, C5). */
  function killInFlight(): void {
    if (inFlight === undefined) return
    clearTimeout(inFlight.capTimer)
    inFlight.controller.abort()
    inFlight = undefined
  }

  /** Record a blank for the current generation and notify. */
  function blank(): void {
    latestLine = ''
    deps.onSettled('')
  }

  /** Whether a settled generation may still write state and notify. */
  function isCurrent(gen: number): boolean {
    return !disposed && gen === generation
  }

  function spawn(command: string, payload: unknown, workdir: string | undefined, gen: number): void {
    if (disposed || gen !== generation) return
    const controller = new AbortController()
    const { columns, rows } = deps.terminalSize()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.COLUMNS = String(columns)
    env.LINES = String(rows)
    const request = {
      command,
      stdin: `${JSON.stringify(payload)}\n`,
      signal: controller.signal,
      env,
      timeoutMs,
      stdoutMaxBytes,
      ...(workdir === undefined ? {} : { workdir }),
    }
    let spec: ReturnType<ShellExecutorLike['resolve']>
    try {
      spec = deps.executor.resolve(request)
    } catch {
      killInFlight()
      if (isCurrent(gen)) blank()
      return
    }
    const capTimer = setTimeout(() => {
      // Hung run: cut it and blank immediately — the executor's own settle
      // (if it ever arrives) is discarded by the generation guard.
      controller.abort()
      if (inFlight?.controller === controller) {
        inFlight = undefined
        if (isCurrent(gen)) blank()
      }
    }, timeoutMs)
    inFlight = { controller, capTimer }
    deps.executor.run(spec).then(
      (result: ShellRunResultLike) => {
        if (inFlight?.controller === controller) {
          clearTimeout(inFlight.capTimer)
          inFlight = undefined
        }
        if (!isCurrent(gen)) return
        const success = result.exitCode === 0 && !result.timedOut && result.stdout.text.length > 0
        if (success) {
          const rows = result.stdout.text.split('\n').map((row) => row.trimEnd())
          while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
          if (rows.length > 0 && rows.some((row) => row !== '')) {
            latestLine = rows.slice(0, MAX_STATUSLINE_ROWS).join('\n')
          } else {
            blank()
            return
          }
        } else {
          latestLine = ''
        }
        if (latestLine.length === 0) {
          blank()
          return
        }
        deps.onSettled(latestLine)
      },
      () => {
        if (inFlight?.controller === controller) {
          clearTimeout(inFlight.capTimer)
          inFlight = undefined
        }
        if (isCurrent(gen)) blank()
      },
    )
  }

  return {
    update(config, payload, options) {
      if (disposed) return
      generation += 1
      const gen = generation
      // A new trigger cancels the in-flight child first (C5), then a
      // replacement is scheduled — debounced, or immediate for command swaps.
      killInFlight()
      clearTimeout(debounceTimer)
      if (options?.immediate === true) {
        spawn(config.command, payload, options?.workdir, gen)
        return
      }
      debounceTimer = setTimeout(() => {
        spawn(config.command, payload, options?.workdir, gen)
      }, debounceMs)
    },

    latest() {
      return latestLine
    },

    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      clearTimeout(debounceTimer)
      killInFlight()
      latestLine = ''
    },
  }
}
