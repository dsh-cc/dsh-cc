/**
 * Session-title sidecar: a one-line UTF-8 `title.txt` colocated with each
 * persisted session at `<dsh home>/sessions/--<project slug>--/<sessionId>/`.
 * The TUI /resume listing reads it instead of paying a full zstd decode + JSONL
 * scan per session through the host title snapshot path.
 *
 * All functions are best-effort: every I/O error is swallowed, so a sidecar
 * failure never throws across a title generation, a rename, or the picker.
 * @module @dsh-cc/memory
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { projectSlug } from './paths.ts'

/** Maximum sidecar title length in Unicode code points. */
export const TITLE_SIDECAR_MAX_CODE_POINTS = 200

/** Injectable filesystem root for tests; defaults to the harness sessions dir. */
export interface TitleSidecarOptions {
  /** Override for `<dsh home>/sessions` (test seam only). */
  sessionsRoot?: string
}

function sessionsDir(sessionCwd: string, options?: TitleSidecarOptions): string {
  const sessionsRoot = options?.sessionsRoot ?? join(defaultDshHome(), 'sessions')
  return join(sessionsRoot, `--${projectSlug(sessionCwd)}--`)
}

/**
 * Derive the sidecar path for one session. The harness groups persisted
 * sessions under `--<slug>--` (session-persistence-jsonl `projectKey` wraps
 * the same slug encoder in `--` on both sides); the match must be byte-exact
 * or the sidecar is silently never found.
 * @param sessionCwd - the session's working directory.
 * @param sessionId - the session id.
 * @param options - optional sessions-root override (tests).
 * @returns the absolute `title.txt` path.
 */
export function titleSidecarPath(sessionCwd: string, sessionId: string, options?: TitleSidecarOptions): string {
  return join(sessionsDir(sessionCwd, options), sessionId, 'title.txt')
}

/**
 * Write the sidecar (truncated to ≤200 code points, never splitting a
 * surrogate pair), via temp-file+rename in the same directory. Best-effort:
 * all errors, including temp cleanup, are swallowed.
 * @param sessionCwd - the session's working directory.
 * @param sessionId - the session id.
 * @param title - the title to persist.
 * @param options - optional sessions-root override (tests).
 */
export function writeTitleSidecar(sessionCwd: string, sessionId: string, title: string, options?: TitleSidecarOptions): void {
  const target = titleSidecarPath(sessionCwd, sessionId, options)
  const temp = target + `.${process.pid}.${Date.now()}.tmp`
  try {
    // ponytail: Array.from walks code points (surrogate-safe); a grapheme-aware
    // split would be overkill for a picker label.
    const truncated = Array.from(title).slice(0, TITLE_SIDECAR_MAX_CODE_POINTS).join('')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temp, truncated, 'utf8')
    renameSync(temp, target)
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      // temp never landed or was already renamed — nothing to clean.
    }
  }
}

/**
 * Read the sidecar when it exists and is fresh: its mtime must not be older
 * than the session log's (`session.v3.jsonl.zstd`, falling back to
 * `session.jsonl.zstd`); a missing session log counts as fresh. Missing,
 * empty, unreadable, or stale sidecars return `undefined` so the caller
 * falls back to the host title snapshot path.
 * @param sessionCwd - the session's working directory.
 * @param sessionId - the session id.
 * @param options - optional sessions-root override (tests).
 * @returns the trimmed title, or `undefined`.
 */
export function readTitleSidecar(sessionCwd: string, sessionId: string, options?: TitleSidecarOptions): string | undefined {
  try {
    const target = titleSidecarPath(sessionCwd, sessionId, options)
    const stat = statSync(target)
    if (stat.size === 0) return undefined
    const dir = dirname(target)
    try {
      // Missing session log ⇒ the sidecar counts as fresh.
      const v3 = statSync(join(dir, 'session.v3.jsonl.zstd')).mtimeMs
      if (stat.mtimeMs < v3) return undefined
    } catch {
      try {
        const v1 = statSync(join(dir, 'session.jsonl.zstd')).mtimeMs
        if (stat.mtimeMs < v1) return undefined
      } catch {
        // No session log at all — fresh.
      }
    }
    const title = readFileSync(target, 'utf8').trim()
    // Invalid UTF-8 decodes to U+FFFD; treat that as corruption so the caller
    // falls back to the host snapshot path.
    if (title.length === 0 || title.includes('\uFFFD')) return undefined
    return title
  } catch {
    return undefined
  }
}
