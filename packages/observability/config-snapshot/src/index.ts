/**
 * Passive per-Session-construction config snapshot sidecar. A `{ global: true }`
 * `session/created` listener appends one JSONL row per Session construction to
 * `<dshHome>/config-snapshot/<encodedId>.jsonl`. Detector-only: no Service, no
 * event emission, no transcript writes; every failure is swallowed at debug
 * level so session creation is never blocked (§3.2, §3.7).
 *
 * @see docs/plans/2026-10-09-session-config-snapshot-event.md
 * @module @dsh-cc/config-snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import: also loads the dsh-session module augmentation that
// declares the scoped `session/created` event on the cordis Events map.
import type { Session } from '@deepseek-ai/dsh-session'
import {
  onSessionCreated,
  registerEnabledReader,
  resolveHome,
  type SnapshotDeps,
} from './capture.ts'
import { SidecarWriter } from './writer.ts'

export { encodeSegment } from './encode.ts'
export { FALLBACK_VERSION, readOwnVersion } from './version.ts'
export { SCHEMA_VERSION, selectRow, type SnapshotPluginRow, type SnapshotRow } from './row.ts'
export { SidecarWriter } from './writer.ts'
export {
  drain,
  normalizeHarnessVersion,
  onSessionCreated,
  PLUGINS_STATE_CORRUPT,
  pluginRows,
  presetIdOf,
  resolveHome,
  type CaptureFields,
  type CapturedSession,
  type SnapshotDeps,
} from './capture.ts'

export const name = 'config-snapshot'

/** Per-process monotonic counter incremented on every activation (§3.4 bootId). */
let activationCount = 0

/**
 * Mount the capture listener. Returns the disposer; a providerless host (no
 * resolvable home) mounts a no-op listener so the plugin stays inert, not
 * absent — enabling a later kill-switch/settings layer stays consistent.
 */
export function apply(ctx: Context): () => void {
  // bootId: per ACTIVATION, distinct even for two activations in one
  // millisecond of the same process (§3.4).
  activationCount += 1
  const bootId = `${process.pid}-${Date.now()}-${activationCount}`
  const home = resolveHome(ctx)
  const writer = new SidecarWriter()
  const enabled = registerEnabledReader(ctx)
  const debug = (message: string): void => {
    try {
      (ctx.logger as { debug?: (m: string) => void }).debug?.(message)
    } catch {
      // never propagate
    }
  }
  const deps: SnapshotDeps = {
    home,
    bootId,
    writer,
    enabled,
    get: (key) => {
      try {
        return ctx.get(key)
      } catch {
        return undefined
      }
    },
    debug,
  }
  const dispose = ctx.on('session/created', (session: Session) => {
    onSessionCreated(deps, session)
  }, { global: true })
  return () => {
    try {
      dispose?.()
    } catch {
      // never propagate
    }
  }
}
