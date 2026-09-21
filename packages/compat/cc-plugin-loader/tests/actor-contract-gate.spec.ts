/**
 * Slice 2b: the `actor-contract` settings gate in the plugin loader
 * (docs/plans/2026-09-21-subagent-actor-contract-prompts.md §3.1/§3.2).
 *
 * This package duplicates the `@dsh-cc/subagent-task` gate module's SCHEMA and
 * DEFAULTS (KEEP IN SYNC by design — either mount order wins via
 * installSectionSafe's multi-owner semantics) but publishes NO cordis service:
 * the task package owns `ccActorContractGate`; this module only installs the
 * settings section and exposes a local live reader that `AgentProvider.start`
 * reads at spawn time.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ACTOR_CONTRACT_NAMESPACE,
  DEFAULT_ACTOR_CONTRACT_MODELS,
  actorContractSettingsSchema,
  gateCandidates,
  mountActorContractGate,
} from '../src/actor-contract-gate.ts'
import { mountAgents } from '../src/agents.ts'
import { mountCcPlugin } from '../src/index.ts'
import { tempPluginRoot, writeFileAt } from './helpers.ts'
import type { ActorContractGate } from '../src/actor-contract-gate.ts'

/** A marked definition body; the sentinel identifies the gated block content. */
const markedBody = (model: string | null): string => {
  const modelLine = model === null ? '' : `model: ${model}\n`
  return '---\ndescription: test agent\n' + modelLine + '---\n'
    + 'INTRO\n\n'
    + '<!-- actor-contract:start -->\n'
    + '## Actor and evidence contract\n'
    + 'NO-USER-IDENTITY-SENTINEL\n'
    + '<!-- actor-contract:end -->\n\n'
    + 'AFTER\n'
}

/** A capture-only seam whose `fork` backend echoes the delegation request. */
function fakeSeam(): {
  registerProvider: (p: unknown) => () => void
  getProvider: (name: string) => unknown
  providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }>
} {
  const providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }> = []
  return {
    providers,
    registerProvider: (p) => { providers.push(p as never); return () => {} },
    getProvider: (name) => (name === 'fork' ? { start: async (r: unknown) => ({ forwarded: r }) } : undefined),
  }
}

/** The prompt the child receives, unwrapped from the fake backend's echo. */
function promptOf(result: unknown): string {
  return ((result as { forwarded: Record<string, unknown> }).forwarded['prompt']) as string
}

/** Mount one agent over the seam, with the gate patterns threaded live. */
async function mountOne(
  body: string,
  resolveModel?: (model: string | undefined) => { provider?: string; model?: string } | undefined,
  gate?: ActorContractGate,
): Promise<{ start(r: unknown): Promise<unknown> }> {
  const { root, dispose } = await tempPluginRoot()
  await writeFileAt(root, 'agents/test.md', body)
  const seam = fakeSeam()
  await mountAgents({
    pluginRoot: root,
    manifest: { name: 'p', agents: [] } as never,
    subagents: { registerProvider: seam.registerProvider, getProvider: seam.getProvider },
    ...(resolveModel !== undefined ? { resolveModel: resolveModel as never } : {}),
    ...(gate !== undefined ? { gatePatterns: () => gate.patterns() } : {}),
  })
  await dispose()
  return seam.providers[0]!
}

describe('actor-contract gate reader (loader-local duplicate)', () => {
  it('defaults to ["glm-*"] when no settings provider exists', () => {
    const gate = mountActorContractGate(new Context())
    expect(ACTOR_CONTRACT_NAMESPACE).toBe('actor-contract')
    expect(DEFAULT_ACTOR_CONTRACT_MODELS).toEqual(['glm-*'])
    expect(gate.patterns()).toEqual(['glm-*'])
    // Schema resolves the default for a stored partial section.
    expect(actorContractSettingsSchema()({}) as { models: string[] }).toEqual({ models: ['glm-*'] })
  })

  it('explicit [] closes the gate for glm; ["*"] opens everything', () => {
    const gate = mountActorContractGate(new Context())
    gate.setSource(() => ({ models: [] }))
    gate.onChange()
    expect(gate.patterns()).toEqual([])
    gate.setSource(() => ({ models: ['*'] }))
    gate.onChange()
    expect(gate.patterns()).toEqual(['*'])
  })
})

describe('gate candidate selection (mirror of the task seam)', () => {
  it('undefined model → no candidates (fail closed); no resolution → raw token only; resolved leads, raw joins', () => {
    expect(gateCandidates(undefined, { provider: 'glm', model: 'glm-4.7' })).toEqual([])
    expect(gateCandidates('glm-4.7', undefined)).toEqual(['glm-4.7'])
    expect(gateCandidates('sonnet', { provider: 'glm', model: 'glm-4.7' })).toEqual(['glm-4.7', 'sonnet'])
    expect(gateCandidates('glm-4.7', { model: 'glm-4.7' })).toEqual(['glm-4.7'])
  })
})

describe('AgentProvider.start persona gate', () => {
  it('gate OPEN by default: sonnet resolves to glm-4.7 → block kept, markers gone', async () => {
    const provider = await mountOne(
      markedBody('sonnet'),
      (m) => m === 'sonnet' ? { provider: 'glm', model: 'glm-4.7' } : undefined,
      mountActorContractGate(new Context()),
    )
    const persona = promptOf(await provider.start({}))
    expect(persona).toContain('NO-USER-IDENTITY-SENTINEL')
    expect(persona).toContain('AFTER')
    expect(persona).not.toContain('actor-contract:')
  })

  it('sonnet resolves to a non-glm model → stripped; unmarked definition byte-identical', async () => {
    const gate = mountActorContractGate(new Context())
    const gated = await mountOne(
      markedBody('sonnet'),
      (m) => m === 'sonnet' ? { model: 'claude-sonnet-4-20250514' } : undefined,
      gate,
    )
    const plain = await mountOne('---\ndescription: p\n---\nPlain.\n', undefined, gate)
    const persona = promptOf(await gated.start({}))
    expect(persona).not.toContain('NO-USER-IDENTITY-SENTINEL')
    expect(persona).not.toContain('actor-contract:')
    expect(promptOf(await plain.start({}))).toBe('Plain.')
  })

  it('no resolver + literal glm-4.7 frontmatter → block present (raw-token fallback)', async () => {
    const provider = await mountOne(markedBody('glm-4.7'), undefined, mountActorContractGate(new Context()))
    expect(promptOf(await provider.start({}))).toContain('NO-USER-IDENTITY-SENTINEL')
  })

  it('model undefined (inherit) → stripped regardless of resolver', async () => {
    const provider = await mountOne(
      markedBody(null),
      () => ({ model: 'glm-4.7' }),
      mountActorContractGate(new Context()),
    )
    const persona = promptOf(await provider.start({}))
    expect(persona).not.toContain('NO-USER-IDENTITY-SENTINEL')
    expect(persona).not.toContain('actor-contract:')
  })
})

describe('mountCcPlugin wiring', () => {
  it('installs the section and threads the live gate: raw glm-4.7 frontmatter keeps the block by default', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p' }))
      await writeFileAt(root, 'agents/gated.md', markedBody('glm-4.7'))
      const ctx = new Context()
      const providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }> = []
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: {
          subagents: {
            registerProvider: (p) => { providers.push(p as never); return () => {} },
            getProvider: (name: string) => (name === 'fork' ? { start: async (r: unknown) => ({ forwarded: r }) } : undefined),
          },
        },
      })
      expect(providers).toHaveLength(1)
      expect(promptOf(await providers[0]!.start({}))).toContain('NO-USER-IDENTITY-SENTINEL')
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('live pattern flip via the gate hooks (setSource/onChange): closed before, ["*"] open after', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p' }))
      await writeFileAt(root, 'agents/gated.md', markedBody('sonnet'))
      const ctx = new Context()
      const providers: Array<{ name: string; start: (r: unknown) => Promise<unknown> }> = []
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: {
          subagents: {
            registerProvider: (p) => { providers.push(p as never); return () => {} },
            getProvider: (name: string) => (name === 'fork' ? { start: async (r: unknown) => ({ forwarded: r }) } : undefined),
          },
        },
      })
      expect(promptOf(await providers[0]!.start({}))).not.toContain('NO-USER-IDENTITY-SENTINEL')
      // Hot-reload path without a full settings provider, per the Slice-2a
      // test precedent: drive the gate hooks directly.
      mount.gate.setSource(() => ({ models: ['*'] }))
      mount.gate.onChange()
      expect(promptOf(await providers[0]!.start({}))).toContain('NO-USER-IDENTITY-SENTINEL')
      mount.dispose()
    } finally {
      await dispose()
    }
  })
})
