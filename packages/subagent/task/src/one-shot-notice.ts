/**
 * Parent-scoped subagent-child notice (memory-recall hardening follow-ups
 * W2c): on `agent/pre-step`, ONLY the agent whose `session.id` matches a
 * ledger row's `parentId` gets one folded observe-only line — contributed
 * via `agent.inject()` + `createUserMessage` with a dedicated
 * `MessageSourceMap` kind, mirroring `packages/memory/memory/src/recall.ts`'s
 * contribution shape — when that session has ≥1 active non-internal
 * one-shot child. Zero emission otherwise: sessions with no children see
 * nothing; internal-only activity yields at most a folded count, never
 * per-child rows.
 *
 * Registration follows `strip-instructions.ts` / `suppress-settled.ts`: a
 * plain `agent/pre-step` waterfall listener that delegates to `next()`
 * unchanged (observe-only). No `prepend` — unlike the strip, this listener
 * reads only the ledger and its own agent, so ordering is irrelevant.
 *
 * @module @dsh-cc/subagent-task/one-shot-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { OneShotLedgerRow } from './one-shot-ledger.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    ccSubagentChild: { kind: 'cc-subagent-children' }
  }
}

/** MessageSourceMap kind for the observe-only child notice. */
export const CHILD_NOTICE_SOURCE_KIND = 'cc-subagent-children'

/**
 * Fold the active children of one parent into the single observe-only line.
 * Non-internal children surface their labels; internal children fold into a
 * bare count (`… +N internal`), and internal-only activity yields a count
 * line with no per-child rows at all.
 */
export function foldChildNotice(rows: readonly { label?: string; internal: boolean }[]): string {
  const visible = rows.filter(row => !row.internal)
  const internalCount = rows.length - visible.length
  if (visible.length === 0 && internalCount === 0) return ''
  const parts: string[] = []
  if (visible.length > 0) {
    const labels = visible.map(row => row.label ?? 'unlabeled')
    parts.push(`${visible.length} active subagent child${visible.length === 1 ? '' : 'ren'}: ${labels.join(', ')}`)
  }
  if (internalCount > 0) parts.push(`+${internalCount} internal`)
  return `[observe] ${parts.join(' ')}`.trim()
}

/** The ledger surface the notice listener reads. */
export interface ChildNoticeLedger {
  activeFor(parentId: string): readonly OneShotLedgerRow[]
}

/**
 * Mount the `agent/pre-step` child-notice listener.
 * @param ctx - the plug context.
 * @param ledger - the ledger to read.
 * @returns an unmount callback.
 */
export function mountSubagentChildNotice(ctx: Context, ledger: ChildNoticeLedger): () => void {
  return ctx.on('agent/pre-step', async ({ agent }: { agent: Agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // Fire-and-forget: the notice is model-visible enrichment, never worth
    // an unhandled rejection in the host.
    try {
      const sid = (agent.session as { id?: unknown } | undefined)?.id
      if (sid === undefined) return decision
      const active = ledger.activeFor(String(sid))
      if (active.length === 0) return decision
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: foldChildNotice(active) }],
        source: { kind: 'cc-subagent-children' },
      }))
    } catch {
      // Absent llm seam or inject surface: skip quietly.
    }
    return decision
  })
}
