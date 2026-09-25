import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@dsh-cc/tools'
import { resolveClassifierBackend, resolveProbeBackend, GAUGE_UNRESOLVABLE_KEY } from '../src/gauge-backend.ts'
import { createWarnOnce, resetPolicyWarned } from '../src/route-policy.ts'

/** Minimal ctx face: only `settings` (and a logger) are consulted. */
function ctxWith(namespaces: Record<string, unknown>): Context {
  return {
    get: (name: string) =>
      name === 'settings' ? { get: (ns: string) => namespaces[ns] } : undefined,
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
}) {
  const warnings: { key: string; message: string }[] = []
  const deps = {
    route: opts.route,
    backend: opts.backend ?? 'auto',
    warnOnce: createWarnOnce((message) => warnings.push({ key: GAUGE_UNRESOLVABLE_KEY, message })),
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
    })
    expect(out).not.toHaveProperty('apiKey')
  })

  it('credentials service (when mounted) wins over the env spelling', async () => {
    process.env.GAUGE_TEST_KEY = 'from-env'
    const ctx = {
      get: (name: string) =>
        name === 'settings'
          ? { get: (ns: string) => (ns === 'model-aliases' ? gaugeAlias({ provider: 'deepseek' }) : ns === 'llm-pi-ai' ? providerRecord()['llm-pi-ai'] : undefined) }
          : name === 'credentials'
            ? { resolve: async (ref: string) => ({ value: ref === 'GAUGE_TEST_KEY' ? 'from-credentials' : undefined }) }
            : undefined,
      logger: { warn: () => {}, debug: () => {} },
    } as unknown as Context
    const h = harness({})
    const out = await resolveClassifierBackend(ctx, h.exec, h.deps)
    expect(out).toMatchObject({ backend: 'systemone', apiKey: 'from-credentials' })
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
