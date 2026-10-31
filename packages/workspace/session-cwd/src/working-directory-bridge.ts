/**
 * Bridge between dsh-cc's synchronous cwd overlay and the harness
 * `workingDirectory` service (single-owner migration, S10).
 *
 * Three duties, all best-effort and silent when the service is absent:
 * 1. mirror `working-directory/change` events into the sync overlay so sync
 *    consumers agree with what execution actually uses;
 * 2. hydrate the service from the overlay when an agent appears, so sessions
 *    resumed from legacy `worktree/entered` logs start executing in the
 *    directory the overlay advertises;
 * 3. publish the service to the leaf holder so `setSessionCwd` can write
 *    through.
 *
 * @module @dsh-cc/session-cwd/working-directory-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { getSessionCwdForSession } from './api.ts'
import { setWorkingDirectoryService, type WorkingDirectoryLike } from './service-holder.ts'
import { sessionCwdStore } from './state.ts'

/** Session event carrying the upstream service's committed directory. */
const WORKING_DIRECTORY_CHANGE = 'working-directory/change'

interface ChangeEventData {
  readonly cwd?: unknown
}

/**
 * Install the bridge on a context that can resolve the service.
 * @param ctx - the plugin context (a child context may be used for injection).
 */
export function installWorkingDirectoryBridge(ctx: Context): void {
  const service = ctx.get('workingDirectory') as WorkingDirectoryLike | undefined
  if (service === undefined) return
  const log = ctx.get('logger') as { debug?: (message: string) => void } | undefined
  setWorkingDirectoryService(service, message => log?.debug?.(message))

  ctx.on('session/event', (session: Session, event: { type: string; data?: unknown }) => {
    if (event.type !== WORKING_DIRECTORY_CHANGE) return
    const cwd = (event.data as ChangeEventData | undefined)?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) sessionCwdStore.set(String(session.id), cwd)
  }, { global: true })

  ctx.on('agent/created', (payload: { agent: Agent }) => {
    // Must stay side-effect-free in its return value: cordis `serial` stops at
    // the first non-nullish return and later creation listeners would not run.
    hydrateWorkingDirectory(payload.agent, service)
  }, { global: true })

  ctx.effect(() => () => { setWorkingDirectoryService(undefined) }, 'session-cwd.working-directory-bridge()')
}

/**
 * Align the service with the overlay for one live agent (legacy resume path).
 * @param agent - the agent to align.
 * @param service - the resolved service.
 */
export function hydrateWorkingDirectory(agent: Agent, service: WorkingDirectoryLike): void {
  const overlay = getSessionCwdForSession(agent.session)
  if (overlay === undefined) return
  const current = service.get(agent.session)
  if (current === overlay) return
  void service.set(agent, overlay).catch(() => {
    // The service revalidates on the next ensure; the overlay stays authoritative
    // for sync consumers either way.
  })
}
