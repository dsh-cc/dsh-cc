/**
 * Guard for context that a DETACHED hook (SessionStart, SubagentStart)
 * resolves after its target agent already finished working.
 *
 * `Agent.inject` queues next-step context WITHOUT waking the driver: an idle
 * agent keeps it pending until a follow-up or steer wakes it. For a resident
 * continuable subagent child that is fatal: the harness settlement watcher
 * treats any pending inbox item as outstanding work (`inbox.hasPending` →
 * `wait`) and waits for a wake that never comes, so the child's epoch never
 * settles, `subagent/end` never fires, and a foreground `subagent_fork`
 * collect hangs forever.
 *
 * Rule: when the target is a LIVE subagent child that has already run at
 * least one turn and is idle now, the late context is dropped with a warn
 * (it can no longer precede the work it was meant for). Every other case
 * injects as before — notably an idle child that has NOT started yet (the
 * first pre-step claims the context) and any root agent (its next user turn
 * claims it).
 *
 * @module @dsh-cc/hooks-claude-code/late-inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface LateInjectGuard {
  /** True when injecting into `agent` now would strand its settlement. */
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
  const stranded = (agent: Agent): boolean =>
    liveSubagentIds.has(String(agent.id)) && ran.has(agent) && agent.status === 'idle'
  return {
    stranded,
    inject(agent, message, point) {
      if (stranded(agent)) {
        ctx.logger.warn(`hooks-claude-code: ${point} hook context resolved after subagent ${String(agent.id)} finished its turn; dropped (an idle child cannot claim injected context, and pending input would block its settlement)`)
        return
      }
      agent.inject(message)
    },
  }
}
