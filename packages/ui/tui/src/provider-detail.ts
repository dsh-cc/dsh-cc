/**
 * `/provider` detail & manage flows (design doc docs/plans/2026-09-05-provider-
 * management.md §4.4): detail facts, the detail action router, removal with
 * double-confirm + credential-drop, and §8-S2 model-list refresh. Split out
 * of provider-command.ts purely for line budget.
 * @module @dsh-cc/tui/provider-command-detail
 */
import { setProviderOverlay } from './store.ts'
import {
  backToList,
  enterDetail,
  setMessage,
  setDetail,
  setRemoveStage,
  startRemove,
  startWizardFor,
  type ProviderPanelState,
} from './store/provider-panel.ts'
import { refreshProbeFor, type CredentialsLike, type LlmManageLike } from './provider-flow.ts'
import { presetByRoute } from './provider-presets.ts'
import { readConfiguredProviders, PROVIDER_SETTINGS_NAMESPACE } from './provider-read.ts'
import {
  ROTATE_STEPS,
  credentialRefFor,
  envShadowLine,
  openField,
} from './provider-actions.ts'
import { setAsDefault, settingsWriteOf, writeRoute } from './provider-settings.ts'
import type { ProviderCore } from './provider-command.ts'

/** §4.4 removal warning for the currently-selected route (doc D8d). */
const REMOVE_CURRENT_WARNING =
  'This is the running session\'s current provider: the session keeps its current model until you pick again with /model; in-flight request behavior during route disposal is undefined.'

/**
 * The detail/manage/remove flows (§4.4, §8-S2): returns the runtime members
 * that drive the detail phase, closing over the shared helpers on `core`.
 */
export function createDetail(core: ProviderCore): {
  enterFromList(panel: ProviderPanelState): void
  jumpToRemove(route: string): void
  refreshDetail(route: string): Promise<void>
  runDetailAction(panel: ProviderPanelState): void
  confirmRemove(panel: ProviderPanelState): void
  panelRefreshModels(): void
} {
  const { rt } = core

  /**
   * §8-S2 "refresh list": re-run the draft-form probe against the route's
   * effective endpoint (profile, else preset probe) and write the discovered
   * models. No `provider` field (C5/Blocker B1) and no apiKey — the stored
   * credential is applied adapter-side. Failure renders the reason verbatim
   * and changes no state; the probe aborts after 15 s.
   */
  const refreshModels = async (route: string): Promise<void> => {
    const profile = (readConfiguredProviders(settingsWriteOf(core))[route] ?? {}) as Record<string, unknown>
    const probe = refreshProbeFor(profile, presetByRoute(route))
    const llm = rt.ctx.get('llm') as LlmManageLike | undefined
    if (!probe.ok) {
      core.patch(p => setMessage(p, probe.reason))
      return
    }
    if (llm === undefined || typeof llm.discoverModels !== 'function') {
      core.patch(p => setMessage(p, 'Model discovery is unavailable in this profile — the list was not refreshed.'))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const models = await llm.discoverModels(PROVIDER_SETTINGS_NAMESPACE, {
        baseURL: probe.baseURL,
        api: probe.api,
        signal: controller.signal,
      })
      const mapped = models.map(m => ({ id: m.id, name: m.name ?? m.id }))
      const error = await writeRoute(core, { op: 'set', path: ['providers', route, 'models'], value: mapped })
      if (error !== undefined) {
        core.patch(p => setMessage(p, `Refresh failed: ${error}`))
        return
      }
      core.patch(p => setMessage(p, `Refreshed ${route}: ${models.length} models discovered from ${probe.baseURL}.`))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      core.patch(p => setMessage(p, `Model refresh failed: ${reason}`))
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /** Enter on a list row: configured → detail (§4.4), available → add wizard (§4.3). */
    enterFromList(panel: ProviderPanelState): void {
      const row = panel.rows[panel.cursor]
      if (row === undefined) return
      if (row.section === 'available') {
        void core.runtime().startPresetWizard(row.route)
        return
      }
      rt.emit(setProviderOverlay(rt.state(), enterDetail(panel)))
      void this.refreshDetail(row.route)
    },

    /** §4.4 removal jump for `/provider remove <route>`. */
    jumpToRemove(route: string): void {
      const panel = rt.state().providerPanel
      if (panel === undefined) return
      if (!Object.hasOwn(readConfiguredProviders(settingsWriteOf(core)), route)) {
        rt.emit(setProviderOverlay(rt.state(), setMessage(backToList(panel), `Route "${route}" is not configured — /provider list shows the configured routes.`)))
        return
      }
      const warning = rt.selection.current?.provider === route ? REMOVE_CURRENT_WARNING : undefined
      rt.emit(setProviderOverlay(rt.state(), setMessage(startRemove({ ...panel, phase: 'detail', selected: route }), warning)))
    },

    async refreshDetail(route: string): Promise<void> {
      const profile = (readConfiguredProviders(settingsWriteOf(core))[route] ?? {}) as Record<string, unknown>
      const ref = credentialRefFor(route)
      const state = await core.describeRef(ref)
      const envLocked = state?.source === 'env' || state?.writable === false
      const badge = state === undefined || !state.configured ? 'missing' : state.source === 'env' ? 'env' : 'managed'
      const models = Array.isArray(profile.models) ? profile.models.length : 0
      const detail = {
        profileJson: JSON.stringify(profile, null, 2),
        endpoint: typeof profile.baseURL === 'string' ? profile.baseURL : '(catalog default)',
        api: typeof profile.api === 'string' ? profile.api : '(catalog default)',
        modelCount: models,
        credentialLine: badge === 'missing' ? 'key ✗ missing' : `key ✓ (${badge})${envLocked ? ' — read-only here' : ''}`,
      }
      const actions = [
        envLocked
          ? { id: 'rotate', label: 'Rotate key', disabled: true, reason: envShadowLine(ref) }
          : { id: 'rotate', label: 'Rotate key' },
        (() => {
          const probe = refreshProbeFor(profile, presetByRoute(route))
          return probe.ok
            ? { id: 'refresh-models', label: 'Refresh models' }
            : { id: 'refresh-models', label: 'Refresh models', disabled: true, reason: probe.reason }
        })(),
        { id: 'default', label: 'Set as default' },
        { id: 'remove', label: 'Remove' },
      ]
      core.patch(p => setDetail(p, detail, actions))
    },

    /** Run the focused detail action (§4.4). */
    runDetailAction(panel: ProviderPanelState): void {
      const route = panel.selected
      if (route === undefined) return
      const action = panel.actions?.[panel.actionCursor ?? 0]
      if (action === undefined) return
      if (action.disabled === true) {
        rt.emit(setProviderOverlay(rt.state(), setMessage(panel, action.reason ?? 'This action is unavailable.')))
        return
      }
      if (action.id === 'rotate') {
        rt.emit(setProviderOverlay(rt.state(), startWizardFor(panel, route, [...ROTATE_STEPS], { kind: 'rotate' })))
        openField(core, rt.state().providerPanel)
        return
      }
      if (action.id === 'refresh-models') {
        core.begin(refreshModels(route))
        return
      }
      if (action.id === 'default') {
        core.begin(setAsDefault(core, route))
        return
      }
      if (action.id === 'remove') {
        const warning = rt.selection.current?.provider === route ? REMOVE_CURRENT_WARNING : undefined
        rt.emit(setProviderOverlay(rt.state(), setMessage(startRemove(panel), warning)))
      }
    },

    /** Adjudicate the remove double-confirm / credential-drop stage. */
    confirmRemove(panel: ProviderPanelState): void {
      const route = panel.selected
      if (route === undefined) return
      if (panel.stage === 'drop-credential') {
        const ref = credentialRefFor(route)
        const credentials = rt.ctx.get('credentials') as CredentialsLike | undefined
        core.begin((async () => {
          try {
            await credentials?.unset(ref)
          } catch {
            // Failure keeps the stored credential; the route removal stands.
          }
          core.patch(p => setMessage(backToList(p), `Removed ${route} and dropped the stored credential.`))
        })())
        return
      }
      core.begin((async () => {
        const error = await writeRoute(core, { op: 'unset', path: ['providers', route] })
        if (error !== undefined) {
          core.patch(p => setMessage(p, `Removal failed: ${error}`))
          return
        }
        const state = await core.describeRef(credentialRefFor(route))
        // Drop offer ONLY for a managed credential — env-supplied keys are
        // never touched by the UI (§4.4, C4).
        if (state?.configured === true && state.source !== 'env') {
          core.patch(p => setRemoveStage(p, 'drop-credential'))
          return
        }
        core.patch(p => backToList(p))
      })())
    },

    /** Detail-phase `r`: refresh the route's model list via a draft-form probe (§8-S2). */
    panelRefreshModels(): void {
      const panel = rt.state().providerPanel
      if (panel === undefined || core.buf.pendingAction !== undefined || panel.phase !== 'detail') return
      const action = panel.actions?.find(a => a.id === 'refresh-models')
      if (action === undefined) return
      if (action.disabled === true) {
        rt.emit(setProviderOverlay(rt.state(), setMessage(panel, action.reason ?? 'This action is unavailable.')))
        return
      }
      core.begin(refreshModels(panel.selected ?? ''))
    }
  }
}
