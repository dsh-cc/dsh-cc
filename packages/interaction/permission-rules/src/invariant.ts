/**
 * Package-owned invariant companion for `@dsh-cc/permission-rules`.
 * Guards the closed vocabulary of durable `permission/mode` session events and
 * rejects illegal payloads at the session boundary.
 * @module @dsh-cc/permission-rules/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SWITCHABLE_PERMISSION_MODES } from './types.ts'
import type { PermissionModeEventData } from './mode.ts'

const PACKAGE_NAME = '@dsh-cc/permission-rules'

/** Cordis companion plugin name. */
export const name = 'cc-permission-rules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one `permission/mode` event against its closed vocabularies. `plan`
 * is never writable through this event (it is owned by plan-mode's `plan/mode`),
 * and `resumeSandbox` must be a known sandbox mode when present.
 * @param event - the session event to validate.
 * @param fail - reporter bound to this package, throwing on violation.
 */
export function assertPermissionModeEvent(event: SessionEvent, fail: InvariantFailure): void {
  const wire = event as unknown as { type: string; data: PermissionModeEventData }
  if (wire.type !== 'permission/mode') return
  const data = wire.data
  if (!(SWITCHABLE_PERMISSION_MODES as readonly string[]).includes(data.mode)) {
    fail(`permission/mode carries unknown mode ${JSON.stringify(data.mode)} (plan is owned by plan-mode)`)
  }
  if (data.resumeSandbox !== undefined && !(SANDBOX_MODES as readonly string[]).includes(data.resumeSandbox)) {
    fail(`permission/mode carries unknown resumeSandbox ${JSON.stringify(data.resumeSandbox)}`)
  }
}

/** Install closed-vocabulary checks on durable permission/mode events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const seed = (session: Session): void => {
    for (const event of session.events) assertPermissionModeEvent(event, fail)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    void session
    assertPermissionModeEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
