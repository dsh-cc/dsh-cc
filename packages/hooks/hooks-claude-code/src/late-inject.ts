/**
 * Guard for context that a DETACHED hook (SessionStart, SubagentStart)
 * resolves while its target subagent child is already working.
 *
 * `Agent.inject` queues next-step context WITHOUT waking the driver: it lands
 * in `inbox.nextStep`, and the agent loop observes a non-empty inbox at the
 * step boundary and opens another step, whose model request the callers never
 * budgeted for. The harness settlement watcher additionally treats any pending
 * inbox item as outstanding work (`inbox.hasPending` → `wait`) and waits for a
 * wake that never comes, so an idle child's epoch never settles.
 *
 * Policy: detached SessionStart/SubagentStart context is delivered ONLY when
 * it resolves before the target subagent child's first inbox claim. After the
 * first claim the work has started and the context can no longer precede it,
 * so it is dropped with a warn. This intentionally WITHDRAWS the previous
 * behavior where a late-resolving block was delivered into a later step of a
 * running child — that delivery is exactly what re-opens a closing turn under
 * load (issue #318: a third model request, `stopReason "error"`). Root agents
 * are unaffected: the drop requires membership in `liveSubagentIds`.
 *
 * @module @dsh-cc/hooks-claude-code/late-inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface LateInjectGuard {
  /**
   * True when injecting into `agent` now would strand its settlement.
   *
   * Both call sites also use this to gate the `agent` argument passed to
   * `turnSafety.detachedOutcome(...)`: post-claim, `systemMessage` notices for
   * a live child are therefore suppressed too (converted to the drop warn)
   * instead of re-opening the turn. That is intended — notices ride the same
   * reopen window as injected context.
   */
  stranded(agent: Agent): boolean
  /** Inject unless stranded; a stranded delivery is dropped with a warn. */
  inject(agent: Agent, message: Parameters<Agent['inject']>[0], point: string): void
}

export function createLateInjectGuard(deps: { ctx: Context; liveSubagentIds: ReadonlySet<string> }): LateInjectGuard {
  const { ctx, liveSubagentIds } = deps
  // Agents observed `running` at least once. WeakSet: no release edge needed.
  const ran = new WeakSet<Agent>()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') ran.add(agent)
  })
  // Agents that consumed at least one inbox item. The emit is synchronous and
  // fires in `preStep` BEFORE payload assembly and the model request, so
  // "claimed" ⇔ input consumed / work started.
  const claimed = new WeakSet<Agent>()
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    claimed.add(agent)
  })
  // `ran` + idle-status is belt-and-suspenders for paths where the claim
  // observation could be missed (listener registration order, an empty claim):
  // a child that already worked and is idle now can never claim context again.
  const stranded = (agent: Agent): boolean =>
    liveSubagentIds.has(String(agent.id)) && (claimed.has(agent) || (ran.has(agent) && agent.status === 'idle'))
  return {
    stranded,
    inject(agent, message, point) {
      if (stranded(agent)) {
        // Two distinct texts: an idle child is a settlement hazard; a
        // running, already-claimed child would be re-opened at the next step.
        if (claimed.has(agent) && agent.status !== 'idle') {
          ctx.logger.warn(`hooks-claude-code: ${point} hook context resolved after subagent ${String(agent.id)} claimed its first input; dropped (it can no longer precede the work, and delivery would re-open the running turn)`)
          return
        }
        ctx.logger.warn(`hooks-claude-code: ${point} hook context resolved after subagent ${String(agent.id)} finished its turn; dropped (an idle child cannot claim injected context, and pending input would block its settlement)`)
        return
      }
      agent.inject(message)
    },
  }
}
