/**
 * GitRunner contract for marketplace clones/updates (plan §4.B): hosts and
 * tests inject fakes; the default implementation shells out to the system
 * `git` with a timeout. Failures surface the exact §3 catalog string
 * `git <verb> failed for <target>: <first stderr line>` (stderr empty ⇒
 * `exit code <n>`), where verb = first git arg and target = last.
 *
 * @module @dsh-cc/plugin-manager/git
 */

import { execFile } from 'node:child_process'
import { PluginManagerError } from './errors.ts'

export type GitRunner = (args: string[], opts: { cwd: string }) => Promise<{ code: number, stdout: string, stderr: string }>

export interface GitRunnerOptions {
  /** Kill the git process after this many milliseconds (default 60000). */
  timeoutMs?: number
}

/**
 * Default GitRunner: `execFile('git', args, { cwd, timeout })`. A non-zero
 * exit, spawn failure, or timeout maps to `code` (spawn/timeout ⇒ 1) with
 * the collected stdout/stderr; the promise never rejects.
 */
export function createSystemGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const timeoutMs = options.timeoutMs ?? 60000
  return (args, opts) =>
    new Promise(resolve => {
      execFile('git', args, { cwd: opts.cwd, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
        const rawCode = (error as { code?: unknown } | null)?.code
        const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
}

/**
 * The §3 git failure error: `git <verb> failed for <target>: <first stderr
 * line>` — verb is the git subcommand and target the thing operated on (the
 * clone url, or the `-C` location for pulls); empty stderr falls back to
 * `exit code <n>`.
 */
export function gitFailure(verb: string, target: string, result: { code: number, stderr: string }): PluginManagerError {
  const firstStderrLine = result.stderr.split('\n').map(line => line.trim()).find(line => line.length > 0)
  const detail = firstStderrLine ?? `exit code ${result.code}`
  return new PluginManagerError('GIT_FAILED', `git ${verb} failed for ${target}: ${detail}`)
}
