/**
 * `!` shell-command execution extracted from harness/driver.ts. Free-function
 * collaborator: takes a {@link DriverBashCtx} instead of closing over
 * createDriver's locals, so the harness factory stays out of this leaf.
 * @module @dsh-cc/tui/harness/driver-bash
 */

import { upsertRow, setNotice } from '../store.ts'
import type { DriverBashCtx } from './driver-ctx.ts'
import {
  BASH_RUNNING_NOTICE,
  BASH_STDOUT_MAX_BYTES,
  BASH_TIMEOUT_MS,
  execFileAsync,
  shellOutputRow,
} from './shell-output.ts'

/**
 * Run a `!` shell command: echo the `$ cmd` row, park the running notice, then
 * dispatch through the mounted shell executor when present or a timed/budgeted
 * `/bin/sh -c` child otherwise. Uses the CURRENT view-model via `rt.state()`,
 * and emits rows + notice through `rt.emit`.
 */
export async function runShellCommand(rt: DriverBashCtx, raw: string): Promise<void> {
  const command = raw.trim()
  if (command.length === 0) return
  rt.appendBashHistory(command)
  // `state` is rebound by emit — re-read via rt.state() after every emit,
  // matching the original live `let` in createDriver.
  rt.emit(upsertRow(rt.state(), { kind: 'status', text: `$ ${command}` }))
  rt.emit(setNotice(rt.state(), BASH_RUNNING_NOTICE))
  try {
    if (rt.shell === undefined) {
      // Degraded path: no shell executor mounted. Non-zero exits, timeout
      // kills, and spawn failures all arrive as rejections.
      const result = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: rt.cwd,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: BASH_STDOUT_MAX_BYTES,
      })
      const row = shellOutputRow(result.stdout, result.stderr, { exitCode: 0, timedOut: false })
      if (row.text.length > 0) rt.emit(upsertRow(rt.state(), row))
    } else {
      const result = await rt.shell.run(rt.shell.resolve({
        command,
        timeoutMs: BASH_TIMEOUT_MS,
        stdoutMaxBytes: BASH_STDOUT_MAX_BYTES,
      }))
      const row = shellOutputRow(result.stdout.text, result.stderr.text, result)
      if (row.text.length > 0) rt.emit(upsertRow(rt.state(), row))
    }
  } catch (error) {
    const failure = error as {
      code?: unknown
      killed?: boolean
      message?: string
      stdout?: string
      stderr?: string
    }
    let row: { kind: 'status'; text: string; error?: boolean }
    if (typeof failure.code === 'number') {
      // Non-zero exit from the fallback child: output rides on the error.
      row = shellOutputRow(failure.stdout ?? '', failure.stderr ?? '', { exitCode: failure.code, timedOut: false })
    } else if (failure.killed === true) {
      // The fallback child hit the timeout and was killed.
      row = shellOutputRow(failure.stdout ?? '', failure.stderr ?? '', { exitCode: null, timedOut: true })
    } else {
      // Infrastructure fault (executor rejection, unwritable workdir, no
      // /bin/sh): the message is all there is to show.
      row = { kind: 'status', text: failure.message ?? String(error), error: true }
    }
    if (row.text.length > 0) rt.emit(upsertRow(rt.state(), row))
  } finally {
    // Drop the running indicator only if nothing replaced it meanwhile.
    if (rt.state().notice === BASH_RUNNING_NOTICE) rt.emit(setNotice(rt.state(), undefined))
  }
}
