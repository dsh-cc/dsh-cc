import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/**
 * Microcompact policy: how many of the most recent `tool/result` surface nodes
 * are retained verbatim, everything older being eligible for a placeholder
 * replacement.
 */
export interface MicrocompactConfig {
  /** Keep the most recent N tool results verbatim. Defaults to `10`. */
  retainResults?: number
  /**
   * Register an `agent/pre-step` hook that runs the microcompact pass before
   * the turn's model request, so stale results are collapsed ahead of
   * summarization. Defaults to `false` (invoke {@link ToolResultMicrocompactor.microcompactSession} explicitly).
   */
  auto?: boolean
  /** Maximum text code points in a generated placeholder (excluding a re-embedded spill locator). Defaults to `256`. */
  placeholderChars?: number
}

/** Validated, detached, deeply immutable microcompact configuration. */
export interface ResolvedConfig {
  readonly retainResults: number
  readonly auto: boolean
  readonly placeholderChars: number
}

/** One landed placeholder replacement during a microcompact pass. */
export interface MicrocompactEntry {
  /** Full-fidelity tool-result surface seq shadowed by the placeholder. */
  readonly originalSeq: number
  /** Newly appended placeholder tool-result surface seq. */
  readonly replacementSeq: number
  /** Tool call shared by the original and the placeholder. */
  readonly callId: ToolCallId
  /** Spill locator re-embedded into the placeholder, when the original cited one. */
  readonly spillLocator?: string
}

/** Aggregate outcome of one stable-surface microcompact pass. */
export interface MicrocompactResult {
  /** Placeholder replacements in the snapshotted surface order. */
  readonly replaced: readonly MicrocompactEntry[]
  /**
   * Whether this pass changed nothing — every out-of-window result was already
   * a placeholder or within the retention window, so an identical re-run emits
   * a byte-identical prompt.
   */
  readonly stable: boolean
}
