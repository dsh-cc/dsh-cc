/**
 * `/provider` settings-write seam (design doc docs/plans/2026-09-05-provider-
 * management.md doc D1/D8a/D8c): the duck-typed write-capable settings seam,
 * the revision-guarded path-op write, and the agent-default-model seed.
 * Split out of provider-command.ts purely for line budget.
 * @module @dsh-cc/tui/provider-command-settings
 */
import { isSettingsConflict } from './harness/approval-preview.ts'
import { PROVIDER_SETTINGS_NAMESPACE, type SettingsDescribeLike } from './provider-read.ts'
import { setMessage } from './store/provider-panel.ts'
import type { LlmManageLike } from './provider-flow.ts'
import type { ProviderCore } from './provider-command.ts'

/** One path-op for the settings cascade facade (doc D8a: `{op:'set'|'unset', path}`). */
export type ProviderSettingsOp = { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }

/**
 * Duck-typed write-capable settings seam (doc D1/D8): `describe` supplies the
 * revision guard, `mutate` writes path ops, `replace` writes a whole
 * namespace (the agent-default-model seed, D8c).
 */
export type SettingsWriteLike = SettingsDescribeLike & {
  mutate?(ns: string, ops: readonly ProviderSettingsOp[], revision?: unknown): Promise<unknown>
  replace?(ns: string, value: unknown, revision?: unknown): Promise<unknown>
}

export const settingsWriteOf = (core: ProviderCore): SettingsWriteLike | undefined =>
  core.rt.ctx.get('settings') as SettingsWriteLike | undefined

const revisionOf = (settings: SettingsWriteLike | undefined, ns: string = PROVIDER_SETTINGS_NAMESPACE): unknown => {
  try {
    return settings?.describe?.().find(entry => String(entry.ns) === ns)?.revision
  } catch {
    return undefined
  }
}

/**
 * Revision-guarded path-op write with one conflict retry (D1/D8a, the
 * writeAllowRule precedent). Returns the verbatim error message on failure
 * (§7: rendered as-is, previous routes keep serving).
 */
export const writeRoute = async (core: ProviderCore, op: ProviderSettingsOp): Promise<string | undefined> => {
  const settings = settingsWriteOf(core)
  if (settings === undefined || typeof settings.mutate !== 'function') {
    return 'No writable settings provider is mounted.'
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await settings.mutate(PROVIDER_SETTINGS_NAMESPACE, [op], revisionOf(settings))
      return undefined
    } catch (error) {
      if (attempt === 0 && isSettingsConflict(error)) continue
      return error instanceof Error ? error.message : String(error)
    }
  }
  return undefined
}

/**
 * D8(c) agent-default-model seed: opportunistic — all failures degrade to a
 * note and the running session is never touched.
 */
export const setAsDefault = async (core: ProviderCore, route: string): Promise<void> => {
  const llm = core.rt.ctx.get('llm') as LlmManageLike | undefined
  const settings = settingsWriteOf(core)
  try {
    const models = await llm?.listModels(route)
    const model = Array.isArray(models) ? models[0]?.id : undefined
    if (model === undefined || model === '') throw new Error('no models are registered for the route yet')
    if (settings === undefined || typeof settings.replace !== 'function') throw new Error('no writable settings provider is mounted')
    await settings.replace('agent-default-model', { provider: route, model }, revisionOf(settings, 'agent-default-model'))
    core.patch(p => setMessage(p, `Default model set to ${route}/${model} for new sessions — /model switches the running one.`))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    core.patch(p => setMessage(p, `Could not set the default model: ${reason} — this step is optional; /model can pick any registered route.`))
  }
}
