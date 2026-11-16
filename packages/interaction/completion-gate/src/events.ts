/**
 * Session event vocabulary for the completion gate (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.2; enforce-mode
 * markers from docs/plans/2026-11-17-completion-gate-enforce-mode.md §3.2):
 * the `Receipt` wire shape, the five event types, their `SessionEventMap`
 * augmentation, the `MessageSourceMap` augmentation for the injected nudge
 * source, and the module-load registration into `KNOWN_SESSION_EVENT_TYPES`
 * (the live-Set idiom of `@dsh-cc/session-cwd` — required so the persistence
 * read path treats the types as known; sessions written with these events are
 * unresumable on builds without the plugin, precedent-consistent, §7.6).
 *
 * @module @dsh-cc/completion-gate/events
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** A receipt is appended after every settled tool execution (§3.2). */
export const RECEIPT_EVENT = 'completion-gate/receipt'

/** A nudge is appended when a matched claim has no satisfying receipt. */
export const NUDGE_EVENT = 'completion-gate/nudge'

/** A resolved event is appended when a matching receipt lands after a nudge. */
export const RESOLVED_EVENT = 'completion-gate/resolved'

/**
 * Exhaustion OBSERVATION (enforce mode, plan
 * docs/plans/2026-11-17-completion-gate-enforce-mode.md §3.2): "the gate
 * exhausted its cycle budget for this turn". Appended at turn-stopping time,
 * idempotent per turn. It says NOTHING about whether the turn ended — other
 * listeners may still continue it.
 */
export const EXHAUSTED_EVENT = 'completion-gate/enforce-exhausted'

/**
 * Terminal record (enforce mode, §3.2): "this turn ended with the gate
 * exhausted AND the final assistant message still carrying unmatched claims".
 * Appended ONLY by the `turn/end` reconciliation (§3.5), never at
 * turn-stopping time.
 */
export const UNVERIFIED_EVENT = 'completion-gate/unverified'

/** The injected user-message source kind carrying gate nudges (§3.4). */
export const COMPLETION_GATE_SOURCE_KIND = 'completion-gate'

// Persistence refuses unknown non-ignorable event types; the set is typed
// ReadonlySet but is a live Set — same registration idiom as session-cwd.
for (const type of [RECEIPT_EVENT, NUDGE_EVENT, RESOLVED_EVENT, EXHAUSTED_EVENT, UNVERIFIED_EVENT]) {
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(type)
}

/** Payload of both enforce-mode marker events (§3.2). */
export interface EnforceMarker {
  /** The turn the marker belongs to. */
  turn: number
  /** Unmatched claim ids at record time. */
  claims: string[]
  /** `digest16` of the judged final assistant text. */
  assistantTextHash: string
  /** Set when the window's LAST gate inject threw (§3.3.2) — the model never saw it. */
  lastInjectFailed?: boolean
}

/**
 * One tool execution's receipt (§3.2). Hashes correlate claims to executions
 * without persisting content; `head` (privacy-scrubbed, ≤200 bytes) exists
 * only on bash rows captured while `cc-completion-gate.enabled` was true, and
 * is OMITTED from the JSONL ledger row (ledger is hash-only).
 */
export interface Receipt {
  /** Schema version. */
  v: 1
  /** Date.now() at execute time (forensics only — window logic uses snapshot order). */
  ts: number
  /** Owning session id, or null when no session is reachable (disk write is then skipped). */
  sessionId: string | null
  /** The tool call id. */
  callId: string
  /** Canonical tool id (not a CC alias). */
  tool: string
  /** sha256(stableJson(exec.arguments))[:16]. */
  argsDigest: string
  /** Execution outcome. */
  outcome: 'ok' | 'error'
  /** Structured error code (HarnessError-derived failures only; else null). */
  errorCode: string | null
  /** sha256(joined text blocks)[:16], computed BEFORE `next()` (§3.2). */
  contentHash: string
  /** Total UTF-8 byte length of the joined text blocks. */
  textBytes: number
  /** First 200 bytes of the scrubbed bash command — session events ONLY, never the ledger. */
  head?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One tool execution's hashed receipt (bash rows may carry a scrubbed `head`). */
    'completion-gate/receipt': Receipt
    /** A matched claim lacked satisfying evidence; `missingReceipt` is always true at emit time. */
    'completion-gate/nudge': { claim: string; missingReceipt: boolean; assistantTextHash: string; cycle?: number }
    /** A matching receipt landed after a nudge for the same claim. */
    'completion-gate/resolved': { claim: string; via: string }
    /** The enforce cycle budget ran out for this turn (observation only, §3.2). */
    'completion-gate/enforce-exhausted': EnforceMarker
    /** The turn ended exhausted with unmatched claims still standing (§3.2). */
    'completion-gate/unverified': EnforceMarker
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The injected nudge user-message source kind (advisor precedent, wiring.ts:40-44). */
    'completion-gate': { kind: 'completion-gate' }
  }
}
