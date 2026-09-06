/**
 * `/provider` action wizard engines (design doc docs/plans/2026-09-05-provider-
 * management.md §4.3 add-preset, §4.4 rotate, §4.6 custom, §8-S2 verify probe):
 * the wizard text field, step submissions, persistence, and the settings
 * path-op write. Split out of provider-command.ts purely for line budget.
 * @module @dsh-cc/tui/provider-command-actions
 */
import { Input } from '@dsh-cc/pi-tui'
import { MaskedInput } from './components/masked-input.ts'
import { setProviderOverlay } from './store.ts'
import {
  backFromWizard,
  setMessage,
  startWizardFor,
  wizardNext,
  wizardSetAnswer,
  wizardSetModelErrors,
  wizardSetNote,
  wizardSetVerify,
  type ProviderPanelState,
} from './store/provider-panel.ts'
import {
  materializeCustomProfile,
  materializeProfile,
  normalizeRouteId,
  routeCollision,
  parseModelList,
  verifyProbeFor,
  type CredentialsLike,
  type LlmManageLike,
  type ParsedModel,
} from './provider-flow.ts'
import { PRESETS, deriveCredentialRef, presetByRoute, type ProviderPreset } from './provider-presets.ts'
import { PROVIDER_SETTINGS_NAMESPACE, readConfiguredProviders, loadDirectory } from './provider-read.ts'
import { setAsDefault, settingsWriteOf, writeRoute } from './provider-settings.ts'
import type { ProviderCore } from './provider-command.ts'

/** Ordered wizard steps for the add-preset flow (§4.3). */
export const PRESET_STEPS = ['credential', 'verify', 'done'] as const

/** Ordered wizard steps for the custom-provider flow (§4.6). */
export const CUSTOM_STEPS = ['route', 'displayName', 'baseURL', 'protocol', 'ref', 'key', 'models', 'done'] as const

/** Rotate/replace-key flow (§4.4): one masked key step. */
export const ROTATE_STEPS = ['key'] as const

/** §4.6 protocol single-select options (all three wire protocols). */
export const CUSTOM_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** Wizard steps that render a live text `Input` (masked for secrets). */
export const TEXT_STEPS: Record<string, { masked: boolean }> = {
  credential: { masked: true },
  key: { masked: true },
  route: { masked: false },
  displayName: { masked: false },
  baseURL: { masked: false },
  ref: { masked: false },
  models: { masked: false },
}

/** Line shown when the environment shadows a credential ref (§7, C4). */
export function envShadowLine(ref: string): string {
  return `${ref} is supplied by your environment and read-only in this UI — unset the environment variable to manage it here.`
}

export function credentialRefFor(route: string): string {
  return presetByRoute(route)?.credentialRef ?? deriveCredentialRef(route)
}

/** The live wizard step, if a wizard is open. */
export const currentStep = (panel: ProviderPanelState | undefined): string | undefined => {
  const wizard = panel?.wizard
  return wizard === undefined ? undefined : wizard.steps[wizard.stepIndex]
}

/** Clear the wizard text field and the transient key buffer (§6). */
export const clearField = (core: ProviderCore): void => {
  if (core.buf.field !== undefined) core.buf.field.setValue('')
  core.buf.field = undefined
  core.buf.secret = undefined
}

/** Open a fresh text field for the wizard's active step (prefilled). */
export const openField = (core: ProviderCore, panel: ProviderPanelState | undefined): void => {
  const step = currentStep(panel)
  const spec = step === undefined ? undefined : TEXT_STEPS[step]
  if (spec === undefined || panel?.wizard === undefined || step === undefined) return
  const input = spec.masked ? new MaskedInput() : new Input()
  const wizard = panel.wizard
  if (!spec.masked && step !== 'models') {
    const answer = wizard.answers[step]
    const prefill = step === 'route' && answer === undefined ? wizard.answers['route'] : answer
    if (prefill !== undefined && prefill !== '') input.setValue(prefill)
  }
  core.buf.field = input
}

/** Drop and reopen the text field for the (advanced) wizard step. */
export const reopenField = (core: ProviderCore, panel: ProviderPanelState | undefined): void => {
  core.buf.field = undefined
  openField(core, panel)
}

/**
 * The wizard action flows (§4.3 add, §4.6 custom): returns the runtime
 * members that drive the wizard, closing over the field/secret buffers and
 * the shared helpers on `core`.
 */
export function createActions(core: ProviderCore): {
  startPresetWizard(route: string): Promise<void>
  wizardSubmit(panel: ProviderPanelState): void
  fetchModels(panel: ProviderPanelState): void
  removeJustAdded(panel: ProviderPanelState): void
} {
  const { rt, buf } = core

  const submitKey = (panel: ProviderPanelState, step: string, value: string): void => {
    const wizard = panel.wizard!
    if (value === '') {
      // Empty is absent (C4): never write a blank key.
      clearField(core)
      rt.emit(setProviderOverlay(rt.state(), setMessage(backFromWizard(panel), 'No key entered — nothing was written.')))
      return
    }
    buf.secret = value
    if (step === 'key' && wizard.kind === 'rotate') {
      core.begin(rotateKey(wizard.route, value))
      return
    }
    if (step === 'key' && wizard.kind === 'custom') {
      // The custom flow persists at the models step; keep the key buffered.
      buf.field?.setValue('')
      rt.emit(setProviderOverlay(rt.state(), wizardNext(panel)))
      reopenField(core, rt.state().providerPanel)
      return
    }
    // Preset credential step: persist key then profile, then verify (§4.3.2).
    core.begin(persistPreset(wizard.route, value))
  }

  const submitText = (panel: ProviderPanelState, step: string, value: string): void => {
    const wizard = panel.wizard!
    if (step === 'route') {
      const normalized = normalizeRouteId(value)
      if (normalized === null) {
        buf.field?.setValue('')
        core.patch(p => wizardSetNote(p, 'Enter a route id using lowercase letters, numbers, and dashes.'))
        return
      }
      const collision = routeCollision(normalized, {
        configured: readConfiguredProviders(settingsWriteOf(core)),
        presets: PRESETS,
        directory: loadDirectory(rt.ctx.get('llm') as LlmManageLike | undefined),
      })
      if (collision !== null) {
        const what = collision === 'configured' ? 'already configured' : collision === 'preset' ? 'offered as a built-in preset' : 'known to the provider directory'
        buf.field?.setValue('')
        core.patch(p => wizardSetNote(p, `Route "${normalized}" is ${what} — pick another id.`))
        return
      }
      core.patch(p => wizardSetAnswer(wizardNext(wizardSetAnswer(p, 'ref', deriveCredentialRef(normalized))), 'route', normalized))
      reopenField(core, rt.state().providerPanel)
      return
    }
    if (step === 'displayName') {
      if (value.trim() === '') {
        buf.field?.setValue('')
        core.patch(p => wizardSetNote(p, 'Enter a display name.'))
        return
      }
      core.patch(p => wizardSetAnswer(wizardNext(p), 'displayName', value.trim()))
      reopenField(core, rt.state().providerPanel)
      return
    }
    if (step === 'baseURL') {
      let parsed: URL
      try {
        parsed = new URL(value.trim())
      } catch {
        buf.field?.setValue('')
        core.patch(p => wizardSetNote(p, 'baseURL must be an absolute http(s) URL — e.g. https://gw.example.com/v1'))
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        buf.field?.setValue('')
        core.patch(p => wizardSetNote(p, 'baseURL must be an absolute http(s) URL — e.g. https://gw.example.com/v1'))
        return
      }
      core.patch(p => wizardSetAnswer(wizardNext(p), 'baseURL', value.trim()))
      reopenField(core, rt.state().providerPanel)
      return
    }
    if (step === 'ref') {
      const ref = value.trim() === '' ? deriveCredentialRef(wizard.answers['route'] ?? wizard.route) : value.trim()
      core.patch(p => wizardSetAnswer(wizardNext(p), 'ref', ref))
      reopenField(core, rt.state().providerPanel)
      return
    }
    if (step === 'models') {
      const { models, errors } = parseModelList(buf.field?.getValue() ?? '')
      if (errors.length > 0) {
        // Per-line errors; the field keeps its text so the user can fix it.
        core.patch(p => wizardSetModelErrors(p, errors))
        return
      }
      core.patch(p => wizardSetAnswer(p, 'models', JSON.stringify(models)))
      core.begin(persistCustom())
    }
  }

  const rotateKey = async (route: string, key: string): Promise<void> => {
    const ref = credentialRefFor(route)
    try {
      await (rt.ctx.get('credentials') as CredentialsLike | undefined)?.set(ref, key)
    } catch {
      clearField(core)
      core.patch(p => setMessage(p, envShadowLine(ref)))
      return
    }
    clearField(core)
    core.patch(p => {
      const { wizard: _dropped, ...rest } = p
      return setMessage({ ...rest, phase: 'detail' }, `Key for ${ref} updated — credentials resolve per request, so the next message uses it.`)
    })
  }

  const persistPreset = async (route: string, key: string): Promise<void> => {
    const preset = presetByRoute(route)
    if (preset === undefined) return
    const ref = preset.credentialRef
    try {
      await (rt.ctx.get('credentials') as CredentialsLike | undefined)?.set(ref, key)
    } catch {
      // Env-shadow rejection: explain, keep the wizard alive on the key step.
      clearField(core)
      core.patch(p => wizardSetNote(p, envShadowLine(ref)))
      return
    }
    const profile = { ...materializeProfile(preset), apiKeyEnv: ref }
    const error = await writeRoute(core, { op: 'set', path: ['providers', route], value: profile })
    clearField(core)
    if (error !== undefined) {
      core.patch(p => wizardSetNote(p, error))
      return
    }
    core.patch(p => wizardNext(p))
    await runVerify(preset, key)
  }

  const runVerify = async (preset: ProviderPreset, key: string): Promise<void> => {
    // Draft-form probe (C5, review Blocker B1): NEVER the provider form.
    const probe = verifyProbeFor({ baseURL: preset.probe?.baseURL, api: preset.probe?.api, apiKey: key })
    if (probe === null) {
      buf.secret = undefined
      core.patch(p => wizardSetVerify(wizardNext(p), {
        status: 'skipped',
        message: "This endpoint can't be listed programmatically — the first message is the test.",
      }))
      return
    }
    const llm = rt.ctx.get('llm') as LlmManageLike | undefined
    if (llm === undefined || typeof llm.discoverModels !== 'function') {
      buf.secret = undefined
      core.patch(p => wizardSetVerify(wizardNext(p), {
        status: 'skipped',
        message: 'Model discovery is unavailable in this profile — the probe was skipped; the first message is the test.',
      }))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const models = await llm.discoverModels(PROVIDER_SETTINGS_NAMESPACE, { ...probe, signal: controller.signal })
      core.patch(p => wizardSetVerify(wizardNext(p), { status: 'ok', message: `${models.length} models reachable` }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      core.patch(p => wizardSetVerify(p, {
        status: 'failed',
        message: `Verification failed: ${reason} — the configuration was kept; enter keeps it, x removes it.`,
      }))
      return
    } finally {
      clearTimeout(timer)
      buf.secret = undefined
    }
  }

  const persistCustom = async (): Promise<void> => {
    const wizard = rt.state().providerPanel?.wizard
    if (wizard === undefined) return
    const route = wizard.answers['route'] ?? ''
    const ref = wizard.answers['ref'] ?? deriveCredentialRef(route)
    let models: ParsedModel[] = []
    try {
      models = JSON.parse(wizard.answers['models'] ?? '[]') as ParsedModel[]
    } catch {
      models = []
    }
    try {
      await (rt.ctx.get('credentials') as CredentialsLike | undefined)?.set(ref, buf.secret ?? '')
    } catch {
      clearField(core)
      core.patch(p => wizardSetNote(p, envShadowLine(ref)))
      return
    }
    let profile: Record<string, unknown>
    try {
      profile = {
        apiKeyEnv: ref,
        ...materializeCustomProfile({
          routeId: route,
          displayName: wizard.answers['displayName'] ?? route,
          baseURL: wizard.answers['baseURL'] ?? '',
          api: wizard.answers['api'] ?? '',
          ...(models.length > 0 ? { models } : {}),
        }),
      }
    } catch (error) {
      clearField(core)
      core.patch(p => wizardSetNote(p, error instanceof Error ? error.message : String(error)))
      return
    }
    const error = await writeRoute(core, { op: 'set', path: ['providers', route], value: profile })
    clearField(core)
    if (error !== undefined) {
      core.patch(p => wizardSetNote(p, error))
      return
    }
    core.patch(p => setMessage(wizardNext(p), undefined))
  }

  return {
    /** §4.3 add flow for a preset (custom wizard seeded for unknown ids). */
    async startPresetWizard(route: string): Promise<void> {
      const preset = presetByRoute(route)
      const panel = rt.state().providerPanel
      if (panel === undefined) return
      if (preset === undefined) {
        // Unknown id: run the custom wizard with the id seeded (§4.6 shape).
        const normalized = normalizeRouteId(route) ?? ''
        rt.emit(setProviderOverlay(rt.state(), startWizardFor(panel, '', [...CUSTOM_STEPS], {
          kind: 'custom',
          ...(normalized === '' ? {} : { answers: { route: normalized, ref: deriveCredentialRef(normalized) } }),
        })))
        openField(core, rt.state().providerPanel)
        return
      }
      void (async () => {
        const ref = preset.credentialRef
        const state = await core.describeRef(ref)
        const fresh = rt.state().providerPanel
        if (fresh === undefined || fresh.phase !== 'list') return
        if (state?.configured === true && state.source === 'env') {
          // Env-shadowed: skip the key step with the one-line explanation (§4.3.1).
          rt.emit(setProviderOverlay(rt.state(), wizardSetNote(wizardNext(startWizardFor(fresh, route, [...PRESET_STEPS], {
            kind: 'preset',
            answers: { ref, credential: 'env' },
          })), `${ref} is already supplied by your environment — the key step was skipped.`)))
          return
        }
        rt.emit(setProviderOverlay(rt.state(), startWizardFor(fresh, route, [...PRESET_STEPS], { kind: 'preset', answers: { ref } })))
        openField(core, rt.state().providerPanel)
      })()
    },

    /** Advance the wizard from its current step. */
    wizardSubmit(panel: ProviderPanelState): void {
      const wizard = panel.wizard
      if (wizard === undefined) return
      const step = wizard.steps[wizard.stepIndex]
      if (step === undefined) return
      if (step === 'protocol') {
        const api = CUSTOM_PROTOCOLS[wizard.selectIndex ?? 0] ?? CUSTOM_PROTOCOLS[0]!
        core.patch(p => wizardSetAnswer(wizardNext(p), 'api', api))
        reopenField(core, rt.state().providerPanel)
        return
      }
      if (step === 'verify') {
        // Enter = keep (§4.3.2): the config stays even when the probe failed.
        if (wizard.verify?.status === 'failed') core.patch(p => wizardSetNote(wizardNext(p), undefined))
        return
      }
      if (step === 'done') {
        core.begin(setAsDefault(core, wizard.kind === 'custom' ? wizard.answers['route'] ?? wizard.route : wizard.route))
        return
      }
      const spec = TEXT_STEPS[step]
      if (spec === undefined) return
      const value = buf.field?.getValue() ?? ''
      if (spec.masked) submitKey(panel, step, value)
      else submitText(panel, step, value)
    },

    /** Models-step fetch (tab): draft-form probe → prefill. */
    fetchModels(panel: ProviderPanelState): void {
      const wizard = panel.wizard
      if (wizard === undefined || wizard.steps[wizard.stepIndex] !== 'models') return
      const probe = verifyProbeFor({ baseURL: wizard.answers['baseURL'], api: wizard.answers['api'], apiKey: buf.secret })
      if (probe === null) {
        core.patch(p => wizardSetNote(p, "This endpoint can't be listed programmatically — enter the model ids manually."))
        return
      }
      const llm = rt.ctx.get('llm') as LlmManageLike | undefined
      if (llm === undefined || typeof llm.discoverModels !== 'function') {
        core.patch(p => wizardSetNote(p, 'Model discovery is unavailable in this profile — enter the model ids manually.'))
        return
      }
      core.begin((async () => {
        try {
          const models = await llm.discoverModels(PROVIDER_SETTINGS_NAMESPACE, probe)
          buf.field?.setValue(models.map(m => m.id).join(', '))
          core.patch(p => wizardSetNote(p, undefined))
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          core.patch(p => wizardSetNote(p, `Model fetch failed: ${reason} — enter the ids manually.`))
        }
      })())
    },

    /** keep/remove choice on a failed verify — remove unsets the just-written route. */
    removeJustAdded(panel: ProviderPanelState): void {
      const route = panel.wizard?.route
      if (route === undefined || route === '') return
      core.begin((async () => {
        const error = await writeRoute(core, { op: 'unset', path: ['providers', route] })
        if (error !== undefined) {
          core.patch(p => setMessage(p, `Removal failed: ${error}`))
          return
        }
        try {
          await (rt.ctx.get('credentials') as CredentialsLike | undefined)?.unset(credentialRefFor(route))
        } catch {
          // Best-effort: the route removal stands regardless.
        }
        core.patch(p => setMessage(backFromWizard(p), `Removed ${route}.`))
      })())
    }
  }
}
