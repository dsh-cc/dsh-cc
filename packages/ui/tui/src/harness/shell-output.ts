/**
 * Shell/output helpers extracted from harness/driver.ts: `!` command budget
 * constants, git-branch probing, default `/export-md` path stamping, and
 * bash-output row assembly. Node builtins only — no store or harness imports.
 * @module @dsh-cc/tui/harness/shell-output
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** Wall-clock lifetime of a `!` shell command. */
export const BASH_TIMEOUT_MS = 120_000

/** Foreground stdout byte budget handed to the shell executor for a `!` run. */
export const BASH_STDOUT_MAX_BYTES = 64_000

/** Lines of command output shown under the `$ cmd` echo row (rest is elided). */
export const BASH_OUTPUT_LINE_CAP = 20

/** Notice parked above the composer while a `!` command runs. */
export const BASH_RUNNING_NOTICE = '⠋ running…'

export const execFileAsync = promisify(execFile)

/**
 * Default `/export-md` output directory: `$DSH_HOME/tui/exports` (or
 * `~/.dsh/tui/exports`), mirroring the `resume-target` data-dir
 * resolution one level deeper.
 */
export function defaultExportDir(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui', 'exports')
}

/** Filesystem-safe timestamp for default export filenames (ISO, `:`/`.` dashed). */
export function exportStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Best-effort git branch probe: `git -C <cwd> rev-parse --abbrev-ref HEAD`
 * with a short timeout. Never throws — errors (no git, no repo, detached
 * head) resolve to undefined and the statusline simply omits the segment.
 */
export async function gitBranchOf(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 2000,
    })
    const branch = stdout.trim()
    return branch.length > 0 ? branch : undefined
  } catch {
    return undefined
  }
}

/**
 * Cap combined command output at {@link BASH_OUTPUT_LINE_CAP} lines. Leading
 * and trailing blank edges (from an empty stream or a trailing newline) are
 * trimmed; interior blank lines are preserved.
 */
function capShellOutput(text: string): string {
  const lines = text.replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return ''
  if (lines.length <= BASH_OUTPUT_LINE_CAP) return lines.join('\n')
  const hidden = lines.length - BASH_OUTPUT_LINE_CAP
  return `${lines.slice(0, BASH_OUTPUT_LINE_CAP).join('\n')}\n… +${hidden} more line${hidden === 1 ? '' : 's'}`
}

/**
 * Assemble the bash-command output row: combined stdout/stderr (line-capped)
 * plus a failure trailer. The row is error-marked for a non-zero exit, a
 * signal death, or an executor timeout.
 */
export function shellOutputRow(
  stdout: string,
  stderr: string,
  outcome: { exitCode: number | null; timedOut: boolean },
): { kind: 'status'; text: string; error?: boolean } {
  const parts: string[] = []
  const capped = capShellOutput(`${stdout}\n${stderr}`)
  if (capped.length > 0) parts.push(capped)
  if (outcome.timedOut) {
    parts.push(`timed out after ${BASH_TIMEOUT_MS / 1000}s`)
  } else if (outcome.exitCode === null) {
    parts.push('killed by a signal')
  } else if (outcome.exitCode !== 0) {
    parts.push(`exit code ${outcome.exitCode}`)
  }
  const failed = outcome.timedOut || outcome.exitCode === null || outcome.exitCode !== 0
  return {
    kind: 'status',
    text: parts.join('\n'),
    ...(failed ? { error: true } : {}),
  }
}
