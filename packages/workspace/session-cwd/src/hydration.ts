/**
 * Legacy cwd hydration. Sessions written before the `workingDirectory` service
 * owned the directory carry `worktree/entered` events but no
 * `working-directory/change`: on `agent/created` this listener migrates the
 * folded legacy value into the service exactly once, by EVENT SEQ precedence
 * (a newer native change is never clobbered — symlink spellings make value
 * comparison unusable).
 *
 * The listener is awaited by the serial `agent/created` dispatch, so hydration
 * completes before any later creation listener and before the agent's first
 * step.
 *
 * @module @dsh-cc/session-cwd/hydration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { WORKTREE_ENTERED_EVENT, foldSessionCwd } from './events.ts'

/** Session event carrying the upstream service's committed directory. */
const WORKING_DIRECTORY_CHANGE = 'working-directory/change'

/** Structural face of the upstream `workingDirectory` service. */
interface WorkingDirectoryLike {
  /** Commit a directory for a live agent; rejects when it does not exist. */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

/** Structural face of the upstream `sessionProjections` registry. */
interface SessionProjectionsLike {
  /** Sync, undefined-able cold read of one projection unit. */
  stateOf(session: Session, key: 'workingDirectory'): unknown
}

/** Seq of the last event of one type in log order. */
function lastSeqOf(events: readonly SessionEvent[], type: string): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === type) return event.seq
  }
  return undefined
}

/**
 * Install the one-shot legacy hydration listener. The service is resolved
 * through the child-plugin injection idiom, so nothing is added to the
 * plugin's static `inject` (a silent PENDING trap).
 * @param ctx - the plugin context.
 * @returns the activation fiber (awaitable), so tests can wait for the listener.
 */
export function installLegacyCwdHydration(ctx: Context): PromiseLike<unknown> {
  return ctx.inject(['workingDirectory', 'sessionProjections'], (child: Context) => {
    const service = child.get('workingDirectory') as WorkingDirectoryLike | undefined
    if (service === undefined) return
    child.on('agent/created', async ({ agent }: { agent: Agent }): Promise<undefined> => {
      const session = agent.session
      const events = session.snapshotEvents()
      const legacySeq = lastSeqOf(events, WORKTREE_ENTERED_EVENT)
      if (legacySeq === undefined) return undefined
      const nativeSeq = lastSeqOf(events, WORKING_DIRECTORY_CHANGE)
      // Native state is newer: never clobber it.
      if (nativeSeq !== undefined && nativeSeq > legacySeq) return undefined
      const folded = foldSessionCwd(events)
      if (folded === undefined) return undefined
      const projections = child.get('sessionProjections') as SessionProjectionsLike | undefined
      const current = projections?.stateOf(session, 'workingDirectory')
      if (typeof current === 'string' && current === folded) return undefined
      try {
        await service.set(agent, folded)
      } catch (error) {
        child.logger.warn(`session-cwd: hydration failed: ${String(error)}`)
      }
      // Always undefined: the serial dispatch must not stop later listeners.
      return undefined
    }, { global: true, prepend: true })
  })
}
