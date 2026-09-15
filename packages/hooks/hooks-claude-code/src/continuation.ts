/**
 * A3 max-tokens continuation: at `agent/turn-stopping`, when the LAST assistant
 * attempt ended on the model's output ceiling (`max-tokens` finish frame), the
 * bridge steers a CC-worded next-step resume message (up to a cap, default 3)
 * instead of running Stop — the turn is not logically ending. The gate reads
 * the last attempt's serialized compact stream, NOT the sticky `turn/end`
 * reason (a `max-tokens` reason survives a later successful recovery and would
 * burn the whole cap). Chain state is keyed per (agent.id, turn number).
 * Split from register-events.ts for the line budget.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** The `{kind:'plugin'}` source stamped on continuation steer messages. */
const PLUGIN_SOURCE: { kind: 'plugin'; plugin: string } = { kind: 'plugin', plugin: 'hooks-claude-code' }

/** The default number of continuations per turn (CC parity), used when the env override is absent or invalid. */
const DEFAULT_CONTINUATION_CAP = 3

/**
 * The exact CC-parity resume wording steered on an output-ceiling hit.
 * Deliberately not configurable (config-is-prompt).
 */
export const CONTINUATION_TEXT =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.'

/**
 * Resolve the continuation cap: a non-negative-integer env value wins — `0`
 * DISABLES the feature; garbage or an absent variable falls back to the
 * default of 3.
 */
export function resolveContinuationCap(): number {
  const n = Number(process.env.CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CONTINUATION_CAP
}

/**
 * Whether the agent's LAST assistant attempt (the durable compact
 * `assistant/attempt` / `assistant/message` stream record) ended on a
 * `max-tokens` finish frame. The stream's terminal record is the raw
 * `{type:'chunk', chunk:{type:'finish', reason}}` shape the harness
 * compaction preserves verbatim.
 */
export function lastAttemptHitCeiling(agent: Agent): boolean {
  if (!agent) return false
  const events = [...agent.session.snapshotEvents()]
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event || (event.type !== 'assistant/attempt' && event.type !== 'assistant/message')) continue
    const stream = (event.data as { stream?: readonly unknown[] }).stream ?? []
    const last = stream[stream.length - 1] as
      | { type?: string; chunk?: { type?: string; reason?: { kind?: string } } }
      | undefined
    return last?.type === 'chunk' && last.chunk?.type === 'finish' && last.chunk.reason?.kind === 'max-tokens'
  }
  return false
}

/** The continuation-chain API the bridge listeners use (see {@link createContinuation}). */
export interface Continuation {
  /**
   * At a stopping event: if the last attempt hit the ceiling and this turn's
   * chain is under the cap, steer the continuation and return true (the
   * caller must then SKIP the Stop run point); otherwise false — fall through
   * to the normal Stop path.
   */
  tryContinue(agent: Agent, turn: number): boolean
  /** A REAL user turn ends any open continuation chain for this agent. */
  onUserPrompt(agentId: string): void
  /** Free every chain and pairing recorded for THIS session id. */
  releaseSession(sessionId: string): void
}

/**
 * Build the continuation gate once per plugin instance. Chain state is one
 * `{turn, count}` entry per agent: a stopping event whose turn differs from
 * the recorded chain turn resets the count (continuations run as next steps
 * INSIDE the same turn, so a new turn number means the chain is over).
 */
export function createContinuation(deps: { ctx: Context }): Continuation {
  const { ctx } = deps
  const cap = resolveContinuationCap()
  const chains = new Map<string, { turn: number; count: number }>()
  const agentSession = new Map<string, string>()

  return {
    tryContinue(agent, turn) {
      const chain = chains.get(agent.id)
      if (!chain || chain.turn !== turn) chains.set(agent.id, { turn, count: 0 })
      if (cap === 0 || !lastAttemptHitCeiling(agent)) return false
      const current = chains.get(agent.id)!
      if (current.count >= cap) return false
      current.count++
      if (agent.session) agentSession.set(agent.id, agent.session.header.id)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: CONTINUATION_TEXT }],
        source: PLUGIN_SOURCE,
      }))
      ctx.logger.info(`hooks-claude-code: output-token ceiling hit — steered continuation ${current.count}/${cap} for turn ${turn}`)
      return true
    },
    onUserPrompt(agentId) {
      chains.delete(agentId)
    },
    releaseSession(sessionId) {
      for (const [agentId, id] of agentSession) {
        if (id === sessionId) {
          chains.delete(agentId)
          agentSession.delete(agentId)
        }
      }
    },
  }
}
