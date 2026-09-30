/**
 * `llm-pi-ai` / `agent-default-model` configEditor bridge (migration plan Q3
 * addendum — disposition: bridge WITH data migration). At rc.2 the harness
 * consumers no longer read these settings namespaces: the pi-ai adapter
 * resolves profiles from its own entry Config (`config.providers`) and the
 * default model persists through `configEditor.edit`. The user settings.json
 * sections would silently stop routing, so this bridge:
 *
 * 1. registers both namespaces on the vendored cascade (idempotent) so the
 *    `describe`/`mutate`/`replace` user-override seam stays live;
 * 2. one-shot copies pre-existing user sections into the live plugin entry
 *    configs BEFORE the mirrored write path is first used (idempotent via
 *    content-compare, so it never double-copies);
 * 3. mirrors each committed user-override write into the entry config.
 *
 * Guards the raw `configEditor.edit` lacks live here: writes serialize per
 * namespace on a promise chain, only the namespace's own subtree keys are
 * ever rewritten, and `edit()` re-checks entry liveness against the live
 * Loader entry at apply time. On conflict the existing plugin entry wins and
 * the mismatch is logged once.
 *
 * @module @dsh-cc/tui/provider-bridge
 */
import { isDeepStrictEqual } from 'node:util'
import { AnySchema, readUserSection } from '@dsh-cc/settings-ns'
import { DEFAULT_MODEL_ENTRY_ID, PROVIDER_ENTRY_ID } from './bridge-ids.ts'
import { PROVIDER_SETTINGS_NAMESPACE, type SettingsDescribeLike } from './provider-read.ts'

/** The default-model namespace the bridge mirrors (D8c). */
export const DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** Duck-typed ctx face: the bridge only `get`s services. */
export type BridgeCtx = { get(key: string): unknown }

/** Duck-typed configEditor face (the rc.2 config-editor service). */
type ConfigEditorLike = {
  entries?: () => Array<{ options?: { id?: unknown; config?: Record<string, unknown> } }>
  edit?: (entry: object, change: (current: Record<string, unknown>) => Record<string, unknown>) => Promise<void>
}

/** One bridged namespace: its entry id and the entry-config keys it owns. */
interface BridgeTarget {
  entryId: string
  /** Project the user section onto the entry-config subtree it owns; `undefined` = nothing to write. */
  sectionToConfig(section: Record<string, unknown>): Record<string, unknown> | undefined
}

/**
 * The whole disposition surface: only these two namespaces cross the bridge,
 * and only the listed entry-config keys are ever rewritten from the UI —
 * everything else in a plugin entry is composition-owned.
 */
const BRIDGE_TARGETS: Record<string, BridgeTarget> = {
  [PROVIDER_SETTINGS_NAMESPACE]: {
    entryId: PROVIDER_ENTRY_ID,
    sectionToConfig: (section) =>
      section.providers === undefined ? undefined : { providers: section.providers },
  },
  [DEFAULT_MODEL_SETTINGS_NAMESPACE]: {
    entryId: DEFAULT_MODEL_ENTRY_ID,
    sectionToConfig: (section) => {
      const picked: Record<string, unknown> = {}
      for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
        if (section[key] !== undefined) picked[key] = section[key]
      }
      return Object.keys(picked).length === 0 ? undefined : picked
    },
  },
}

/** Namespaces whose conflict/preference warning already fired this process. */
const warnedConflicts = new Set<string>()

/** Per-namespace mirror chains: a failed mirror never blocks the next. */
const mirrorQueues = new Map<string, Promise<unknown>>()

/** Providers whose one-shot migration already ran. */
const migrated = new WeakSet<object>()

const editorOf = (ctx: BridgeCtx): ConfigEditorLike | undefined =>
  ctx.get('configEditor') as ConfigEditorLike | undefined

const loggerOf = (ctx: BridgeCtx): { warn?(...args: unknown[]): void } | undefined =>
  ctx.get('logger') as { warn?(...args: unknown[]): void } | undefined

/** Serialize one unit onto the namespace's mirror chain (settled tail kept). */
function enqueue(ns: string, unit: () => Promise<void>): Promise<void> {
  const previous = mirrorQueues.get(ns) ?? Promise.resolve()
  const run = previous.then(unit, unit)
  mirrorQueues.set(ns, run.catch(() => {}))
  return run
}

/** Find the configEditor entry whose id matches the target, or undefined. */
function entryFor(ctx: BridgeCtx, target: BridgeTarget): { options?: { id?: unknown; config?: Record<string, unknown> } } | undefined {
  return editorOf(ctx)?.entries?.().find(row => String(row.options?.id) === target.entryId)
}

/**
 * Apply `desired` to the target entry's config, skipping when the subtree
 * already matches (the migration's idempotence) and preferring the existing
 * plugin entry on conflict (never overwrite user-meaningful entry config;
 * log once).
 */
async function applySubtree(ctx: BridgeCtx, ns: string, desired: Record<string, unknown>, migration: boolean): Promise<void> {
  const target = BRIDGE_TARGETS[ns]
  if (target === undefined) return
  const editor = editorOf(ctx)
  const entry = entryFor(ctx, target)
  if (editor === undefined || typeof editor.edit !== 'function' || entry === undefined) return
  const current = structuredClone((entry.options?.config ?? {}) as Record<string, unknown>)
  const existing: Record<string, unknown> = {}
  for (const key of Object.keys(desired)) existing[key] = current[key]
  if (isDeepStrictEqual(existing, desired)) return
  if (migration && Object.keys(existing).some(key => current[key] !== undefined) && !isDeepStrictEqual(existing, desired)) {
    // Conflict: the entry already carries its own config. Prefer it.
    const key = `${ns}:${target.entryId}`
    if (!warnedConflicts.has(key)) {
      warnedConflicts.add(key)
      loggerOf(ctx)?.warn?.(
        `provider-bridge: ${target.entryId} entry config already carries user-meaningful values; keeping it over the settings.json "${ns}" section`,
      )
    }
    return
  }
  await editor.edit(entry, raw => ({ ...raw, ...desired }))
}

/** The migration/mirror unit for one namespace; no-op without a user section. */
function migrateNamespace(ctx: BridgeCtx, ns: string, settings: SettingsDescribeLike): Promise<void> {
  const target = BRIDGE_TARGETS[ns]
  if (target === undefined) return Promise.resolve()
  const user = readUserSection(settings, ns)
  const desired = user === undefined ? undefined : target.sectionToConfig(user)
  if (desired === undefined) return Promise.resolve()
  return applySubtree(ctx, ns, desired, true)
}

/**
 * One-shot lazy migration at the /provider read+write boundary: register both
 * namespaces (idempotent) and copy pre-existing settings.json sections into
 * the live plugin entries. Every failure degrades — the panel must render.
 */
export async function ensureProviderBridge(ctx: BridgeCtx): Promise<void> {
  const settings = ctx.get('settings') as (SettingsDescribeLike & { register?: (ns: string, schema: unknown) => unknown }) | undefined
  if (settings === undefined) return
  for (const ns of Object.keys(BRIDGE_TARGETS)) {
    // Presentation-free passthrough via AnySchema (settings-ns owns the
    // schemastery import — the tui-boundary gate bans harness imports in UI
    // modules). The provider CALLS the schema at register time (resolveValue):
    // the earlier toJSON-only impostor crashed register with a TypeError and
    // stranded the migration below.
    try {
      if (typeof settings.register === 'function') settings.register(ns, AnySchema)
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('already registered'))) throw error
    }
  }
  if (migrated.has(settings)) return
  migrated.add(settings)
  for (const ns of Object.keys(BRIDGE_TARGETS)) {
    try {
      await enqueue(ns, () => migrateNamespace(ctx, ns, settings))
    } catch {
      // A failed copy leaves the entry serving its own config; the mirror
      // path keeps future writes converging.
    }
  }
}

/**
 * Mirror the CURRENT user-override section for `ns` into its plugin entry
 * config (write-path half of the bridge). Serialized per namespace; failures
 * degrade to a warning — the user-layer write already committed.
 */
export async function mirrorToEntry(ctx: BridgeCtx, ns: string): Promise<void> {
  const target = BRIDGE_TARGETS[ns]
  if (target === undefined) throw new Error(`provider-bridge: namespace "${ns}" is not bridged`)
  const settings = ctx.get('settings') as SettingsDescribeLike | undefined
  const user = readUserSection(settings, ns)
  const desired = user === undefined ? undefined : target.sectionToConfig(user)
  if (desired === undefined) return
  try {
    await enqueue(ns, () => applySubtree(ctx, ns, desired, false))
  } catch (error) {
    loggerOf(ctx)?.warn?.('provider-bridge: entry-config mirror failed', error)
  }
}

/** Bridge-owned entry ids, exported for composition pinning. */
export { DEFAULT_MODEL_ENTRY_ID, PROVIDER_ENTRY_ID }
