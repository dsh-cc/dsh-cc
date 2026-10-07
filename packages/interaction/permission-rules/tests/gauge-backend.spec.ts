import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@dsh-cc/tools'
import { resolveClassifierBackend, resolveProbeBackend, GAUGE_UNRESOLVABLE_KEY, GAUGE_WINDOW_MISMATCH_KEY } from '../src/gauge-backend.ts'
import { resetPolicyWarned, type PolicyWarn } from '../src/route-policy.ts'

/** Minimal ctx face: only `settings` (and a logger) are consulted. The gauge
 * read seam is the describe-based RAW USER OVERRIDE (Q3 bridge), so doubles
 * expose `describe()` rather than a resolved-value `get`. */
function ctxWith(namespaces: Record<string, unknown>): Context {
  return {
    get: (name: string) =>
      name === 'settings'
        ? {
            // `get` serves the resolved-alias readers; `describe` serves the
            // Q3 user-override read seam the gauge provider record goes through.
            get: (ns: string) => namespaces[ns],
            describe: () => Object.entries(namespaces).map(([ns, user]) => ({ ns, user })),
          }
        : undefined,
    logger: { warn: () => {}, debug: () => {}, info: () => {} },
  } as unknown as Context
}

function execWithHeader(header?: { provider?: string; model?: string }): ToolExecution {
  return {
    name: 'Bash',
    arguments: { command: 'ls' },
    ...(header === undefined
      ? {}
      : { agent: { session: { requestHeader: () => ({ config: header }) } } }),
  } as unknown as ToolExecution
}

function harness(opts: {
  namespaces?: Record<string, unknown>
  route?: string
  backend?: 'haiku' | 'auto'
  header?: { provider?: string; model?: string }
  gaugeContextWindow?: number
}) {
  const warnings: { key: string; message: string }[] = []
  // Keyed warn-once double (mirrors createWarnOnce semantics across ALL keys
  // so mismatch warnings are assertable by key, not just message).
  const seen = new Set<string>()
  const deps = {
    route: opts.route,
    backend: opts.backend ?? 'auto',
    ...(opts.gaugeContextWindow === undefined ? {} : { gaugeContextWindow: opts.gaugeContextWindow }),
    warnOnce: ((key: string, message: string) => {
      if (seen.has(key)) return
      seen.add(key)
      warnings.push({ key, message })
    }) as PolicyWarn,
    resolveChatRoute: (_exec: ToolExecution, name: string) => ({ provider: 'fake', model: name }),
  }
  const ctx = ctxWith(opts.namespaces ?? {})
  return { deps, ctx, exec: execWithHeader(opts.header), warnings }
}

const gaugeAlias = (extra: Record<string, unknown> = {}) => ({
  gauge: { model: 'llmbox_systemone/laya', protocol: 'systemone', ...extra },
})
const providerRecord = (extra: Record<string, unknown> = {}) => ({
  'llm-pi-ai': { providers: { deepseek: { baseURL: 'http://127.0.0.1:8080', apiKeyEnv: 'GAUGE_TEST_KEY', ...extra } } },
})

describe('resolveClassifierBackend (B2b)', () => {
  beforeEach(() => resetPolicyWarned())
  afterEach(() => { delete process.env.GAUGE_TEST_KEY })

  it('armed gauge: object-form alias + llm-pi-ai provider record ⇒ systemone info with env-fallback apiKey', async () => {
    process.env.GAUGE_TEST_KEY = 'secret-token'
    const h = harness({ namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord() } })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toEqual({
      backend: 'systemone',
      provider: 'deepseek',
      model: 'llmbox_systemone/laya',
      baseURL: 'http://127.0.0.1:8080',
      apiKey: 'secret-token',
      contextWindow: 1024,
    })
    expect(h.warnings).toHaveLength(0)
  })

  it('missing provider record ⇒ gauge-unresolvable warn-once + chat haiku fallback', async () => {
    const h = harness({ namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }) } })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toEqual({ backend: 'chat', route: { provider: 'fake', model: 'haiku' } })
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0].message).toContain('falling back to haiku')
    // warn-once: a second unresolvable resolution stays silent.
    await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(h.warnings).toHaveLength(1)
  })

  it('provider record without baseURL ⇒ same fallback', async () => {
    const h = harness({ namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord({ baseURL: '' }) } })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toEqual({ backend: 'chat', route: { provider: 'fake', model: 'haiku' } })
    expect(h.warnings).toHaveLength(1)
  })

  it("explicit route:'gauge' with backend 'haiku' still assembles systemone (explicit wins)", async () => {
    process.env.GAUGE_TEST_KEY = 'k'
    const h = harness({
      route: 'gauge',
      backend: 'haiku',
      namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord() },
    })
    expect(await resolveClassifierBackend(h.ctx, h.exec, h.deps)).toMatchObject({ backend: 'systemone', model: 'llmbox_systemone/laya' })
  })

  it('explicit chat route resolves the chat lane unchanged', async () => {
    const h = harness({ route: 'fast-lane', backend: 'auto' })
    expect(await resolveClassifierBackend(h.ctx, h.exec, h.deps)).toEqual({
      backend: 'chat',
      route: { provider: 'fake', model: 'fast-lane' },
    })
  })

  it('alias without provider fills from the parent request header', async () => {
    process.env.GAUGE_TEST_KEY = 'k'
    const h = harness({
      namespaces: { 'model-aliases': gaugeAlias(), ...providerRecord() },
      header: { provider: 'deepseek', model: 'unused' },
    })
    expect(await resolveClassifierBackend(h.ctx, h.exec, h.deps)).toMatchObject({
      backend: 'systemone',
      provider: 'deepseek',
      model: 'llmbox_systemone/laya',
 apiKey: 'k',
    })
  })

  it('apiKeyEnv unset in env (and no credentials service) ⇒ apiKey omitted, no header material', async () => {
    const h = harness({ namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord() } })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toEqual({
      backend: 'systemone',
      provider: 'deepseek',
      model: 'llmbox_systemone/laya',
      baseURL: 'http://127.0.0.1:8080',
      contextWindow: 1024,
    })
    expect(out).not.toHaveProperty('apiKey')
  })

  it('credentials service (when mounted) wins over the env spelling', async () => {
    process.env.GAUGE_TEST_KEY = 'from-env'
    const ctx = {
      get: (name: string) =>
        name === 'settings'
          ? {
              get: (ns: string) => (ns === 'model-aliases' ? gaugeAlias({ provider: 'deepseek' }) : ns === 'llm-pi-ai' ? providerRecord()['llm-pi-ai'] : undefined),
              describe: () => [{ ns: 'model-aliases', user: gaugeAlias({ provider: 'deepseek' }) }, { ns: 'llm-pi-ai', user: providerRecord()['llm-pi-ai'] }],
            }
          : name === 'credentials'
            ? { resolve: async (ref: string) => ({ value: ref === 'GAUGE_TEST_KEY' ? 'from-credentials' : undefined }) }
            : undefined,
      logger: { warn: () => {}, debug: () => {} },
    } as unknown as Context
    const h = harness({})
    const out = await resolveClassifierBackend(ctx, h.exec, h.deps)
    expect(out).toMatchObject({ backend: 'systemone', apiKey: 'from-credentials' })
  })

  it('gaugeContextWindow settings override wins over the registry', async () => {
    const h = harness({
      gaugeContextWindow: 9999,
      namespaces: { 'model-aliases': gaugeAlias({ model: 'bjev', provider: 'deepseek' }), ...providerRecord() },
    })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toMatchObject({ backend: 'systemone', model: 'bjev', contextWindow: 9999 })
    expect(h.warnings).toHaveLength(0)
  })

  it('registry hit: bjev resolves 16384 without a record contextWindow', async () => {
    const h = harness({
      namespaces: { 'model-aliases': gaugeAlias({ model: 'bjev', provider: 'deepseek' }), ...providerRecord() },
    })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toMatchObject({ backend: 'systemone', model: 'bjev', contextWindow: 16384 })
    expect(h.warnings).toHaveLength(0)
  })

  it('unknown model id: provider record contextWindow passes through (level-3 fallback)', async () => {
    const h = harness({
      namespaces: { 'model-aliases': gaugeAlias({ model: 'llmbox_systemone/xyz', provider: 'deepseek' }), ...providerRecord({ contextWindow: 2048 }) },
    })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toMatchObject({ backend: 'systemone', model: 'llmbox_systemone/xyz', contextWindow: 2048 })
    expect(h.warnings).toHaveLength(0)
  })

  it('registry shadows a differing record contextWindow: one GAUGE_WINDOW_MISMATCH_KEY warn-once', async () => {
    const h = harness({
      namespaces: { 'model-aliases': gaugeAlias({ model: 'bjev', provider: 'deepseek' }), ...providerRecord({ contextWindow: 1024 }) },
    })
    const out = await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(out).toMatchObject({ backend: 'systemone', model: 'bjev', contextWindow: 16384 })
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]!.key).toBe(GAUGE_WINDOW_MISMATCH_KEY)
    expect(h.warnings[0]!.message).toContain('16384')
    expect(h.warnings[0]!.message).toContain('permissions.autoMode.gaugeContextWindow')
    // warn-once: a second mismatching resolution stays silent.
    await resolveClassifierBackend(h.ctx, h.exec, h.deps)
    expect(h.warnings).toHaveLength(1)
  })
})

describe('resolveProbeBackend (PR-C matrix)', () => {
  beforeEach(() => resetPolicyWarned())
  afterEach(() => { delete process.env.GAUGE_TEST_KEY })

  it('explicit chat route → chat lane, never gauge', async () => {
    const h = harness({ route: 'fast-lane', backend: 'auto' })
    expect(await resolveProbeBackend(h.ctx, h.exec, h.deps)).toEqual({
      backend: 'chat',
      route: { provider: 'fake', model: 'fast-lane' },
    })
  })

  it("explicit route 'gauge' forces the native lane even with backend 'haiku'", async () => {
    process.env.GAUGE_TEST_KEY = 'k'
    const h = harness({
      route: 'gauge',
      backend: 'haiku',
      namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord() },
    })
    expect(await resolveProbeBackend(h.ctx, h.exec, h.deps)).toMatchObject({
      backend: 'systemone',
      model: 'llmbox_systemone/laya',
    })
  })

  it("backend 'auto' + armed gauge → systemone", async () => {
    process.env.GAUGE_TEST_KEY = 'k'
    const h = harness({
      backend: 'auto',
      namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord() },
    })
    expect(await resolveProbeBackend(h.ctx, h.exec, h.deps)).toMatchObject({ backend: 'systemone', provider: 'deepseek' })
  })

  it("backend 'auto' + unconfigured gauge → haiku silently (zero new warnings)", async () => {
    const h = harness({ backend: 'auto' })
    expect(await resolveProbeBackend(h.ctx, h.exec, h.deps)).toEqual({
      backend: 'chat',
      route: { provider: 'fake', model: 'haiku' },
    })
    expect(h.warnings).toHaveLength(0)
  })

  it('auto + armed but unresolvable → gauge-unresolvable warn-once + haiku chat fallback', async () => {
    const h = harness({ backend: 'auto', namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }) } })
    expect(await resolveProbeBackend(h.ctx, h.exec, h.deps)).toEqual({
      backend: 'chat',
      route: { provider: 'fake', model: 'haiku' },
    })
    expect(h.warnings).toHaveLength(1)
    // warn-once: a second unresolvable resolution stays silent.
    await resolveProbeBackend(h.ctx, h.exec, h.deps)
    expect(h.warnings).toHaveLength(1)
  })

  it("backend 'haiku' → haiku without consulting gauge", async () => {
    process.env.GAUGE_TEST_KEY = 'k'
    const h = harness({
      backend: 'haiku',
      namespaces: { 'model-aliases': gaugeAlias({ provider: 'deepseek' }), ...providerRecord() },
    })
    expect(await resolveProbeBackend(h.ctx, h.exec, h.deps)).toEqual({
      backend: 'chat',
      route: { provider: 'fake', model: 'haiku' },
    })
  })
})
