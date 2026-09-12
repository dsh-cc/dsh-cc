/**
 * Replay-safe, model-free microcompaction of stale tool-result surface nodes.
 *
 * Unlike summarization, microcompaction never calls a model: it collapses only
 * the oldest tool results (beyond a retention window) into deterministic
 * placeholder text, re-embedding any spill locator the original cited so the
 * full result stays retrievable. The decision is frozen per session — a second
 * pass over unchanged history emits a byte-identical prompt — and every
 * landed replacement is returned in the pass result (the placeholder marker
 * makes it reconstructable from the log even without a companion event;
 * out-of-repo plugins cannot extend the upstream session vocabulary).
 *
 * @module @dsh-cc/compaction-micro
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/prune` shadow-price SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import {
  MICROCOMPACT_MARKER,
  isMicrocompactPlaceholder,
  resolveConfig,
  reuseSpillLocator,
} from './config.ts'
import type {
  MicrocompactConfig,
  MicrocompactEntry,
  MicrocompactResult,
  ResolvedConfig,
} from './types.ts'

export { DEFAULTS, MICROCOMPACT_MARKER, isMicrocompactPlaceholder, reuseSpillLocator, resolveConfig } from './config.ts'
export type {
  MicrocompactConfig,
  MicrocompactEntry,
  MicrocompactResult,
  ResolvedConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    microcompactor: Microcompactor
  }
}

interface SnapshotCandidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
}

const keepSchema = z.number().step(1).min(1)
const placeholderCharsSchema = z.number().step(1).min(1)

/**
 * Model-free retention-window microcompaction service. Keeps the most recent
 * {@link MicrocompactConfig.retainResults} tool results verbatim and replaces
 * every older one with a deterministic placeholder that reuses the original
 * spill locator when one was cited. Each replacement preserves the complete
 * event data except for `content`, cites the shadowed node for replay, and is
 * immediately preceded by a `compaction/prune` shadow-price event pricing the
 * shadowed node through the injected token meter — mirroring the sibling
 * `ToolResultPruner` shadow-price protocol.
 */
export class Microcompactor extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so retainer-based pressure genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<MicrocompactConfig> = z.object({
    retainResults: keepSchema,
    auto: z.boolean(),
    placeholderChars: placeholderCharsSchema,
  })

  /** Resolved and immutable policy. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: MicrocompactConfig = {}) {
    super(ctx, 'microcompactor')
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticMicrocompact()
  }

  /**
   * Register an `agent/pre-step` hook that collapses stale tool results ahead
   * of the turn's request, so compaction-basic's summarizer reads an already
   * window-reduced surface. Enabled only when `auto: true`.
   */
  private _registerAutomaticMicrocompact(): void {
    const { ctx } = this
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = this.microcompactSession(agent.session)
          if (result.replaced.length > 0) {
            ctx.logger.info(
              `microcompact: collapsed ${result.replaced.length} stale tool result(s) `
              + `(retain ${this.config.retainResults})`,
            )
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`microcompact failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
  }

  /**
   * Collapse every out-of-window tool result from one stable current-surface
   * snapshot. The most recent `retainResults` tool results are kept verbatim;
   * each older result that is not already a placeholder is replaced by a
   * deterministic placeholder (reusing the original's spill locator when one is
   * cited). Already-collapsed results are never re-decided, so a repeated pass
   * over unchanged history emits a byte-identical prompt (freeze semantics).
   * @param session - session whose current surface is rewritten.
   * @returns landed placeholder replacements and a stability flag.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  microcompactSession(session: Session): MicrocompactResult {
    const candidates = snapshotCandidates(session)
    const retainedFrom = Math.max(0, candidates.length - this.config.retainResults)

    const replaced: MicrocompactEntry[] = []
    for (const candidate of candidates.slice(0, retainedFrom)) {
      const { seq, event } = candidate
      const message = event.data.message
      const content = message.content[0]
      const resultBlock = content?.type === 'tool-result' ? content : undefined
      const blocks: readonly ContentBlock[] = resultBlock?.content ?? []
      if (isMicrocompactPlaceholder(blocks)) continue

      const locatorLine = reuseSpillLocator(plainText(blocks))
      const placeholder = this.placeholderContent(locatorLine)

      // Preserve every non-content field of the original tool-result block (type,
      // toolCallId, isError, plus future additions) so the surface rewrite honors
      // the "may change only content" invariant.
      const replacementBlock: ToolResultBlock = resultBlock === undefined
        ? { type: 'tool-result', toolCallId: message.source.callId, content: [{ type: 'text', text: placeholder }] }
        : { ...resultBlock, content: [{ type: 'text', text: placeholder }] }
      const replacementMessage = freezeMessage<ToolResultMessage>({
        ...message,
        content: [replacementBlock],
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent so a pure consumer subtracts the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message: replacementMessage,
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      // Decision metadata stays in the returned pass result only: out-of-repo
      // plugins cannot extend the upstream session event vocabulary, so the
      // fork's log-only `compaction/microcompact` record is intentionally not
      // appended. The placeholder content already carries the deterministic
      // marker, so the decision reconstructs from replay + code alone.
      replaced.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: message.source.callId,
        ...(locatorLine === undefined ? {} : { spillLocator: locatorLine }),
      })
    }
    return { replaced, stable: replaced.length === 0 }
  }

  /** Deterministic placeholder body for one collapsed tool result. */
  private placeholderContent(locatorLine: string | undefined): string {
    const markerText = `${MICROCOMPACT_MARKER} (tool result collapsed by microcompact; `
      + 'the call id and human retrieval remain available in the session log)'
    if (locatorLine === undefined || locatorLine.length === 0) {
      return shrinkPlaceholder(markerText, this.config.placeholderChars)
    }
    const combined = `${markerText}\n${locatorLine}`
    return shrinkPlaceholder(combined, this.config.placeholderChars + locatorLine.length)
  }
}

/** Collect a stable surface-order snapshot of current `tool/result` nodes. */
function snapshotCandidates(session: Session): SnapshotCandidate[] {
  const candidates: SnapshotCandidate[] = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    /* v8 ignore next -- surface seqs are validated contiguous log references. */
    if (event?.type === 'tool/result') candidates.push({ seq, event })
  }
  return candidates
}

/** Concatenate text from `text`-typed content blocks (code points). */
function plainText(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/**
 * Bound a placeholder to at most `cap` code points without splitting a
 * surrogate pair (grapheme clusters may still split). The marker prefix is
 * always kept so the result remains a recognizable placeholder.
 */
function shrinkPlaceholder(text: string, cap: number): string {
  const points = Array.from(text)
  if (points.length <= cap) return text
  return points.slice(0, cap).join('')
}

export default Microcompactor
