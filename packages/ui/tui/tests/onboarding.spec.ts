import { describe, expect, it, vi } from 'vitest'
import { wireOnboarding, type OnboardingGate } from '@dsh-cc/tui/harness/onboarding.ts'
import { createInitialState, upsertRow, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * First-run onboarding wiring: fake emit/listener/selection seams plus a fake
 * settings provider (installSection/replace) and a fake `/provider` runtime —
 * the same duck-typed surfaces the statusline/provider specs consume.
 */

function makeRt(opts: {
  section?: Record<string, unknown>
  isTTY?: boolean
  modelMissing?: boolean
} = {}) {
  let section: Record<string, unknown> | undefined = opts.section
  const states: TuiState[] = []
  const listeners = new Set<(state: TuiState) => void>()
  const gate: OnboardingGate = { modelMissing: opts.modelMissing === true }
  const replace = vi.fn(async (_ns: string, next: object) => { section = next })
  const settings = {
    installSection(_owner: unknown, _ns: unknown, _schema: unknown, _entry: unknown, hooks: {
      setSource?: (current: () => unknown) => void
    }) {
      hooks.setSource?.(() => section)
    },
    replace,
  }
  const ctx = {
    inject(_deps: string[], cb: (sctx: { settings: unknown }) => void): void {
      cb({ settings })
    },
  }
  const openProviderPanel = vi.fn(async (): Promise<void> => {
    // Mirror the real runtime: opening paints the panel overlay via emit.
    states.push({ ...states.at(-1) ?? createInitialState(), providerPanel: { phase: 'list' } } as TuiState)
    for (const l of listeners) l(states.at(-1)!)
  })
  const rt = {
    emit(next: TuiState): void {
      states.push(next)
      for (const l of [...listeners]) l(next)
    },
    state(): TuiState {
      return states.at(-1) ?? createInitialState()
    },
    ctx,
    selection: { current: undefined as { provider: string; model: string } | undefined },
    listeners,
    providerRuntime: { openProviderPanel },
    modelMissing: () => gate.modelMissing,
    isTTY: () => opts.isTTY ?? true,
  }
  const fire = (): void => {
    for (const l of [...listeners]) l(rt.state())
  }
  return { rt, states, listeners, gate, replace, openProviderPanel, fire }
}

const statusTexts = (state: TuiState): string[] =>
  state.rows.filter(r => r.kind === 'status').map(r => (r as { text?: string }).text ?? '')

describe('wireOnboarding', () => {
  it('never fires when a model was seeded before settle', () => {
    const { rt, openProviderPanel, fire } = makeRt({ modelMissing: false })
    rt.selection.current = { provider: 'p', model: 'm' }
    wireOnboarding(rt)
    fire()
    expect(statusTexts(rt.state()).some(t => t.startsWith('Welcome!'))).toBe(false)
    expect(openProviderPanel).not.toHaveBeenCalled()
  })

  it('no model + not suppressed → welcome row and the provider panel opens', () => {
    const { rt, openProviderPanel } = makeRt({ modelMissing: true })
    const handle = wireOnboarding(rt)
    handle.onModelMissing()
    expect(statusTexts(rt.state())).toContain(
      "Welcome! No model configured yet — let's set up a provider. (Esc to skip for now)",
    )
    expect(openProviderPanel).toHaveBeenCalledTimes(1)
  })

  it('suppressed: true → nothing fires', () => {
    const { rt, openProviderPanel } = makeRt({ section: { suppressed: true }, modelMissing: true })
    const handle = wireOnboarding(rt)
    handle.onModelMissing()
    expect(statusTexts(rt.state()).some(t => t.startsWith('Welcome!'))).toBe(false)
    expect(openProviderPanel).not.toHaveBeenCalled()
  })

  it('selection becomes defined → Setup complete row and the flow deactivates', () => {
    const { rt, openProviderPanel, fire } = makeRt({ modelMissing: true })
    const handle = wireOnboarding(rt)
    handle.onModelMissing()
    expect(openProviderPanel).toHaveBeenCalledTimes(1)
    // The wizard write lands: selection transitions undefined → defined.
    rt.emit(upsertRow(rt.state(), { kind: 'status', text: 'Provider m added.' }))
    rt.selection.current = { provider: 'p', model: 'm' }
    fire()
    expect(statusTexts(rt.state())).toContain("Setup complete — you're ready to go.")
    // Deactivated: a replayed boot hook never re-opens the panel.
    handle.onModelMissing()
    expect(openProviderPanel).toHaveBeenCalledTimes(1)
  })

  it('panel closed without a model is a dismissal — no suppressed write, no notice spam', () => {
    const { rt, replace, openProviderPanel, fire } = makeRt({ modelMissing: true })
    const handle = wireOnboarding(rt)
    handle.onModelMissing()
    expect(openProviderPanel).toHaveBeenCalledTimes(1)
    // Esc on the first step closes the panel; selection still undefined.
    rt.emit({ ...rt.state(), providerPanel: undefined } as TuiState)
    fire()
    expect(replace).not.toHaveBeenCalled()
    // No extra rows were painted on dismissal (the driver's own no-model
    // notice from the seed stays untouched).
    expect(statusTexts(rt.state()).every(t => !t.startsWith('Setup complete'))).toBe(true)
  })

  it('reRun (the /onboard path) clears suppressed and opens the wizard', async () => {
    const { rt, replace, openProviderPanel } = makeRt({ section: { suppressed: true } })
    const handle = wireOnboarding(rt)
    expect(openProviderPanel).not.toHaveBeenCalled()
    await handle.reRun()
    expect(replace).toHaveBeenCalledWith('cc-onboarding', {})
    expect(openProviderPanel).toHaveBeenCalledTimes(1)
    expect(statusTexts(rt.state()).some(t => t.startsWith('Welcome!'))).toBe(true)
  })

  it('tolerates a context without a settings provider (suppressed reads false)', () => {
    const { rt, openProviderPanel } = makeRt({ modelMissing: true })
    ;(rt.ctx as { inject?: unknown }).inject = undefined
    const handle = wireOnboarding(rt)
    handle.onModelMissing()
    expect(openProviderPanel).toHaveBeenCalledTimes(1)
  })
})
