/**
 * Capture wiring (§3.2, §3.5, §3.6): a sync-trivial `session/created` listener
 * (a sync throw would veto session creation, §3.2) that stamps header fields
 * and `appendedAt`, then kicks a fully-caught async writer assembling the row
 * fields. All failures land in the debug log — none escape (§3.7).
 *
 * @see docs/plans/2026-10-09-session-config-snapshot-event.md §3.2, §3.5, §3.6
 * @module @dsh-cc/config-snapshot/capture
 */

import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { listInstalled } from '@dsh-cc/plugin-manager'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'
import { encodeSegment } from './encode.ts'
import { SCHEMA_VERSION, type SnapshotPluginRow, type SnapshotRow } from './row.ts'
import { readOwnVersion } from './version.ts'

/** Kill-switch settings namespace (§3.6), kebab convention. */
const SETTINGS_NAMESPACE = 'config-snapshot' as SettingsNamespace

const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Register the `config-snapshot` namespace and return a fail-open enabled
 * reader (§3.6): absent provider, `undefined`, or a throw all read `true`.
 * NEVER called from the sync listener — the read happens inside the async
 * writer.
 */
export function registerEnabledReader(ctx: Context): () => boolean {
  let read: (() => { enabled?: boolean } | undefined) | undefined
  try {
    read = registerNamespaceSafe<{ enabled?: boolean }>(ctx, SETTINGS_NAMESPACE, SettingsSchema)
  } catch {
    read = undefined // non-duplicate register failure → fail-open default
  }
  return () => {
    try {
      return read?.()?.enabled !== false
    } catch {
      return true
    }
  }
}

/**
 * dshHomePath seam, read defensively (handoff-store precedent §3.3): bare home
 * only — never a subdirectory, the same value feeds `PathInputs.dshHome`.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/**
 * Home resolution, resolved ONCE per activation (§3.3): the boot seam's bare
 * home when mounted, else `$DSH_HOME ?? ~/.dsh`; `undefined` ⇒ the plugin
 * no-ops entirely (providerless host).
 */
export function resolveHome(ctx: Context): string | undefined {
  try {
    const seam = ctx.dshHomePath
    if (typeof seam === 'function') return seam()
  } catch {
    // Seam absent or throwing → env fallback below.
  }
  const env = process.env.DSH_HOME
  if (env !== undefined && env.length > 0) return env
  try {
    return join(homedir(), '.dsh')
  } catch {
    return undefined
  }
}

/** Harness-version wire shapes seen in the wild: `string | { version: string }`. */
export function normalizeHarnessVersion(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof (value as { version?: unknown }).version === 'string') {
    return (value as { version: string }).version
  }
  // No provider exists at this harness pin, so null is the practical value
  // today (§3.5 (b)); a mounted provider upgrades rows with no schema change.
  return null
}

/** `agentPresets.defaultId` narrowed with the consumer typeof guard (§3.5 (c)). */
export function presetIdOf(value: unknown): string | null {
  const presets = value as { defaultId?: unknown } | undefined
  return typeof presets?.defaultId === 'string' ? presets.defaultId : null
}

/** The minimal session surface the capture needs (structural, duck-typed). */
export interface CapturedSession {
  readonly id: unknown
  readonly header?: {
    readonly cwd?: string
    readonly delegationDepth?: number
    readonly parentSession?: unknown
    readonly origin?: 'subagent'
  }
}

/** Header fields + timestamp captured in the SYNC listener body (§3.2). */
export interface CaptureFields {
  readonly sessionId: string
  readonly appendedAt: number
  readonly cwd: string
  readonly delegationDepth: number
  readonly parentSession: string | null
  readonly origin: string | null
}

/** Fixed sanitized reason code when `listInstalled` fails (§3.5 (d)). */
export const PLUGINS_STATE_CORRUPT = 'plugins-state-corrupt'

/** In-flight assemble-task registry (test/drain seam). */
export interface DrainableDeps extends SnapshotDeps {
  readonly inflight?: Set<Promise<void>>
}

/**
 * Sync listener body: header-field capture + `appendedAt` stamp + kick the
 * async writer. NO settings reads, must never throw (§3.2).
 */
export function onSessionCreated(deps: SnapshotDeps, session: CapturedSession): void {
  try {
    if (deps.home === undefined) return // providerless host ⇒ no-op
    const header = session.header ?? {}
    const capture: CaptureFields = {
      sessionId: String(session.id),
      appendedAt: Date.now(),
      cwd: header.cwd ?? process.cwd(),
      delegationDepth: header.delegationDepth ?? 0,
      parentSession: header.parentSession !== undefined ? String(header.parentSession) : null,
      origin: header.origin ?? null,
    }
    const task = assembleAndAppend(deps, capture)
    const inflight = (deps as DrainableDeps).inflight
    if (inflight !== undefined) {
      inflight.add(task)
      void task.finally(() => {
        inflight.delete(task)
      })
    }
    void task.catch((error) => {
      try {
        deps.debug(`config-snapshot: capture failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // never propagate
      }
    })
  } catch {
    // Never throw into session creation (§3.2).
  }
}

/**
 * Drain helper (§3.3/§5 item 4): resolves when every in-flight capture AND
 * every queued write, across all files, has settled. The async field assembly
 * runs outside the per-file queue, so it is awaited first.
 */
export async function drain(deps: SnapshotDeps): Promise<void> {
  const inflight = (deps as DrainableDeps).inflight
  if (inflight !== undefined) await Promise.allSettled([...inflight])
  await deps.writer.drain()
}

/** Per-activation capture dependencies (testable seam). */
export interface SnapshotDeps {
  /** Bare dsh home, resolved once per activation; `undefined` ⇒ no-op. */
  readonly home: string | undefined
  readonly bootId: string
  readonly writer: SidecarWriterLike
  /** Fail-open kill-switch reader, called inside the async writer only. */
  readonly enabled: () => boolean
  /** `ctx.get(key)` duck-read (settings provider, harness seam, presets). */
  readonly get: (key: string) => unknown
  /** Debug sink for swallowed failures (§3.7). */
  readonly debug: (message: string) => void
}

/** Minimal writer surface (`SidecarWriter`). */
export interface SidecarWriterLike {
  append(file: string, build: (seq: number) => unknown): Promise<void>
  drain(): Promise<void>
}

/**
 * Async row assembly (§3.5): kill switch first, then field reads, then a
 * queued append. Any throw is caught by the caller's `.catch(debug)`.
 */
export async function assembleAndAppend(deps: SnapshotDeps, capture: CaptureFields): Promise<void> {
  if (!deps.enabled()) return
  if (deps.home === undefined) return // no-op per §3.3 when no home is resolvable
  const dshCc = await readOwnVersion()
  const harness = normalizeHarnessVersion(deps.get('harnessVersion'))
  const preset = { id: presetIdOf(deps.get('agentPresets')) }
  let plugins: SnapshotPluginRow[] = []
  let note: string | undefined
  try {
    plugins = pluginRows(await listInstalled({
      // §3.5 (d): documented CcPluginManagerOptions defaults, mirrored here.
      claudeHome: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      dshHome: deps.home,
      cwd: capture.cwd,
    }))
  } catch {
    // Corrupt or failed state read ⇒ empty inventory + fixed reason code;
    // never raw error text (it embeds absolute user paths, §3.5 (d)).
    plugins = []
    note = PLUGINS_STATE_CORRUPT
  }
  const row: Omit<SnapshotRow, 'seq'> = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: capture.sessionId,
    bootId: deps.bootId,
    appendedAt: capture.appendedAt,
    dshCc,
    harness,
    preset,
    plugins,
    ...(note !== undefined ? { note } : {}),
    delegationDepth: capture.delegationDepth,
    parentSession: capture.parentSession,
    origin: capture.origin,
  }
  const file = join(deps.home, 'config-snapshot', `${encodeSegment(capture.sessionId)}.jsonl`)
  await deps.writer.append(file, (seq) => ({ ...row, seq }))
}

/**
 * Build plugin rows (§3.5 (d)): the loader pick is computed over the ENTRY-
 * ordered row set (tie → later entry order, enabled ids only), then rows are
 * sorted by id then scope for output.
 */
export function pluginRows(entries: readonly {
  id: string
  version: string
  scope: 'user' | 'project' | 'local'
  installPath: string
  lastUpdated: string
  effectiveEnabled: boolean
}[]): SnapshotPluginRow[] {
  const picked = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (!entry.effectiveEnabled) continue
    const current = picked.get(entry.id)
    if (current === undefined || entry.lastUpdated >= entries[current]!.lastUpdated) picked.set(entry.id, i)
  }
  return entries
    .map((entry, i): SnapshotPluginRow => {
      const row: SnapshotPluginRow = {
        id: entry.id,
        scope: entry.scope,
        version: entry.version,
        installPathBasename: basename(entry.installPath),
        enabled: entry.effectiveEnabled,
      }
      return picked.get(entry.id) === i ? { ...row, loaderSelected: true } : row
    })
    .sort((a, b) => (a.id === b.id ? (a.scope < b.scope ? -1 : 1) : a.id < b.id ? -1 : 1))
}
