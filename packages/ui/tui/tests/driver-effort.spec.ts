import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Driver-level contract tests for the `/effort` command: validated level
 * writes (fail closed — selection must never hold an effort the llm layer
 * would reject), the reserved `default` reset (zero validation), the picker
 * overlay (open/move/submit/cancel with a stale-pair-guarded detached
 * write), `/model`'s effort preserve/reset behavior, the boot seed of the
 * deployment default's reasoning effort, and the `loadModelEfforts` seam.
 */

interface EffortLevel {
  id: string
  name: string
}

interface ModelInfo {
  reasoning?: { efforts: EffortLevel[]; defaultEffort?: string }
}

interface FakeModel {
  provider: string
  id: string
  name: string
}

interface LlmStub {
  listProviders(): { id: string }[]
  listModels(provider: string): Promise<FakeModel[]>
  resolveModelInfo?(provider: string, model: string): Promise<ModelInfo>
}

interface DefaultSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

const CATALOG: FakeModel[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
  // gpt-5-nano advertises no reasoning metadata at all.
  { provider: 'openai', id: 'gpt-5-nano', name: 'GPT-5 Nano' },
]

const MODEL_INFO: Record<string, ModelInfo> = {
  'deepseek-official/deepseek-v4-flash': {
    reasoning: {
      efforts: [
        { id: 'minimal', name: 'Minimal' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'minimal',
    },
  },
  'openai/gpt-5': {
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'medium',
    },
  },
}

/**
 * A ctx stub mirroring driver-model.spec.ts, plus an llm service that answers
 * `resolveModelInfo` from MODEL_INFO (unregistered provider rejects), and a
 * mutable `agentDefaultModel` deployment default for the boot-seed tests.
 */
function makeCtx(opts: {
  omitLlm?: boolean
  omitResolveModelInfo?: boolean
  resumeEvents?: unknown[]
} = {}): {
  ctx: Record<string, unknown>
  llm: LlmStub
  setDefaultSelection(next: DefaultSelection | undefined): void
} {
  let defaultSelection: DefaultSelection | undefined
  const baseResolve: NonNullable<LlmStub['resolveModelInfo']> = async (provider, model) => {
    const info = MODEL_INFO[`${provider}/${model}`]
    if (info === undefined) throw new Error(`unregistered provider: ${provider}`)
    return info
  }
  const llm: LlmStub = {
    listProviders: () => {
      const seen = new Set<string>()
      const providers: { id: string }[] = []
      for (const m of CATALOG) {
        if (!seen.has(m.provider)) {
          seen.add(m.provider)
          providers.push({ id: m.provider })
        }
      }
      return providers
    },
    listModels: async provider => CATALOG.filter(m => m.provider === provider),
    resolveModelInfo: (provider, model) => baseResolve(provider, model),
  }
  if (opts.omitResolveModelInfo === true) delete llm.resolveModelInfo
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'llm') {
        return opts.omitLlm === true ? undefined : llm
      }
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => defaultSelection }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (o: unknown) => {
        const agentOpts = (o as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-boot', header: {}, events: [], snapshotEvents() { return this.events } },
            id: 'a-boot',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
      resume: async (o: unknown) => {
        const agentOpts = (o as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-resume', header: {}, events: opts.resumeEvents ?? [] , snapshotEvents() { return this.events } },
            id: 'a-resume',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
  return {
    ctx,
    llm,
    setDefaultSelection(next) {
      defaultSelection = next
    },
  }
}

/** Texts of the transcript's status rows, oldest first. */
function statusTexts(driver: { state: { rows: readonly { kind: string; text?: string }[] } }): string[] {
  return driver.state.rows.filter(row => row.kind === 'status').map(row => row.text ?? '')
}

describe('createDriver /effort command', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-effort-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  describe('argument path', () => {
    it('/effort <level> writes the validated triple and the statusline shows it', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort high')
      expect(driver.statusLine).toContain('effort: high')
      // User-facing text carries the effort NAME, not the raw id.
      expect(statusTexts(driver).at(-1)).toBe('Reasoning effort is now High.')
    })

    it('/effort default clears the effort back to the provider default', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort high')
      expect(driver.statusLine).toContain('effort: high')
      await driver.submit('/effort default')
      expect(driver.statusLine).not.toContain('effort:')
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      expect(statusTexts(driver).at(-1)).toBe('Reasoning effort reset to the provider default.')
    })

    it('/effort default works with no llm service mounted (zero validation)', async () => {
      const { ctx } = makeCtx({ omitLlm: true })
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort default')
      expect(driver.statusLine).not.toContain('effort:')
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      expect(statusTexts(driver).at(-1)).toBe('Reasoning effort reset to the provider default.')
    })

    it('an unknown level is refused and leaves the selection unchanged', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort turbo')
      expect(statusTexts(driver).at(-1)).toBe('Unknown effort "turbo" for deepseek-v4-flash. Try /effort.')
      expect(driver.statusLine).not.toContain('effort:')
    })

    it('fail closed: no resolveModelInfo on the llm service refuses via the picker path too', async () => {
      const { ctx } = makeCtx({ omitResolveModelInfo: true })
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      // No args → picker path, which must not open without resolvable levels.
      await driver.submit('/effort')
      expect(driver.state.effortPicker).toBeUndefined()
      expect(statusTexts(driver).at(-1)).toBe('Cannot resolve effort levels for deepseek-v4-flash.')
      await driver.submit('/effort high')
      expect(driver.statusLine).not.toContain('effort:')
    })

    it('fail closed: a rejecting resolveModelInfo refuses the write', async () => {
      const { ctx, llm } = makeCtx()
      llm.resolveModelInfo = async () => {
        throw new Error('adapter down')
      }
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort high')
      expect(statusTexts(driver).at(-1)).toBe('Cannot resolve effort levels for deepseek-v4-flash.')
      expect(driver.statusLine).not.toContain('effort:')
    })

    it('fail closed: a model without reasoning metadata refuses the write', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'openai',
        model: 'gpt-5-nano',
      })
      await driver.submit('/effort high')
      expect(statusTexts(driver).at(-1)).toBe('Cannot resolve effort levels for gpt-5-nano.')
      expect(driver.statusLine).not.toContain('effort:')
    })

    it('no resolved model → no-model notice, no write', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {})
      await driver.submit('/effort high')
      expect(statusTexts(driver).at(-1)).toBe('No model configured. Use /model first.')
      expect(driver.statusLine).not.toContain('effort:')
    })
  })

  describe('picker overlay', () => {
    it('opens focused on the current effort', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort high')
      await driver.submit('/effort')
      const picker = driver.state.effortPicker
      expect(picker).toBeDefined()
      expect(picker!.entries).toEqual(['minimal', 'high', 'default'])
      expect(picker!.current).toBe('high')
      expect(picker!.focused).toBe(1)
    })

    it('focus falls back to the default entry when no effort is set', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort')
      const picker = driver.state.effortPicker
      expect(picker).toBeDefined()
      expect(picker!.current).toBeUndefined()
      expect(picker!.focused).toBe(2)
    })

    it('move clamps at the bounds (no wrap)', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort')
      driver.effortPickerMove(1) // clamp at bottom (default entry)
      expect(driver.state.effortPicker?.focused).toBe(2)
      driver.effortPickerMove(-1)
      driver.effortPickerMove(-1)
      expect(driver.state.effortPicker?.focused).toBe(0)
      driver.effortPickerMove(-1) // clamp at top
      expect(driver.state.effortPicker?.focused).toBe(0)
    })

    it('submit closes synchronously, then writes after the awaited promise settles', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort')
      driver.effortPickerMove(-1) // focus 'high'
      const pending = driver.effortPickerSubmit()
      // The overlay is already gone before the validation settles.
      expect(driver.state.effortPicker).toBeUndefined()
      expect(driver.statusLine).not.toContain('effort:')
      await pending
      expect(driver.statusLine).toContain('effort: high')
      expect(statusTexts(driver).at(-1)).toBe('Reasoning effort is now High.')
    })

    it('submitting the default entry writes the bare pair with zero adapter calls', async () => {
      const { ctx, llm } = makeCtx()
      let calls = 0
      const base = llm.resolveModelInfo!
      llm.resolveModelInfo = (provider, model) => {
        calls += 1
        return base(provider, model)
      }
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort') // open (one resolve call for the entries)
      calls = 0
      await driver.effortPickerSubmit() // focused = the default entry
      expect(driver.statusLine).not.toContain('effort:')
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      expect(statusTexts(driver).at(-1)).toBe('Reasoning effort reset to the provider default.')
      expect(calls).toBe(0)
    })

    it('cancel closes the overlay without writing', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort')
      driver.effortPickerMove(-1)
      driver.effortPickerCancel()
      expect(driver.state.effortPicker).toBeUndefined()
      expect(driver.statusLine).not.toContain('effort:')
      expect(statusTexts(driver).at(-1)).not.toContain('effort')
    })
  })

  describe('/model interaction', () => {
    it('/model preserves a carried effort the new model supports', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort high')
      await driver.submit('/model openai/gpt-5')
      expect(driver.statusLine).toContain('gpt-5')
      expect(driver.statusLine).toContain('effort: high')
      expect(statusTexts(driver).some(text => text.includes('not supported'))).toBe(false)
    })

    it('/model resets a carried effort the new model does not support, with a notice', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort minimal')
      await driver.submit('/model openai/gpt-5')
      expect(driver.statusLine).toContain('gpt-5')
      expect(driver.statusLine).not.toContain('effort:')
      expect(statusTexts(driver)).toContain('Effort "minimal" not supported by gpt-5; reset to default.')
    })

    it('/model still switches when resolveModelInfo is absent (stub compat — bare pair + notice)', async () => {
      const { ctx, llm } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort high')
      delete llm.resolveModelInfo
      await driver.submit('/model openai/gpt-5')
      expect(driver.statusLine).toContain('gpt-5')
      expect(driver.statusLine).not.toContain('effort:')
      expect(statusTexts(driver)).toContain('Effort "high" not supported by gpt-5; reset to default.')
    })
  })

  describe('stale-pair guard', () => {
    it('an effort submit parked behind a /model switch refuses to write', async () => {
      const { ctx, llm } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await driver.submit('/effort')
      driver.effortPickerMove(-1) // focus 'high'
      // Park the submit's validation on a deferred the test controls.
      let release!: (info: ModelInfo) => void
      const gate = new Promise<ModelInfo>(resolve => {
        release = resolve
      })
      let calls = 0
      const base = llm.resolveModelInfo!
      llm.resolveModelInfo = (provider, model) => {
        calls += 1
        return calls === 1 ? gate : base(provider, model)
      }
      const pending = driver.effortPickerSubmit()
      expect(driver.state.effortPicker).toBeUndefined()
      // The model changes while the effort validation is parked.
      await driver.submit('/model openai/gpt-5')
      expect(driver.statusLine).toContain('gpt-5')
      release({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
      await pending
      expect(driver.statusLine).toContain('gpt-5')
      expect(driver.statusLine).not.toContain('effort:')
      expect(statusTexts(driver)).toContain('Model changed; effort not applied.')
    })

    it('an effort submit parked behind a switchSession refuses to write', async () => {
      const { ctx, llm, setDefaultSelection } = makeCtx()
      setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      const driver = await createDriver(ctx as never, {})
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      await driver.submit('/effort')
      driver.effortPickerMove(-1) // focus 'high'
      let release!: (info: ModelInfo) => void
      const gate = new Promise<ModelInfo>(resolve => {
        release = resolve
      })
      let calls = 0
      const base = llm.resolveModelInfo!
      llm.resolveModelInfo = (provider, model) => {
        calls += 1
        return calls === 1 ? gate : base(provider, model)
      }
      const pending = driver.effortPickerSubmit()
      // The deployment default re-seeds onto a different model across the switch.
      setDefaultSelection({ provider: 'openai', model: 'gpt-5' })
      await driver.switchSession('s-resume')
      expect(driver.statusLine).toContain('gpt-5')
      release({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
      await pending
      expect(driver.statusLine).toContain('gpt-5')
      expect(driver.statusLine).not.toContain('effort:')
      expect(statusTexts(driver)).toContain('Model changed; effort not applied.')
    })
  })

  describe('boot seed', () => {
    it('seeds a validated effort from the deployment default and the banner is correct', async () => {
      const { ctx, setDefaultSelection } = makeCtx()
      setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
      const driver = await createDriver(ctx as never, {})
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      expect(driver.statusLine).toContain('effort: high')
      // The boot banner carries the resolved model — no transient default-model
      // label and no spurious no-model notice.
      const banner = statusTexts(driver).find(text => text.startsWith('dsh cc-mode'))
      expect(banner).toContain('deepseek-v4-flash')
      expect(statusTexts(driver).some(text => text.includes('No model configured'))).toBe(false)
    })

    it('silently drops a deployment-default effort the model does not advertise', async () => {
      const { ctx, setDefaultSelection } = makeCtx()
      setDefaultSelection({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'ultra',
      })
      const driver = await createDriver(ctx as never, {})
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      expect(driver.statusLine).not.toContain('effort:')
    })

    it('silently drops the effort when the llm service is missing (still seeds the pair)', async () => {
      const { ctx, setDefaultSelection } = makeCtx({ omitLlm: true })
      setDefaultSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
      const driver = await createDriver(ctx as never, {})
      expect(driver.statusLine).toContain('deepseek-v4-flash')
      expect(driver.statusLine).not.toContain('effort:')
    })
  })

  describe('loadModelEfforts', () => {
    it('returns [] when no model is resolved (no dead-end default entry)', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {})
      await expect(driver.loadModelEfforts()).resolves.toEqual([])
    })

    it('lists the current model effort ids plus the trailing default entry', async () => {
      const { ctx } = makeCtx()
      const driver = await createDriver(ctx as never, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      await expect(driver.loadModelEfforts()).resolves.toEqual(['minimal', 'high', 'default'])
    })
  })
})
