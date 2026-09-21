/**
 * foldCounters seam for @dsh-cc/token-efficiency (design
 * docs/plans/2026-09-20-token-efficiency-eval-harness.md §3.4).
 *
 * The marker/ledger shape knowledge lives HERE (the feature owns it): if the
 * marker contract or tool-result extraction drifts, this fold and its tests
 * must change in the same PR — never a silently-wrong foreign regex.
 *
 * @module @dsh-cc/context-crusher/fold-counters
 */

import { parseMarker } from './marker.ts'

/**
 * Structural materials contract shared by every efficiency-feature fold.
 * Declared locally (no cross-package import); the loose event shape
 * intentionally mirrors SessionLogEvent without depending on dsh-session.
 */
export interface FoldCounterMaterials {
  readonly events: readonly {
    readonly type: string
    readonly time?: number
    readonly data?: Record<string, unknown> | undefined
  }[]
  readonly dshHome: string
}

/**
 * Extract every text fragment from a tool/result event's message content.
 * Handles the real dsh-llm shapes: string content, text blocks, and
 * nested tool-result blocks (content: ContentBlock[]).
 */
function resultTexts(data: unknown): string[] {
  const content = (data as { message?: { content?: unknown } } | undefined)?.message?.content
  const texts: string[] = []
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return texts
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; content?: unknown }
    if (b.type === 'tool-result') {
      for (const inner of (Array.isArray(b.content) ? b.content : []) as { text?: unknown }[]) {
        if (typeof inner?.text === 'string') texts.push(inner.text)
      }
    } else if (typeof b?.text === 'string') {
      texts.push(b.text)
    }
  }
  return texts
}

/**
 * Fold CCR evidence in session streams: `ccr.applied` (marker count),
 * `ccr.tokensBefore` (ΣN), `ccr.tokensAfter` (ΣM).
 */
export function foldCounters(materials: FoldCounterMaterials): Record<string, number> {
  let applied = 0
  let tokensBefore = 0
  let tokensAfter = 0
  for (const event of materials.events) {
    if (event.type !== 'tool/result') continue
    for (const text of resultTexts(event.data)) {
      for (const line of text.split('\n')) {
        const marker = parseMarker(line.trim())
        if (marker === null) continue
        applied += 1
        tokensBefore += marker.tokensBefore
        tokensAfter += marker.tokensAfter
      }
    }
  }
  return { 'ccr.applied': applied, 'ccr.tokensBefore': tokensBefore, 'ccr.tokensAfter': tokensAfter }
}
