/**
 * Durable per-session permission-mode override, stored as `permission/mode`
 * session events (last-wins fold). Because plan mode is owned by plan-mode's own
 * `plan/mode` event, `plan` is never written here — it overlays at call time via
 * `foldPlanMode`. Entering `bypassPermissions` also records the prior sandbox
 * mode as `resumeSandbox` so leaving can restore the pre-bypass confinement.
 *
 * Cross-repo event registration: this module adds `permission/mode` to the
 * upstream `KNOWN_SESSION_EVENT_TYPES` set at load so the persistence layer
 * will resume logs containing it on harness builds whose catalog lacks it
 * (persistence refuses unknown types unless the type is registered there). The
 * set is typed `ReadonlySet` but is a live `Set`. Fold/append go through a
 * local wire face rather than `SessionEventMap['permission/mode']` so both
 * the CI pin (type absent) and a newer local harness (narrower `{mode}`
 * shape) typecheck. PermissionModeEventData carries `auto` and
 * `resumeSandbox`, which postdate both of those catalogs.
 *
 * @module @dsh-cc/permission-rules/mode
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { PLAN_READONLY_REASON, SWITCHABLE_PERMISSION_MODES, type PermissionMode, type SwitchablePermissionMode } from './types.ts'

;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add('permission/mode')

export const PERMISSION_MODE_EVENT = 'permission/mode'

export { PLAN_READONLY_REASON }

/**
 * The `permission/mode` payload as written by this plugin. `auto` and
 * `resumeSandbox` postdate the upstream session event type (which on some
 * harness pins is absent entirely, and on later pins is a narrower
 * `auto`-less shape with no resume field). Events are persisted and folded
 * through this extended face so both pins typecheck. `resumeSandbox` is
 * recorded only when entering `bypassPermissions`.
 */
export interface PermissionModeEventData {
  mode: SwitchablePermissionMode
  resumeSandbox?: SandboxMode
}

/** Wire face of one log event that may or may not be a `permission/mode`. */
interface PermissionModeWire {
  readonly type: string
  readonly data: PermissionModeEventData
}

/** Read a log event through the extended `permission/mode` face. */
function asModeEvent(event: SessionEvent): PermissionModeWire {
  return event as unknown as PermissionModeWire
}

/** Wire face of one log event that may or may not be a `plan/mode`. */
interface PlanModeWire {
  readonly type: string
  readonly data: { active?: boolean }
}

/** Wire face of one log event that may or may not be a `sandbox/mode`. */
interface SandboxModeWire {
  readonly type: string
  readonly data: { mode?: SandboxMode }
}

/**
 * Fold the session's plan mode: whether the last `plan/mode` event is active.
 * Local wire face of the upstream fold (removed from dsh-plan-mode) — the
 * `plan/mode {active}` event vocabulary is unchanged at the pin.
 * @param events - session events in log order (other event types are skipped).
 * @returns true when the last recorded state entered plan mode.
 */
export function foldPlanMode(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as unknown as PlanModeWire
    if (event.type === 'plan/mode') return event.data.active === true
  }
  return false
}

/**
 * Fold the session's live sandbox mode: the last `sandbox/mode` event, or
 * undefined when the session never recorded one. Local wire face of the
 * upstream fold (removed from dsh-sandbox-policy) — last-wins regardless of
 * the event's `source`, including `delegation`-seeded events (matching both
 * the upstream baseline helper and the pin's projection).
 * @param events - session events in log order (other event types are skipped).
 * @returns the last recorded sandbox mode, or undefined without one.
 */
export function foldSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as unknown as SandboxModeWire
    if (event.type === 'sandbox/mode') return event.data.mode
  }
  return undefined
}

/**
 * Fold the session's live permission mode: the last `permission/mode` value, or
 * undefined when the session never recorded one (callers apply the default).
 * @param events - session events in log order (other event types are skipped).
 * @returns the last recorded switchable mode, or undefined without one.
 */
export function foldPermissionMode(events: readonly SessionEvent[]): SwitchablePermissionMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = asModeEvent(events[i]!)
    if (event.type === PERMISSION_MODE_EVENT) return event.data.mode
  }
  return undefined
}

/**
 * Fold the sandbox mode a session should restore when it leaves `bypassPermissions`:
 * the `resumeSandbox` of the most recent bypass event, or undefined when no bypass
 * event recorded one.
 * @param events - session events in log order.
 * @returns the recorded resume mode, or undefined without one.
 */
export function foldResumeSandbox(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = asModeEvent(events[i]!)
    if (event.type === PERMISSION_MODE_EVENT && event.data.mode === 'bypassPermissions' && event.data.resumeSandbox !== undefined) {
      return event.data.resumeSandbox
    }
  }
  return undefined
}

/**
 * Append one durable `permission/mode` event. `plan` (and any unknown mode)
 * throws: those are not writable through this channel. `resumeSandbox`, when
 * given, is recorded alongside so a later leave restores the prior confinement.
 * @param session - the session the override belongs to.
 * @param mode - the new switchable permission mode.
 * @param resumeSandbox - the sandbox to restore on leaving bypass, recorded only
 *   when entering `bypassPermissions`.
 */
export function setPermissionMode(session: Session, mode: SwitchablePermissionMode, resumeSandbox?: SandboxMode): void {
  if (!(SWITCHABLE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new TypeError(`permission mode must be one of ${SWITCHABLE_PERMISSION_MODES.join(', ')}`)
  }
  const data: PermissionModeEventData = {
    mode,
    ...resumeSandbox !== undefined ? { resumeSandbox } : {},
  }
  ;(session.append as (type: string, payload: PermissionModeEventData) => unknown)(PERMISSION_MODE_EVENT, data)
}

/**
 * The arguments face of {@link switchSessionPermissionMode}: everything the
 * switch needs from the calling service, captured once (all uses are
 * synchronous, so the shell mode snapshot is equivalent to a fresh read).
 */
export type SwitchSessionPermissionModeArgs = {
  /** The live agent whose session mode is changing. */
  agent: Agent
  /** The new permission mode (`plan` throws — owned by plan-mode). */
  mode: PermissionMode
  /** The deployment-default mode the current fold compares against. */
  defaultMode: PermissionMode
  /** Whether `bypassPermissions` is disabled (Config or the settings section). */
  bypassDisabled: boolean
  /** The host shell service's sandbox mode, when mounted. */
  shellMode: SandboxMode | undefined
}

/**
 * Switch a session's permission mode durably (the body of the service's
 * `setMode`). `plan` is owned by plan-mode and throws here (enter on the same
 * session via plan-mode's `/plan`). Entering `bypassPermissions` pins the
 * session sandbox to `danger-full-access` and records the prior mode for
 * restore; leaving restores the recorded (or fallback `workspace-write`)
 * confinement. Unknown or disabled modes throw. A best-effort user message is
 * injected announcing the change (a headless agent without inject is silent —
 * the mode is already durable).
 */
export function switchSessionPermissionMode(args: SwitchSessionPermissionModeArgs): void {
  const { agent, mode, defaultMode, bypassDisabled, shellMode } = args
  if (mode === 'plan') {
    throw new TypeError('permission mode "plan" is owned by plan-mode; use /plan or /permissions plan')
  }
  if (!SWITCHABLE_PERMISSION_MODES.includes(mode)) {
    throw new TypeError(`permission mode must be one of ${[...SWITCHABLE_PERMISSION_MODES, 'plan'].join(', ')}`)
  }
  if (mode === 'bypassPermissions' && bypassDisabled) {
    throw new Error('bypassPermissions is disabled by disableBypassPermissionsMode')
  }
  const session = agent.session
  const current = foldPermissionMode(session.snapshotEvents()) ?? defaultMode
  if (current === mode) return

  const wasBypass = current === 'bypassPermissions'
  const enteringBypass = mode === 'bypassPermissions'

  if (enteringBypass) {
    const resume = foldSandboxMode(session.snapshotEvents()) ?? shellMode
    const alreadyFull = (foldSandboxMode(session.snapshotEvents()) ?? shellMode) === 'danger-full-access'
    setPermissionMode(session, mode, resume)
    if (!alreadyFull) setSandboxMode(session, 'danger-full-access')
  } else {
    setPermissionMode(session, mode)
    if (wasBypass) {
      const restore = foldResumeSandbox(session.snapshotEvents()) ?? shellMode ?? 'workspace-write'
      if ((foldSandboxMode(session.snapshotEvents()) ?? shellMode) !== restore) {
        setSandboxMode(session, restore)
      }
    }
  }

  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `The permission mode changed to "${mode}" (changed by the user).` }],
      source: { kind: 'plugin', plugin: 'permission-rules' },
    }))
  } catch {
    // Tests and headless agents may omit inject; mode is already durable.
  }
}
