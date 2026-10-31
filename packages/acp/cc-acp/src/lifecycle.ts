/**
 * Agent lifecycle listeners (harness 0.2.1-rc.5 shapes).
 *
 * Upstream changed the `agent/error` payload (no `turn`) and added
 * `agent/status`; status transitions settle a cancelled-but-admitted prompt.
 * Kept in its own module so `index.ts` stays inside its size budget.
 *
 * @module @dsh-cc/acp/lifecycle
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The handler surface one owned session record exposes. */
export interface AgentLifecycleHandlers {
  onAgentError(error: unknown): void
  onAgentStatus(status: string): void
}

/**
 * Install the lifecycle listeners.
 * @param ctx - the plugin context.
 * @param owned - resolves the record owning an agent, if any.
 */
export function installAgentLifecycleListeners(
  ctx: Context,
  owned: (agent: Agent) => AgentLifecycleHandlers | undefined,
): void {
  ctx.on('agent/error', ({ agent, error }) => { owned(agent)?.onAgentError(error) })
  ctx.on('agent/status', ({ agent, status }) => { owned(agent)?.onAgentStatus(status) })
}
