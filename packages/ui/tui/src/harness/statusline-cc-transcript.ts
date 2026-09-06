/**
 * CC-shape plaintext JSONL transcript mirror (statusline Slice C): a per-session
 * mirror of the harness session events translated into the line shape
 * ccstatusline reads (`message.usage` with the four token fields, ISO
 * `timestamp`, `type` of 'assistant'/'user'). The statusline payload advertises
 * the mirror as `transcript_path` ONLY while it is `ready` — a readable-but-
 * empty file would make ccstatusline's fail-soft produce an all-zeros metrics
 * object, and those zeros shadow truthful stdin fallbacks (`??` passes zeros
 * through), so a mirror with no assistant usage is never created. Writes are
 * atomic per rebuild (tmp file + rename; multi-TUI last-writer-wins yields
 * complete files) and append-only per live event under a seq watermark. Any fs
 * error permanently disables the mirror: appends run on the synchronous
 * session-append hot path, so no retries, and later appends to a corrupt
 * stream are worse than silence. This module never imports harness types —
 * events are consumed structurally, matching the sibling modules' convention.
 * @module @dsh-cc/tui/harness/statusline-cc-transcript
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { defaultTuiDir } from '../history.ts'

/** Maximum age (ms) a mirrored file survives the GC sweep. */
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Structural view of a harness session event ({type, data, seq, time}). */
export type CcSessionEventLike = {
  type?: unknown
  data?: unknown
  seq?: unknown
  time?: unknown
}

/** Whether a value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Structural read of a usage record; all four fields normalize to 0. */
function usageOf(data: unknown): {
  inputTokens: unknown
  outputTokens: unknown
  cacheReadTokens: unknown
  cacheWriteTokens: unknown
} | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const usage = (data as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
  }
}

/**
 * Translate harness session events into CC transcript lines. Only
 * `assistant/message` events with finite input/output usage and a finite time
 * produce assistant lines (with EXPLICIT cache zeros when the source omits the
 * cache fields — the token-meter projection also normalizes them to 0, keeping
 * mirror totals ≡ projection totals); `user/message` events with a finite time
 * produce speed-anchor lines. Everything else is dropped. `stop_reason` is
 * NEVER emitted: if ccstatusline ever sees an own-property `stop_reason` on a
 * message its accumulator switches semantics, so the key is banned outright.
 */
export function translateEventsToCcTranscript(
  events: readonly unknown[],
  sessionId: string,
): string[] {
  const lines: string[] = []
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue
    const event = raw as CcSessionEventLike
    const { type, data, time } = event
    if (!isFiniteNumber(time)) continue
    const timestamp = new Date(time).toISOString()
    if (type === 'assistant/message') {
      const usage = usageOf(data)
      if (usage === undefined) continue
      if (!isFiniteNumber(usage.inputTokens) || !isFiniteNumber(usage.outputTokens)) continue
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp,
        isSidechain: false,
        sessionId,
        message: {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            // Explicit zeros for absent cache fields are intentional: the
            // token-meter normalizes them to 0 too, keeping the mirror totals
            // identical to the projection totals the payload carries.
            cache_creation_input_tokens: isFiniteNumber(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
            cache_read_input_tokens: isFiniteNumber(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
          },
        },
      }))
    } else if (type === 'user/message') {
      lines.push(JSON.stringify({
        type: 'user',
        timestamp,
        isSidechain: false,
        sessionId,
      }))
    }
  }
  return lines
}

/** The sanitized file name stem for a session id. */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The mirror state the wiring consults. */
export type CcTranscriptMirror = {
  /** Whether the mirror currently has a written, non-empty file. */
  isReady(): boolean
  /** The mirror file path when ready, else undefined. */
  getPath(): string | undefined
  /** Full rebuild from the session's event log (atomic rename, GC sweep). */
  rebind(sessionId: string, events: readonly unknown[]): void
  /** Best-effort live append of one event; no-op while not ready. */
  append(event: unknown): void
}

/** Create a CC transcript mirror rooted under `dir` (default the tui dir). */
export function createCcTranscriptMirror(options: { dir?: string } = {}): CcTranscriptMirror {
  const dir = options.dir ?? defaultTuiDir()
  let ready = false
  let path: string | undefined
  let watermark = 0
  let sessionId = ''

  let dead = false

  /** Permanently disable the mirror after any fs failure (no retries). */
  function fail(): void {
    dead = true
    ready = false
    path = undefined
  }

  return {
    isReady(): boolean {
      return ready
    },
    getPath(): string | undefined {
      return path
    },
    rebind(nextSessionId: string, events: readonly unknown[]): void {
      if (dead) return
      sessionId = nextSessionId
      watermark = 0
      const lines = translateEventsToCcTranscript(events, sessionId)
      for (const raw of events) {
        const seq = (raw as CcSessionEventLike | undefined)?.seq
        if (isFiniteNumber(seq) && seq > watermark) watermark = seq
      }
      // A mirror with zero assistant-usage lines would render as an all-zeros
      // metrics object in ccstatusline and shadow truthful stdin values, so
      // nothing is written and the payload stays without a transcript_path.
      if (lines.every((line) => !line.includes('"type":"assistant"'))) {
        ready = false
        path = undefined
        return
      }
      try {
        const ccDir = join(dir, 'cc-transcripts')
        mkdirSync(ccDir, { recursive: true })
        // GC sweep: drop mirrored files older than 30 days (best-effort).
        try {
          for (const name of readdirSync(ccDir)) {
            if (!name.endsWith('.jsonl')) continue
            const filePath = join(ccDir, name)
            try {
              if (Date.now() - statSync(filePath).mtimeMs > GC_MAX_AGE_MS) unlinkSync(filePath)
            } catch { /* per-entry errors are ignored */ }
          }
        } catch { /* sweep failures never break the rebind */ }
        const finalPath = join(ccDir, `${sanitizeSessionId(sessionId)}.jsonl`)
        const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
        writeFileSync(tmpPath, lines.map((line) => `${line}\n`).join(''))
        renameSync(tmpPath, finalPath)
        ready = true
        path = finalPath
      } catch {
        fail()
      }
    },
    append(event: unknown): void {
      if (!ready || path === undefined) return
      if (typeof event !== 'object' || event === null) return
      const seq = (event as CcSessionEventLike).seq
      if (!isFiniteNumber(seq) || seq <= watermark) return
      watermark = seq
      const lines = translateEventsToCcTranscript([event], sessionId)
      if (lines.length === 0) return
      try {
        appendFileSync(path, lines.map((line) => `${line}\n`).join(''))
      } catch {
        fail()
      }
    },
  }
}
