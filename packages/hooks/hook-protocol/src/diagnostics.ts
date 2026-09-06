/**
 * Durable, best-effort hook-issue diagnostics: a JSONL file (one {@link HookIssue}
 * per line) that bridges append to and `/doctor` reads back. Every filesystem
 * error is swallowed — diagnostics must never break a hook run, and a torn or
 * foreign line is skipped by readers rather than trusted.
 * @module @dsh-cc/hook-protocol/diagnostics
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HookDialect } from './types.ts'

/** The class of hook problem a {@link HookIssue} records. */
export type HookIssueKind = 'timeout' | 'exit-code' | 'parse-failure' | 'spawn-failure' | 'stop-cap' | 'config'

/**
 * One recorded hook issue. `ts` is the ISO timestamp of the recording, `point`
 * the hook point, `kind` the issue class, and `detail` a bounded human-readable
 * explanation (`handlerId` optional, correlating with `hook/*` events).
 */
export interface HookIssue {
  ts: string
  dialect: HookDialect
  point: string
  kind: HookIssueKind
  detail: string
  handlerId?: string
}

/** The hard cap on `HookIssue.detail` (characters) — diagnostics stay bounded. */
const DETAIL_MAX_CHARS = 500

/** The file size (bytes) past which the log is compacted on the next append. */
const MAX_FILE_BYTES = 256 * 1024

/** How many of the newest valid lines a compaction keeps. */
const COMPACT_KEEP_LINES = 100

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse one JSONL line into a {@link HookIssue}, or `undefined` when the line is
 * malformed/torn (readers skip those; concurrency across processes is
 * best-effort by design).
 */
function issueOf(line: string): HookIssue | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  const obj = asObject(parsed)
  if (!obj) return undefined
  if (typeof obj.ts !== 'string' || typeof obj.point !== 'string' || typeof obj.kind !== 'string' || typeof obj.detail !== 'string') {
    return undefined
  }
  if (typeof obj.dialect !== 'string') return undefined
  const issue = obj as unknown as HookIssue
  return typeof issue.handlerId === 'string' || issue.handlerId === undefined ? issue : undefined
}

/** Every valid {@link HookIssue} in the file, oldest first; `[]` when unreadable/absent. */
function readValidIssues(path: string): HookIssue[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const issues: HookIssue[] = []
  for (const line of text.split('\n')) {
    const issue = issueOf(line)
    if (issue !== undefined) issues.push(issue)
  }
  return issues
}

/**
 * Build a best-effort appender for the JSONL diagnostics file at `path`. Each
 * call appends one JSON line (its `detail` capped at 500 chars); when the file
 * would exceed 256 KB it is first rewritten keeping the newest 100 valid lines.
 * Every filesystem error is swallowed — the returned function NEVER throws.
 * @param path - the diagnostics file path (append target).
 * @returns an appender taking one {@link HookIssue} per call.
 */
export function hookDiagnosticsWriter(path: string): (issue: HookIssue) => void {
  return (issue: HookIssue): void => {
    try {
      const entry: HookIssue = { ...issue, detail: issue.detail.slice(0, DETAIL_MAX_CHARS) }
      const line = JSON.stringify(entry) + '\n'
      // Compact BEFORE appending when this entry would push the file past the
      // cap: rewrite the newest valid lines, then append as usual. A failed
      // compaction (or stat) falls through to the plain append, also best-effort.
      try {
        const nextSize = statSync(path).size + Buffer.byteLength(line)
        if (nextSize > MAX_FILE_BYTES) {
          const keep = readValidIssues(path).slice(-COMPACT_KEEP_LINES)
          writeFileSync(path, keep.map((kept) => JSON.stringify(kept) + '\n').join(''))
        }
      } catch {
        // Compaction is opportunistic; appending still proceeds.
      }
      // Best-effort: ensure the parent directory exists (a fresh dsh home has
      // no `hooks/` yet); like every fs step here, failure is swallowed.
      try {
        mkdirSync(dirname(path), { recursive: true })
      } catch {
        // Appending below still reports its own failure.
      }
      appendFileSync(path, line)
    } catch {
      // Diagnostics must never break a hook: swallow every fs error.
    }
  }
}

/**
 * Read the last `limit` valid {@link HookIssue}s from the JSONL file at `path`,
 * oldest first. Malformed/torn lines are skipped; a missing or unreadable file
 * yields `[]`. Never throws.
 * @param path - the diagnostics file path.
 * @param limit - how many of the newest entries to return.
 * @returns up to `limit` valid issues, oldest first.
 */
export function readHookDiagnostics(path: string, limit: number): HookIssue[] {
  const issues = readValidIssues(path)
  return issues.length > limit ? issues.slice(issues.length - limit) : issues
}
