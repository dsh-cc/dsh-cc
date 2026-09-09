/**
 * First-run onboarding wiring: when the boot default-model seed settles with
 * no model configured (and the user has not suppressed the flow), emit a
 * welcome status and open the `/provider` panel so the user picks a provider.
 * Completion (a model selection appearing) and Esc-dismissal (panel closed
 * with still no model) both deactivate the flow; `/onboard` re-opens it
 * manually and clears the `cc-onboarding.suppressed` flag. Settings
 * registration is tolerant (no settings provider → suppressed reads false).
 * @module @dsh-cc/tui/harness/onboarding
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { TuiState } from '../store.ts'
import { upsertRow } from '../store.ts'
import type { ProviderRuntime } from '../provider-command.ts'

/** Settings namespace carrying the onboarding section (kebab-case). */
export const ONBOARDING_SETTINGS_NAMESPACE = 'cc-onboarding' as SettingsNamespace

/** Raw (unresolved) settings section for onboarding, open like statusline's. */
export type OnboardingSection = {
  suppressed?: unknown
  [key: string]: unknown
}

/** Tolerant schema: unknown sibling keys pass through; missing section → {}. */
export const ONBOARDING_SECTION_SCHEMA: z<OnboardingSection> = z.object({
  suppressed: z.any(),
})

const WELCOME_TEXT = "Welcome! No model configured yet — let's set up a provider. (Esc to skip for now)"
const COMPLETE_TEXT = "Setup complete — you're ready to go."

/** The slice of createDriver's closed-over state the onboarding wiring needs. */
export type OnboardingWiringCtx = {
  emit(next: TuiState): void
  state(): TuiState
  ctx: Context
  selection: ModelSelectionRef
  /** The driver's emit listener set — the wiring rides it as the diff seam. */
  listeners: Set<(state: TuiState) => void>
  /** The `/provider` runtime (driver-run-local); opens the panel/wizard. */
  providerRuntime: ProviderRuntime
  /** Whether the boot seed settled with no model (buffered flag). */
  modelMissing(): boolean
  /** TTY override for tests; defaults to process.stdout.isTTY. */
  isTTY?(): boolean
}

/** The handle driver-run-local (and the /onboard command) uses. */
export type OnboardingHandle = {
  /** The boot seed settled with no model — offer the wizard (once per boot). */
  onModelMissing(): void
  /** `/onboard`: clear `cc-onboarding.suppressed`, then open the wizard. */
  reRun(): Promise<void>
  dispose(): void
}

/**
 * Late-binding gate shared by createDriver and the run-local section: the
 * agent section's boot hook sets `modelMissing` (the seed may settle during
 * the boot-frame wait, before the onboarding wiring exists); the run-local
 * section installs `handle` once the provider runtime is up.
 */
export type OnboardingGate = { modelMissing: boolean; handle?: OnboardingHandle }

export function wireOnboarding(rt: OnboardingWiringCtx): OnboardingHandle {
  const { emit, state, selection, listeners, providerRuntime } = rt
  const isTTY = rt.isTTY ?? (() => process.stdout.isTTY === true)

  let active = false
  let opened = false // the panel was observed open since activation

  // Settings source (set by installSection) + write path for /onboard's reset.
  let source: (() => unknown) | undefined
  let clearSuppressed: (() => Promise<void>) | undefined
  const readSuppressed = (): boolean =>
    (source?.() as OnboardingSection | undefined)?.suppressed === true

  if (typeof (rt.ctx as { inject?: unknown }).inject === 'function') {
    rt.ctx.inject(['settings'], (sctx) => {
      const settings = sctx?.settings as {
        installSection?: (...args: unknown[]) => void
        replace?: (ns: string, section: object) => Promise<void>
      } | undefined
      if (typeof settings?.installSection !== 'function') return
      settings.installSection(rt.ctx, ONBOARDING_SETTINGS_NAMESPACE, ONBOARDING_SECTION_SCHEMA, {}, {
        setSource: (currentSection: () => unknown) => {
          source = currentSection
        },
        onChange: () => {},
      })
      if (typeof settings.replace === 'function') {
        clearSuppressed = () => settings.replace!(ONBOARDING_SETTINGS_NAMESPACE, {})
      }
    })
  }

  /** Offer the wizard once: welcome row + provider panel, guarded. */
  const offer = (force = false): void => {
    if (active
      || (!force && (selection.current !== undefined || readSuppressed()))
      || !isTTY()) return
    active = true
    opened = false
    emit(upsertRow(state(), { kind: 'status', text: WELCOME_TEXT }))
    try {
      void providerRuntime.openProviderPanel().catch(() => {})
    } catch {
      // Panel failures must never throw into the seed's settle path.
    }
  }

  // Boot hook + buffered flag (a seed settling during the boot-frame wait
  // fires before wiring exists; createDriver replays it via modelMissing()).
  if (rt.modelMissing()) offer()

  // Emit-diff seam: completion (selection appears) and Esc-dismissal (panel
  // closed with still no model) both deactivate the flow.
  let seenEmit = false
  let lastSelection = selection.current
  listeners.add((_) => {
    const current = selection.current
    const panelOpen = state().providerPanel !== undefined
    if (seenEmit) {
      if (active && panelOpen) opened = true
      if (active && lastSelection === undefined && current !== undefined) {
        active = false
        opened = false
        emit(upsertRow(state(), { kind: 'status', text: COMPLETE_TEXT }))
      } else if (active && current === undefined && opened && !panelOpen) {
        // Dismissed (Esc on the first step): keep the no-model notice, do
        // NOT write suppressed — the flow re-offers on the next boot.
        active = false
        opened = false
      }
    }
    seenEmit = true
    lastSelection = current
  })

  return {
    onModelMissing(): void {
      offer()
    },
    async reRun(): Promise<void> {
      if (clearSuppressed !== undefined) {
        try {
          await clearSuppressed()
        } catch {
          // A refused/unavailable write must not block the manual flow.
        }
      }
      // Manual `/onboard` is explicit consent — force past the suppressed
      // read (the cleared flag may not have re-committed yet) but keep the
      // no-model guard so a configured route is never clobbered by the panel.
      if (active || selection.current !== undefined) return
      offer(true)
    },
    dispose(): void {},
  }
}
