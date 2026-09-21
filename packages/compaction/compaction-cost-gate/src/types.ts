/**
 * Shared state, config, and gate types for the cost-gated plan-step
 * compaction service. Nothing here is durable: per-root-session stats live
 * in memory only; the ledger is the sole on-disk record.
 * @module @dsh-cc/compaction-cost-gate/types
 */

import type { ModelPrice } from '@dsh-cc/command-cost'

/** One todos-array entry as delivered in the `todo_write` tool arguments. */
export interface TodoItem {
  /** Step text; content-hash identity for the snapshot differ. */
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** In-memory per-root-session state (design §3.2). */
export interface SessionStats {
  /** A todo completed since the last idle evaluation. */
  boundaryArmed: boolean
  /** Main-loop provider requests observed for this session. */
  streamRequestCount: number
  /** Todos transitioned to completed, cumulative. */
  completedSteps: number
  /** Content hash → status of the latest todos snapshot. */
  lastTodoSnapshot: Map<string, string>
  /** Unamortized rewrite debt from past compactions. */
  rewriteDebt: { tokens: number; requestsSince: number }[]
  /** Epoch ms until which the gate stays silent after a compaction. */
  cooldownUntil: number
  /** Consecutive REAL defect-class failures (§3.5); busy/cancelled excluded. */
  consecutiveFailures: number
  /** Pause latch after the failure fuse trips. */
  paused: boolean
  /** Title of the todo whose completion armed the current boundary. */
  lastCompletedTitle?: string
  /** Measured context reduction of the last compaction; undefined until measured. */
  lastShrink?: number
  /** Context tokens observed immediately before the last fired compaction. */
  preCompactContextTokens?: number
  /** Last observed provider/model route (main-loop requests only). */
  lastProvider?: string
  lastModel?: string
}

/** Resolved settings namespace value (`cc-compaction-cost-gate`). */
export interface CostGateSettings {
  enabled: boolean
  mode: 'dry-run' | 'on'
  margin: number
  cooldownMs: number
  windowPressureTokens?: number
  modelTable?: ModelPrice[]
}

/** Inputs of the pure gate arithmetic (§3.3). */
export interface GateInput {
  /** Σ tokenMeter.estimateMessage over message-carrying surface nodes. */
  contextTokens: number
  streamRequestCount: number
  completedSteps: number
  /** Non-completed todos in the latest snapshot; 0 never fires. */
  pendingSteps: number
  /** Measured reduction of the last compaction; cold prior 0.5. */
  lastShrink?: number
  /** Unamortized debt entries (tokens, requests seen since the compact). */
  rewriteDebt: readonly { tokens: number; requestsSince: number }[]
  /** Required savings multiple (default 1.0). */
  margin: number
  /** When set, prices savings at the cache-read and rewrite at the cache-write rate. */
  price?: { cacheReadPerMTok: number; cacheWritePerMTok: number }
  /** Window-pressure bypass (cooldown and fuse are the caller's concern). */
  windowPressureTokens?: number
}

/** Outcome of the pure gate arithmetic. */
export interface GateOutcome {
  pass: boolean
  /** Non-completed todos considered (0 forces pass=false). */
  pendingSteps: number
  /** streamRequestCount / max(completedSteps, 1), floored at 1. */
  requestsPerStep: number
  /** The shrink factor actually used (measured value or the 0.5 cold prior). */
  shrink: number
  /** contextTokens × shrink × requestsPerStep × pendingSteps. */
  projectedSavedInput: number
  /** Rewritten prefix (contextTokens) plus unamortized debt tokens. */
  rewriteCost: number
  /** Sum of debt entries still inside the amortization window. */
  debtTokens: number
  /** True when the window-pressure threshold bypassed the margin comparison. */
  windowPressureOverride: boolean
}

/** Compaction requests observed per root session (main-loop only). */
export const DEBT_AMORTIZE_REQUESTS = 5

/** Default shrink prior before the first measured compaction. */
export const COLD_SHRINK_PRIOR = 0.5

/** Consecutive real-failure threshold that pauses the feature per session. */
export const FAILURE_FUSE = 3
