/**
 * Integration tests for the cc-plugin-loader model-alias resolver threading:
 * an injected `resolveModel` is honored at `AgentProvider.start` for alias /
 * inherit / literal-id inputs, and the no-resolver fallback stays byte-identical
 * to the historical overlay behaviour.
 */
import { describe, expect, it } from 'vitest'
import { mountAgents } from '../src/agents.ts'
import type { ResolveModel } from '../src/agents.ts'
import { tempPluginRoot, writeFileAt } from './helpers.ts'

interface FakeSeam {
  registerProvider: (p: unknown) => () => void
  getProvider: () => unknown
  startActivation: (spec: Record<string, unknown>) => Promise<unknown>
  specs: Array<Record<string, unknown>>
  providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }>
}

/** A fake subagent seam that captures registered providers and records activation specs. */
function fakeSeam(): FakeSeam {
  const providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }> = []
  const specs: Array<Record<string, unknown>> = []
  return {
    providers,
    specs,
    registerProvider: (p) => { providers.push(p as never); return () => {} },
    getProvider: (name: string) => (name === 'spawn' ? { name: 'spawn' } : undefined),
    startActivation: async (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { childId: 'fake-child', messageId: 'fake-m', result: Promise.resolve(), dispose: () => Promise.resolve() }
    },
  }
}

/** Mount one agent whose frontmatter carries the given `model`, over a seam. */
async function mountOne(model: string | undefined, resolveModel?: ResolveModel, effort?: string): Promise<FakeSeam> {
  const { root, dispose } = await tempPluginRoot()
  const fm = [
    '---',
    'description: test agent',
    ...(model !== undefined ? [`model: ${JSON.stringify(model)}`] : []),
    ...(effort !== undefined ? [`effort: ${effort}`] : []),
    '---',
    'You are a test agent.',
  ].join('\n')
  await writeFileAt(root, 'agents/test.md', fm)
  const seam = fakeSeam()
  await mountAgents({
    pluginRoot: root,
    manifest: { name: 'p', agents: [] } as never,
    subagents: { registerProvider: seam.registerProvider, getProvider: seam.getProvider, startActivation: seam.startActivation },
    resolveModel,
  })
  await dispose()
  return seam
}

/** The delegating request the provider put on the last recorded activation spec. */
function delegationOf(seam: FakeSeam): Record<string, unknown> {
  return seam.specs[seam.specs.length - 1]!['request'] as Record<string, unknown>
}

describe('AgentProvider model resolution', () => {
  it('no resolver: overlays the literal model id (byte-identical fallback)', async () => {
    const seam = await mountOne('deepseek-chat')
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toMatchObject({ provider: 'parent', model: 'deepseek-chat' })
  })

  it('no resolver, no model: no agentOptions model overlay', async () => {
    const seam = await mountOne(undefined)
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toEqual({ provider: 'parent' })
  })

  it('resolver returns a route: overlays the resolved provider+model', async () => {
    const seam = await mountOne(
      'opus',
      (model) => model === 'opus' ? { provider: 'deepseek-official', model: 'deepseek-v4-pro' } : undefined,
    )
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('resolver returns a model-only route: overlays model, inherits parent provider', async () => {
    const seam = await mountOne(
      'sonnet',
      (model) => model === 'sonnet' ? { model: 'deepseek-flash' } : undefined,
    )
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toMatchObject({ provider: 'parent', model: 'deepseek-flash' })
  })

  it('resolver returns undefined (inherit): no model override (inherits parent route)', async () => {
    const seam = await mountOne('inherit', () => undefined)
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toEqual({ provider: 'parent' })
  })

  it('resolver returns a route with reasoningEffort: forwards all three fields', async () => {
    const seam = await mountOne(
      'opus',
      (model) => model === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'xhigh' }
        : undefined,
    )
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toEqual({
      provider: 'orchestrix',
      model: 'glm-5.3',
      reasoningEffort: 'xhigh',
    })
  })

  it('resolver returns inherit: no effort leak even when the resolver carries effort for other aliases', async () => {
    const seam = await mountOne(
      'sonnet',
      (model) => model === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' }
        : undefined,
    )
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toEqual({ provider: 'parent' })
  })
})

describe('AgentProvider def.effort fold', () => {
  it('no resolver: frontmatter effort is stamped onto agentOptions', async () => {
    const seam = await mountOne('deepseek-chat', undefined, 'low')
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toMatchObject({ model: 'deepseek-chat', reasoningEffort: 'low' })
  })

  it('route effort wins over frontmatter def.effort', async () => {
    const seam = await mountOne(
      'opus',
      (model) => model === 'opus' ? { model: 'glm-5.3', reasoningEffort: 'high' } : undefined,
      'low',
    )
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toMatchObject({ reasoningEffort: 'high' })
  })

  it('resolver route without effort + no frontmatter effort: no reasoningEffort key', async () => {
    const seam = await mountOne('sonnet', (model) => model === 'sonnet' ? { model: 'glm-5.3' } : undefined)
    await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(seam)['agentOptions']).toEqual({ provider: 'parent', model: 'glm-5.3' })
  })
})
