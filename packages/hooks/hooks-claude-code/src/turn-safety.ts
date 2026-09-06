/**
 * Turn-safety state and shaping for the bridge: the F1 consecutive Stop-block
 * machinery (per-agent counters, the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` cap
 * override, and disposal cleanup), the F2 `continue:false` halt helper, and
 * the F3 notice surfacing. Split from index.ts for the line budget; apply()
 * builds it once via {@link createTurnSafety} and the listeners call into it.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { MergedHookOutcome } from '@dsh-cc/hook-protocol'
import type { HookIssue } from '@dsh-cc/hook-protocol'

/** The `{kind:'plugin'}` source stamped on context/steer messages from this module. */
const PLUGIN_SOURCE: { kind: 'plugin'; plugin: string } = { kind: 'plugin', plugin: 'hooks-claude-code' }

/** The reference stop-hook consecutive-block cap (CC parity), used when the env override is absent or invalid. */
const DEFAULT_STOP_BLOCK_CAP = 8

/**
 * Resolve the F1 stop-hook block cap once at load: a positive-integer
 * `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` env value wins; `0`, garbage, or an absent
 * variable falls back to the CC default of 8.
 */
function resolveStopBlockCap(): number {
  const n = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STOP_BLOCK_CAP
}

/** The hook-issue writer dependency (diagnostics are optional). */
type RecordIssue = ((issue: HookIssue) => void) | undefined

/** The last open turn number in the agent's log, or 0 without an agent. */
export function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** The turn-safety API the bridge listeners use (see {@link createTurnSafety}). */
export interface TurnSafety {
  /** F1: a REAL user turn breaks the stop-block chain for this agent. */
  resetBlocks(agentId: string): void
  /** Whether the agent currently has a nonzero consecutive Stop-block count. */
  hasBlocks(agentId: string): boolean
  /** F3: surface every hook `systemMessage` as a durable notice (see the module surfaceNotices doc). */
  surfaceNotices(point: string, merged: MergedHookOutcome | { systemMessages: string[] }, agent: Agent | undefined): void
  /** F2: honor `continue:false` by halting the run; true when a halt was applied. */
  applyHalt(point: string, merged: MergedHookOutcome, agent: Agent | undefined): boolean
  /** F1 counting for a Stop hook `deny` decision: steer-and-increment or cap-override. */
  onStopDeny(agent: Agent, merged: MergedHookOutcome): void
  /** F1 cleanup: free every counter and pairing recorded for THIS session id. */
  releaseSession(sessionId: string): void
  /** Build additional model context from hook output, or undefined when empty. */
  contextFrom(merged: MergedHookOutcome): UserMessage | undefined
  /** Prepend one context without flattening source fields or other downstream metadata. */
  prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[]
  /**
   * Detached/emit points have no in-flight run to halt — the accepted F2
   * partial is logging the stopReason only (documented degradation).
   */
  detachedOutcome(point: string, merged: MergedHookOutcome, agent?: Agent): void
}

/**
 * Build the turn-safety cluster once per plugin instance. State lives here:
 * the per-agent stop-block counters and the agent→session pairing disposal
 * needs, keyed by agent.id so a subagent Stop block never corrupts the root
 * agent's counter (the events carry `{agent}` per-agent).
 */
export function createTurnSafety(deps: { ctx: Context; recordIssue?: RecordIssue }): TurnSafety {
  const { ctx } = deps
  const recordIssue = deps.recordIssue
  const stopBlocks = new Map<string, number>()
  const agentSession = new Map<string, string>()
  const stopBlockCap = resolveStopBlockCap()

  /**
   * F3: surface every hook `systemMessage` (plus bridge-synthesized notices
   * pushed onto `merged.systemMessages`) as a durable notice. Shaping: collapse
   * whitespace, trim, 200-char cap, and a `(<point> hook message)` fallback
   * when nothing readable remains. With an agent handle the notice is injected
   * as a plugin-sourced user message (the TUI renders it as a dim status row);
   * without one it degrades to a warn. Notices use `source.kind:'plugin'`, so
   * they never look like user input and never reset the F1 counter.
   */
  function surfaceNotices(point: string, merged: MergedHookOutcome | { systemMessages: string[] }, agent: Agent | undefined): void {
    for (const raw of merged.systemMessages) {
      const summary = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
      const text = summary.length > 0 ? summary : `(${point} hook message)`
      if (agent !== undefined) {
        agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'hooks-claude-code', form: 'notice', summary: text } }))
      } else {
        ctx.logger.warn(`hooks-claude-code: ${point} hook message: ${text}`)
      }
    }
  }

  /**
   * F2: honor `continue:false` by halting the run. Returns true when a halt
   * was applied — the caller must then return its point-specific decision so
   * nothing proceeds under the racing cancel. The notice carries the mandatory
   * discarded-input sentence (`agent.cancel` drops queued + steering work).
   * Nothing is recorded in diagnostics: a halt is a decision, not an error.
   */
  function applyHalt(point: string, merged: MergedHookOutcome, agent: Agent | undefined): boolean {
    if (!merged.stop) return false
    merged.systemMessages.push(`Halted by ${point} hook: ${merged.stopReason ?? 'continue:false'} — any queued input was discarded`)
    agent?.cancel({ kind: 'hook', reason: merged.stopReason ?? `${point} hook requested continue:false` })
    return true
  }

  return {
    resetBlocks(agentId) {
      stopBlocks.delete(agentId)
    },
    hasBlocks(agentId) {
      return (stopBlocks.get(agentId) ?? 0) > 0
    },
    surfaceNotices,
    applyHalt,
    onStopDeny(agent, merged) {
      const count = stopBlocks.get(agent.id) ?? 0
      agentSession.set(agent.id, agent.session.header.id)
      if (count >= stopBlockCap) {
        // F1 override: do NOT steer; surface, warn, record a stop-cap
        // diagnostic, and reset the counter for the agent's next turn. The
        // cancel also clears the steering backlog the earlier blocks queued —
        // without it the machine re-runs a turn per pending steer and the loop
        // never ends (the review's dual-steer-owners risk; the cancel is the
        // sanctioned stopping-transition defeat).
        merged.systemMessages.push(`Stop hook overridden after ${stopBlockCap} consecutive block(s); the turn is ending`)
        ctx.logger.warn(`hooks-claude-code: Stop hook overridden after ${stopBlockCap} consecutive block(s); the turn is ending`)
        recordIssue?.({ ts: new Date().toISOString(), dialect: 'claude-code', point: 'Stop', kind: 'stop-cap', detail: `overridden after ${stopBlockCap} consecutive block(s)` })
        agent.cancel({ kind: 'hook', reason: `Stop hook overridden after ${stopBlockCap} consecutive block(s)` })
        stopBlocks.set(agent.id, 0)
      } else {
        // A blocking Stop hook forces continuation (the steer path — the only
        // path that increments the counter).
        const text = merged.reason ?? 'continue: blocked by Stop hook'
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
        stopBlocks.set(agent.id, count + 1)
      }
    },
    releaseSession(sessionId) {
      for (const [agentId, id] of agentSession) {
        if (id === sessionId) {
          stopBlocks.delete(agentId)
          agentSession.delete(agentId)
        }
      }
    },
    contextFrom(merged) {
      if (merged.additionalContext.length === 0) return undefined
      const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
      return createUserMessage({ content, source: PLUGIN_SOURCE })
    },
    prependContext(ours, theirs) {
      return [ours, ...theirs ?? []]
    },
    detachedOutcome(point, merged, agent) {
      surfaceNotices(point, merged, agent)
      if (merged.stop) {
        ctx.logger.warn(`hooks-claude-code: ${point} hook requested continue:false (${merged.stopReason ?? 'no stopReason'}), but the point has no in-flight run to halt`)
      }
    },
  }
}
