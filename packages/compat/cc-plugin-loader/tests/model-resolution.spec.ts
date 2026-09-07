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
  providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }>
}

/** A fake subagent seam that captures registered providers and a fixed backend. */
function fakeSeam(): FakeSeam {
  const providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }> = []
  return {
    providers,
    registerProvider: (p) => { providers.push(p as never); return () => {} },
    getProvider: (name: string) => (name === 'fork' ? { start: (request: unknown) => ({ forwarded: request }) } : undefined),
  }
}

/** Mount one agent whose frontmatter carries the given `model`, over a seam. */
async function mountOne(model: string | undefined, resolveModel?: ResolveModel): Promise<FakeSeam> {
  const { root, dispose } = await tempPluginRoot()
  const fm = [
    '---',
    'description: test agent',
    ...(model !== undefined ? [`model: ${JSON.stringify(model)}`] : []),
    '---',
    'You are a test agent.',
  ].join('\n')
  await writeFileAt(root, 'agents/test.md', fm)
  const seam = fakeSeam()
  await mountAgents({
    pluginRoot: root,
    manifest: { name: 'p', agents: [] } as never,
    subagents: { registerProvider: seam.registerProvider, getProvider: seam.getProvider },
    resolveModel,
  })
  await dispose()
  return seam
}

/** The delegating request the fake backend forwards, unwrapped from the wrapper. */
function delegationOf(result: unknown): Record<string, unknown> {
  return (result as { forwarded: Record<string, unknown> }).forwarded
}

describe('AgentProvider model resolution', () => {
  it('no resolver: overlays the literal model id (byte-identical fallback)', async () => {
    const seam = await mountOne('deepseek-chat')
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toMatchObject({ provider: 'parent', model: 'deepseek-chat' })
  })

  it('no resolver, no model: no agentOptions model overlay', async () => {
    const seam = await mountOne(undefined)
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toEqual({ provider: 'parent' })
  })

  it('resolver returns a route: overlays the resolved provider+model', async () => {
    const seam = await mountOne(
      'opus',
      (model) => model === 'opus' ? { provider: 'deepseek-official', model: 'deepseek-v4-pro' } : undefined,
    )
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('resolver returns a model-only route: overlays model, inherits parent provider', async () => {
    const seam = await mountOne(
      'sonnet',
      (model) => model === 'sonnet' ? { model: 'deepseek-flash' } : undefined,
    )
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toMatchObject({ provider: 'parent', model: 'deepseek-flash' })
  })

  it('resolver returns undefined (inherit): no model override (inherits parent route)', async () => {
    const seam = await mountOne('inherit', () => undefined)
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toEqual({ provider: 'parent' })
  })

  it('resolver returns a route with reasoningEffort: forwards all three fields', async () => {
    const seam = await mountOne(
      'opus',
      (model) => model === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'xhigh' }
        : undefined,
    )
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toEqual({
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
    const result = await seam.providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(delegationOf(result)['agentOptions']).toEqual({ provider: 'parent' })
  })
})
