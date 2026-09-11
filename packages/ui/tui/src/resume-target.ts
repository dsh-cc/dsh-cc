/**
 * Cross-process resume marker. The TUI writes the live session id AND reads
 * it back itself on boot (project-keyed auto-resume); the `dsh-cc` launcher
 * no longer reads markers — it only translates CLI flags into env for the
 * TUI. Session records themselves stay in harness persistence.
 *
 * Markers are keyed by the session's *project* (the main git root; worktrees
 * collapse onto it), so a worktree and its main checkout share the "last
 * session" anchor. The marker lives at
 * `$DSH_HOME/tui/projects/<projectKey>/resume.txt` (the same bucket as
 * per-project history and the session sidecar index).
 *
 * Pre-P3 cwd-bucketed markers (`resume-<hash>.txt`) are no longer read or
 * written — that dual-write was removed after the 0.4.0 milestone.
 *
 * @module @dsh-cc/tui/resume-target
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveProject } from './project.ts'

export interface ResumeTargetOptions {
  /** Data directory. Defaults to `$DSH_HOME/tui` or `~/.dsh/tui`. */
  home?: string
  /** Session cwd whose PROJECT keys the marker. Defaults to `process.cwd()`. */
  cwd?: string
}

function dataDir(options: ResumeTargetOptions = {}): string {
  if (options.home !== undefined) return options.home
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui')
}

/**
 * On-disk path of the project-keyed resume marker for `cwd`. Exported so
 * tests can lock the scheme. (Multiple clients call this per boot, so the
 * underlying `resolveProject` is memoised in project.ts — no per-call git.)
 */
export function resumeMarkerFile(options: ResumeTargetOptions = {}): string {
  const cwd = options.cwd ?? process.cwd()
  const key = resolveProject(cwd).projectKey
  return join(dataDir(options), 'projects', key, 'resume.txt')
}

/** The trimmed contents of a file, or '' when absent. */
function quietRead(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Persist the session id the next boot should attach. Idempotent: if the
 * marker already holds exactly `sessionId` this is a no-op.
 */
export function writeResumeTarget(sessionId: string, options: ResumeTargetOptions = {}): void {
  const id = sessionId.trim()
  if (id.length === 0) return
  const file = resumeMarkerFile(options)
  if (quietRead(file) === id) return

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${id}\n`)
}

/**
 * Forget the marker — a fresh session. Blanks the project-keyed marker
 * (best-effort).
 */
export function clearResumeTarget(options: ResumeTargetOptions = {}): void {
  try {
    writeFileSync(resumeMarkerFile(options), '')
  } catch {
    // Best effort — the marker is a launcher nicety.
  }
}

/**
 * The stored session id, or undefined when absent/blank.
 */
export function readResumeTarget(options: ResumeTargetOptions = {}): string | undefined {
  const content = quietRead(resumeMarkerFile(options))
  return content.length === 0 ? undefined : content
}
