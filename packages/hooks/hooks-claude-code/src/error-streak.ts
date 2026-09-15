/**
 * A2 agent-error streak surfacing: per-agent consecutive/cumulative API-error
 * counters that trip notice-level breakers (CC-observed semantics: 3
 * consecutive / 20 cumulative). Notice-only by design — at `agent/error` the
 * agent is already idle (nothing to cancel) and request retry is harness-owned;
 * dsh-cc's added value is detecting the burn pattern and telling the user +
 * forensics. State is keyed by agent.id (a failing subagent child accumulates
 * its own count independently of the parent — a recorded divergence from CC's
 * session-wide caps) with the same agent→session pairing disposal pattern as
 * turn-safety. Split from register-events.ts for the line budget.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The CC-parity consecutive-error cap, used when the env override is absent or invalid. */
const DEFAULT_CONSECUTIVE_CAP = 3
/** The CC-parity cumulative-error cap, used when the env override is absent or invalid. */
const DEFAULT_TOTAL_CAP = 20

/**
 * Resolve a positive-integer cap (the `resolveStopBlockCap` pattern): an
 * integer `> 0` wins; `0`, garbage, or an absent variable falls back to the
 * default.
 */
function resolvePositiveCap(envName: string, fallback: number): number {
  const n = Number(process.env[envName])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** The streak-state API the bridge listeners use (see {@link createErrorStreak}). */
export interface ErrorStreak {
  /** Count one `agent/error`: increments both counters, trips the caps once each. */
  onError(agent: Agent, error: unknown): void
  /** A stopping event (non-error endings only) resets the consecutive counter. */
  onTurnSettled(agent: Agent, turn: number): void
  /** A REAL user turn resets the consecutive counter. */
  onUserPrompt(agent: Agent): void
  /** Free every counter and pairing recorded for THIS session id. */
  releaseSession(sessionId: string): void
}

/** The notice-surfacing seam (turn-safety's F3 `surfaceNotices`). */
type SurfaceNotices = (point: string, merged: { systemMessages: string[] }, agent: Agent | undefined) => void

/** Per-agent streak state. */
interface Streak {
  consecutive: number
  total: number
  trippedConsecutive: boolean
  trippedTotal: boolean
}

/**
 * Build the error-streak breaker once per plugin instance. The trip action is
 * a warn log plus a durable user notice through the F3 seam; hook-issue
 * diagnostics are deliberately NOT recorded — `HookIssue.kind` in
 * `@dsh-cc/hook-protocol` is a closed union and a notice-level signal does not
 * justify churning the protocol package.
 */
export function createErrorStreak(deps: { ctx: Context; surfaceNotices: SurfaceNotices }): ErrorStreak {
  const { ctx } = deps
  const surfaceNotices = deps.surfaceNotices
  const consecutiveCap = resolvePositiveCap('CLAUDE_CODE_AGENT_ERROR_CONSECUTIVE_CAP', DEFAULT_CONSECUTIVE_CAP)
  const totalCap = resolvePositiveCap('CLAUDE_CODE_AGENT_ERROR_TOTAL_CAP', DEFAULT_TOTAL_CAP)
  const streaks = new Map<string, Streak>()
  const agentSession = new Map<string, string>()

  function stateFor(agent: Agent): Streak {
    let state = streaks.get(agent.id)
    if (!state) {
      state = { consecutive: 0, total: 0, trippedConsecutive: false, trippedTotal: false }
      streaks.set(agent.id, state)
      if (agent.session) agentSession.set(agent.id, agent.session.header.id)
    }
    return state
  }

  function notice(agent: Agent, text: string): void {
    ctx.logger.warn(`hooks-claude-code: ${text}`)
    surfaceNotices('ErrorStreak', { systemMessages: [text] }, agent)
  }

  return {
    onError(agent, error) {
      const state = stateFor(agent)
      state.consecutive++
      state.total++
      const code = stopFailureErrorCode(error)
      if (state.consecutive >= consecutiveCap && !state.trippedConsecutive) {
        state.trippedConsecutive = true
        notice(agent, `${state.consecutive} consecutive API errors this session (last classified: ${code}); request retry is owned by the harness — check provider status or switch model`)
      }
      if (state.total >= totalCap && !state.trippedTotal) {
        state.trippedTotal = true
        notice(agent, `${state.total} cumulative API errors this session (last classified: ${code}); request retry is owned by the harness — check provider status or switch model`)
      }
    },
    // Every stopping event resets `consecutive` (stopping only exists for
    // non-error endings — under the A3 continuation the listener can fire
    // several times within one turn, each still proving the last step did not
    // end in an API error). `total` and both trip latches only reset via
    // releaseSession; `turn` is unused today but kept for listener symmetry.
    onTurnSettled(agent, _turn) {
      const state = streaks.get(agent.id)
      if (state) state.consecutive = 0
    },
    onUserPrompt(agent) {
      const state = streaks.get(agent.id)
      if (state) state.consecutive = 0
    },
    releaseSession(sessionId) {
      for (const [agentId, id] of agentSession) {
        if (id === sessionId) {
          streaks.delete(agentId)
          agentSession.delete(agentId)
        }
      }
    },
  }
}

/**
 * Local copy of the payload layer's CC error-code classification for the
 * notice text (the payload function is module-private; the classification is
 * duplicated deliberately small — drift risk accepted given the notice's
 * coarse wording).
 */
function stopFailureErrorCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'message' in error
    ? (error as { message: unknown }).message
    : error
  const message = String(raw).toLowerCase()
  if (message.includes('rate limit')) return 'rate_limit'
  if (message.includes('authentication') || message.includes('unauthorized') || message.includes('401') || message.includes('permission')) return 'authentication_failed'
  if (message.includes('billing') || message.includes('quota') || message.includes('credit')) return 'billing_error'
  if (message.includes('invalid request') || message.includes('bad request') || message.includes('400')) return 'invalid_request'
  if (message.includes('server error') || message.includes('overloaded') || message.includes('500')) return 'server_error'
  if (message.includes('max_output_tokens') || message.includes('output token')) return 'max_output_tokens'
  return 'unknown'
}
