/**
 * Ctrl+B promotion section (UX plan §3.4): promote every armed foreground
 * subagent collect of the CURRENT session to background. Structural split of
 * the same logic from `./driver.ts`.
 * @module @dsh-cc/tui/harness/driver-promote
 */

import type { Context } from '@deepseek-ai/cordis'
import { backgroundTasksDisabled } from '@dsh-cc/subagent-task'

/**
 * Create the promote handler for one driver instance. The collect path (Task
 * tool) registers each in-flight foreground collect under parentSessionId +
 * toolCallToken in the root-realm `ccCollectorRegistry` (published by the
 * cc-subagent-task plugin, CcPlugins pattern); `promote()` on a handle
 * releases the wait (`async_launched` + `backgroundedByUser: true` tool
 * result) and leaves the child untouched — its settlement notice later
 * delivers normally. Gated by the env kill switch; an absent registry or
 * session change degrades to 0 (nothing promotable).
 *
 * The session filter compares against the LIVE agent's session id via the
 * `current` holder, so a switch after construction promotes the new session's
 * collects, exactly like the previous inline closure.
 */
export function createPromoteSection(
  ctx: Context,
  current: { agent: { session: { id: unknown } } },
): () => number {
  const promoteForegroundCollects = (): number => {
    if (backgroundTasksDisabled()) return 0
    const registry = (ctx.get('ccCollectorRegistry') as {
      collectorsForSession?(parentSessionId: string): { promote(): void }[]
    } | undefined)
    if (registry?.collectorsForSession === undefined) return 0
    const armed = registry.collectorsForSession(String(current.agent.session.id))
    for (const handle of armed) handle.promote()
    return armed.length
  }
  return promoteForegroundCollects
}
