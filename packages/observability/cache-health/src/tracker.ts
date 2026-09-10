/**
 * Pure prefix-stability tracking for the prompt-cache health observer.
 *
 * The wire prefix of a model request is system → tools → messages, in order.
 * Each segment is canonical-JSON serialized (recursive key sort) and hashed
 * with sha256; per session we keep the previous call's hash list and report
 * the longest common prefix. Hashing stops at the first difference (early
 * exit), so a drift near the front of a long conversation is cheap.
 *
 * No cordis, fs, or dsh imports beyond dsh-llm types — fully unit-testable.
 *
 * @module @dsh-cc/cache-health/tracker
 */

import { createHash } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Injectable hash function signature (tests count calls to verify early exit). */
export type HashFn = (text: string) => string

/** sha256 hex, first 16 chars — the shared project-key shape (context-crusher idiom). */
export function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

/** Default segment hash: sha256 hex. */
export const sha256Hex: HashFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Canonical JSON: deterministic, key-sorted serialization for hashing.
 * Objects sort keys lexicographically; arrays keep order; `undefined`
 * properties are dropped (JSON semantics). No dependency — ~20 lines.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${serialize(item)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Build the drift excerpt: canonical-serialize, collapse whitespace runs,
 * redact secret-shaped runs, truncate to 80 chars.
 * @param text - the canonical serialization of the drifted segment source.
 */
export function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ')
  const redacted = collapsed
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
  return redacted.length > 80 ? redacted.slice(0, 80) : redacted
}

/**
 * One observed model request's prefix-stability verdict against the session's
 * previous call.
 *
 * Note: rows reflect the RAW PRE-MIDDLEWARE view of `llm/stream` options, not
 * a wire-faithful rendering. A future middleware rewriting options in
 * `llm/stream` would make this ledger under-report churn.
 */
export interface PrefixObservation {
  /** Number of leading segments whose hash equals the previous call's. */
  readonly stableSegments: number
  /** Estimated tokens of the stable prefix (canonical length / 4, rounded). */
  readonly stablePrefixTokensEst: number
  /** Whether a previously-stable segment changed (prefix bust, not a tail append). */
  readonly prefixChanged: boolean
  /** Zero-based index of the first differing segment (system=0, tools=1, messages 2+). */
  readonly driftSegmentIndex?: number
  /** Redacted, truncated serialization of the drifted segment source. */
  readonly driftExcerpt?: string
}

/**
 * Per-session in-memory prefix tracker. One instance per mounted plugin.
 * Segment 0 = system, 1 = tools, 2+ = messages in order. On drift the hash
 * list stops at the drifted index, so the NEXT call verifies only that
 * (shorter) prefix — stableSegments may temporarily under-count after a
 * drift; `prefixChanged` stays correct.
 */
// ponytail: truncating the stored hash list after drift under-counts the next
// call's stableSegments; store unhashed stubs if that ever matters.
export class PrefixTracker {
  private readonly prev = new Map<string, readonly string[]>()

  constructor(private readonly hash: HashFn = sha256Hex) {}

  /**
   * Observe one model request for a session. Purely read-only on `options`;
   * never mutates the request.
   */
  observe(sessionId: string, options: GenerateOptions): PrefixObservation {
    const sources: unknown[] = [options.system ?? '', options.tools ?? [], ...options.messages]
    const prev = this.prev.get(sessionId) ?? []
    const hashes: string[] = []
    let stable = 0
    let tokens = 0
    let prefixChanged = false
    let driftSegmentIndex: number | undefined
    let driftExcerpt: string | undefined
    for (let i = 0; i < sources.length; i++) {
      const text = canonicalJson(sources[i])
      if (i < prev.length) {
        const h = this.hash(text)
        if (h === prev[i]) {
          stable += 1
          tokens += text.length
          hashes.push(h)
          continue
        }
        // First difference: report and stop hashing (early exit).
        prefixChanged = true
        driftSegmentIndex = i
        driftExcerpt = excerpt(text)
        break
      }
      // New tail segment beyond the previous list: extend, no bust.
      hashes.push(this.hash(text))
    }
    this.prev.set(sessionId, hashes)
    return {
      stableSegments: prefixChanged ? stable : hashes.length,
      stablePrefixTokensEst: Math.round(tokens / 4),
      prefixChanged,
      ...(driftSegmentIndex !== undefined ? { driftSegmentIndex } : {}),
      ...(driftExcerpt !== undefined ? { driftExcerpt } : {}),
    }
  }
}
