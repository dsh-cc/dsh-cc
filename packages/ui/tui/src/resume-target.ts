/**
 * Cross-process resume marker. The TUI writes the live session id AND reads
 * it back itself on boot (project-keyed auto-resume); the `dsh-cc` launcher
 * no longer reads markers — it only translates CLI flags into env for the
 * TUI. Session records themselves stay in harness persistence.
 *
 * Markers are keyed by the session's *project* (the main git root; worktrees
 * collapse onto it), so a worktree and its main checkout share the "last
 * session" anchor. The new marker lives at
 * `$DSH_HOME/tui/projects/<projectKey>/resume.txt` (the same bucket as
 * per-project history and the session sidecar index).
 *
 * A legacy marker (`resume-<sha256(resolve(cwd))[:16]>.txt`, cwd-bucketed)
 * is dual-read on boot and dual-written/cleared alongside the new one, so
 * pre-P3 launchers that read it keep working during the transition. The
 * legacy dual-write is removed in 0.4.0.
 *
 * @module @dsh-cc/tui/resume-target
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveProject } from './project.ts'

export interface ResumeTargetOptions {
  /** Data directory. Defaults to `$DSH_HOME/tui` or `~/.dsh/tui`. */
  home?: string
  /** Session cwd whose PROJECT keys the new marker. Defaults to `process.cwd()`. */
  cwd?: string
  /** cwd bucket for the legacy marker. Defaults to `cwd`. */
  legacyCwd?: string
}

function dataDir(options: ResumeTargetOptions = {}): string {
  if (options.home !== undefined) return options.home
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui')
}

function legacyKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
}

/**
 * On-disk path of the NEW project-keyed resume marker for `cwd`. Exported so
 * tests can lock the scheme. (Multiple clients call this per boot, so the
 * underlying `resolveProject` is memoised in project.ts — no per-call git.)
 */
export function resumeMarkerFile(options: ResumeTargetOptions = {}): string {
  const cwd = options.cwd ?? process.cwd()
  const key = resolveProject(cwd).projectKey
  return join(dataDir(options), 'projects', key, 'resume.txt')
}

/**
 * On-disk path of the legacy cwd-bucketed marker (`resume-<hash>.txt`),
 * used during the pre-P3 transition. Keyed by `legacyCwd ?? cwd`.
 */
export function legacyResumeMarkerFile(options: ResumeTargetOptions = {}): string {
  const cwd = options.legacyCwd ?? options.cwd ?? process.cwd()
  return join(dataDir(options), `resume-${legacyKey(cwd)}.txt`)
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
 * Persist the session id the next boot should attach. Idempotent on the NEW
 * marker: if it already holds exactly `sessionId` this is a no-op (the
 * legacy marker is not consulted). Otherwise the new (project-keyed) marker
 * is written, plus a legacy dual-write for pre-P3 launchers.
 */
export function writeResumeTarget(sessionId: string, options: ResumeTargetOptions = {}): void {
  const id = sessionId.trim()
  if (id.length === 0) return
  const newFile = resumeMarkerFile(options)
  if (quietRead(newFile) === id) return // F4: dedupe against the NEW marker only.

  mkdirSync(dirname(newFile), { recursive: true })
  writeFileSync(newFile, `${id}\n`)

  // TODO(0.4.0): remove legacy dual-write (transition compat for pre-P3 launchers)
  const legacyFile = legacyResumeMarkerFile(options)
  try {
    mkdirSync(dirname(legacyFile), { recursive: true })
    writeFileSync(legacyFile, `${id}\n`)
  } catch {
    // Best effort — a pre-P3 launcher just misses the anchor in this process.
  }
}

/**
 * Forget the marker(s) — a fresh session. Blanks both the new and the legacy
 * marker (best-effort); the legacy side is keyed by `legacyCwd ?? cwd`.
 */
export function clearResumeTarget(options: ResumeTargetOptions = {}): void {
  for (const file of [resumeMarkerFile(options), legacyResumeMarkerFile(options)]) {
    try {
      writeFileSync(file, '')
    } catch {
      // Best effort — the marker is a launcher nicety.
    }
  }
}

/**
 * The stored session id, or undefined when absent/blank.
 *
 * Dual-read, order pinned: blank/absent files are discarded first, then the
 * survivors are compared by `statSync().mtimeMs` — newer wins, ties go to the
 * new (project-keyed) marker.
 */
export function readResumeTarget(options: ResumeTargetOptions = {}): string | undefined {
  const candidates = [
    { path: resumeMarkerFile(options), content: '', isNew: true },
    { path: legacyResumeMarkerFile(options), content: '', isNew: false },
  ]
  let survivors = 0
  let winner: { path: string; content: string; isNew: boolean } | undefined
  for (const candidate of candidates) {
    const content = quietRead(candidate.path)
    if (content.length === 0) continue
    candidate.content = content
    survivors += 1
    winner = candidate
  }
  if (survivors === 0) return undefined
  if (survivors === 1) return winner?.content

  // Two survivors: compare their mtimes; ties favour the new marker.
  const older = candidates.find(c => !c.isNew) ?? candidates[0]!
  const newer = candidates.find(c => c.isNew) ?? candidates[1]!
  let mtimeOlder = -Infinity
  let mtimeNewer = -Infinity
  try { mtimeOlder = statSync(older.path).mtimeMs } catch { /* treat as oldest */ }
  try { mtimeNewer = statSync(newer.path).mtimeMs } catch { /* treat as oldest */ }
  if (mtimeOlder === mtimeNewer) return newer.content
  return mtimeOlder > mtimeNewer ? older.content : newer.content
}
