/**
 * Slice 2a: the `actor-contract` settings gate (docs/plans/2026-09-21-
 * subagent-actor-contract-prompts.md §3.1/§3.2). Unit coverage for the reader
 * (namespace schema, absent-provider default, explicit `[]` off, `['*']`
 * uniform) and integration coverage at the two spawn seams: the Task dispatch
 * persona fold and the worktree-isolation persona.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { applyActorContract } from '@dsh-cc/claude-code-agents'
import {
  ACTOR_CONTRACT_NAMESPACE,
  DEFAULT_ACTOR_CONTRACT_MODELS,
  actorContractSettingsSchema,
  actorContractPatterns,
  gateCandidates,
  mountActorContractGate,
} from '../src/actor-contract-gate.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'
import { AgentRegistry } from '../src/registry.ts'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

const COMPLETED = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] } as const

/** A marked definition body: the sentinel identifies the gated block content. */
const markedBody = (model: string | null): string => {
  const modelLine = model === null ? '' : `model: ${model}\n`
  return '---\nname: gated\ndescription: Test\n' + modelLine + '---\n'
    + 'INTRO\n\n'
    + '<!-- actor-contract:start -->\n'
    + '## Actor and evidence contract\n'
    + 'NO-USER-IDENTITY-SENTINEL\n'
    + '<!-- actor-contract:end -->\n\n'
    + 'AFTER\n'
}

const tmpRoots: string[] = []
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-gate-'))
  tmpRoots.push(dir)
  return dir
}

function writeAgent(root: string, name: string, body: string): void {
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), body, 'utf8')
}

function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

interface Mount {
  ctx: Context
  gate: ReturnType<typeof mountActorContractGate>
  continuableStarts(): Record<string, unknown>[]
}

/** Mount the real Task tool over a recording fake subagents seam. */
async function mount(opts: {
  routes?: { resolve(model: string | undefined): { provider?: string; model?: string } | undefined }
} = {}): Promise<Mount> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const emit = (event: string, info: Record<string, unknown>): void => {
    ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
  }
  const continuableStarts: Record<string, unknown>[] = []
  ctx.provide('subagents', {
    async startActivation(spec: Record<string, unknown>) {
      const childId = (spec['childId'] as string | undefined) ?? 'child-1'
      emit('subagent/start', { runId: 'run-1', provider: spec['provider'], id: childId, local: true })
      continuableStarts.push(spec['request'] as Record<string, unknown>)
      emit('subagent/end', {
        runId: 'run-1', provider: spec['provider'], id: childId, local: true,
        stopReason: COMPLETED.stopReason, lastAssistantMessage: COMPLETED.output,
      })
      return {
        childId,
        messageId: 'm-1',
        result: Promise.resolve(COMPLETED),
        dispose: () => Promise.resolve(),
      }
    },
    getProvider: () => ({ prepareContinuable: async () => ({}) }),
    list: () => ['spawn'],
  })
  if (opts.routes !== undefined) ctx.provide('ccModelRoutes', opts.routes)
  const gate = mountActorContractGate(ctx)
  registerTaskTool(ctx, new AgentRegistry())
  return { ctx, gate, continuableStarts: () => continuableStarts }
}

let callCounter = 0
async function call(ctx: Context, args: Record<string, unknown>, agent: Agent) {
  return (await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${++callCounter}` as never,
    name: TASK_TOOL,
    arguments: args,
    agent,
  })) as { isError: boolean; content: { type: string; text: string }[] }
}

describe('actor-contract gate reader', () => {
  it('defaults to ["glm-*"] when no settings provider exists', () => {
    const ctx = new Context()
    const gate = mountActorContractGate(ctx)
    expect(ACTOR_CONTRACT_NAMESPACE).toBe('actor-contract')
    expect(DEFAULT_ACTOR_CONTRACT_MODELS).toEqual(['glm-*'])
    expect(gate.patterns()).toEqual(['glm-*'])
    expect(actorContractPatterns(ctx)).toEqual(['glm-*'])
    // Schema resolves the default for a stored partial section.
    expect(actorContractSettingsSchema()({}) as { models: string[] }).toEqual({ models: ['glm-*'] })
  })

  it('explicit [] closes the gate for glm candidates', () => {
    const gate = mountActorContractGate(new Context())
    gate.setSource(() => ({ models: [] }))
    gate.onChange()
    expect(gate.patterns()).toEqual([])
    expect(applyActorContract('A\n<!-- actor-contract:start -->\nBLOCK\n<!-- actor-contract:end -->\nB', ['glm-4.7'], gate.patterns())).toBe('A\nB')
  })

  it('["*"] opens the gate for any candidate', () => {
    const gate = mountActorContractGate(new Context())
    gate.setSource(() => ({ models: ['*'] }))
    gate.onChange()
    expect(applyActorContract('A\n<!-- actor-contract:start -->\nBLOCK\n<!-- actor-contract:end -->\nB', ['claude-sonnet-4-20250514'], gate.patterns())).toContain('BLOCK')
  })
})

describe('gate candidate selection', () => {
  it('inherit (undefined model) yields NO candidates — fail closed', () => {
    expect(gateCandidates(undefined, { provider: 'glm', model: 'glm-4.7' })).toEqual([])
  })
  it('no resolution → the raw frontmatter token is the sole candidate', () => {
    expect(gateCandidates('glm-4.7', undefined)).toEqual(['glm-4.7'])
  })
  it('resolved route id leads, raw token joins when it differs', () => {
    expect(gateCandidates('sonnet', { provider: 'glm', model: 'glm-4.7' })).toEqual(['glm-4.7', 'sonnet'])
    expect(gateCandidates('glm-4.7', { model: 'glm-4.7' })).toEqual(['glm-4.7'])
  })
})

describe('Task dispatch persona gate', () => {
  // rc.5: persona no longer rides the start request at all — the composition
  // slice (plan C5) re-applies the GATED persona to the child. These scenarios
  // keep pinning the gate's strip/keep semantics against applyActorContract
  // with the exact candidate/pattern inputs the dispatch fold used to feed.

  it('gate OPEN by default: route resolves sonnet → glm-4.7, block kept, markers gone', async () => {
    const persona = applyActorContract(
      markedBody('sonnet'),
      gateCandidates('sonnet', { provider: 'glm', model: 'glm-4.7' }),
      DEFAULT_ACTOR_CONTRACT_MODELS,
    )
    expect(persona).toContain('NO-USER-IDENTITY-SENTINEL')
    expect(persona).toContain('AFTER')
    expect(persona).not.toContain('actor-contract:')
  })

  it('route resolves to a non-glm model: block stripped, unmarked persona byte-identical', async () => {
    const persona = applyActorContract(
      markedBody('sonnet'),
      gateCandidates('sonnet', { model: 'claude-sonnet-4-20250514' }),
      DEFAULT_ACTOR_CONTRACT_MODELS,
    )
    expect(persona).not.toContain('NO-USER-IDENTITY-SENTINEL')
    expect(persona).not.toContain('actor-contract:')
    expect(persona).toContain('AFTER')
    const plain = applyActorContract('Plain.', gateCandidates('sonnet', { model: 'claude-sonnet-4-20250514' }), DEFAULT_ACTOR_CONTRACT_MODELS)
    expect(plain).toBe('Plain.')
  })

  it('no ccModelRoutes service + literal glm-4.7 frontmatter → gate OPEN (raw-token fallback)', async () => {
    const persona = applyActorContract(markedBody('glm-4.7'), gateCandidates('glm-4.7', undefined), DEFAULT_ACTOR_CONTRACT_MODELS)
    expect(persona).toContain('NO-USER-IDENTITY-SENTINEL')
  })

  it('model undefined (inherit) with a marked definition → gate CLOSED regardless of services', async () => {
    const persona = applyActorContract(markedBody(null), gateCandidates(undefined, { model: 'glm-4.7' }), DEFAULT_ACTOR_CONTRACT_MODELS)
    expect(persona).not.toContain('NO-USER-IDENTITY-SENTINEL')
    expect(persona).not.toContain('actor-contract:')
  })

  it('settings override driven through the gate hooks: ["*"] opens non-glm, [] closes glm', async () => {
    const { ctx, gate } = await mount({
      routes: { resolve: (m) => m === 'sonnet' ? { model: 'claude-sonnet-4-20250514' } : undefined },
    })
    const candidates = gateCandidates('sonnet', { model: 'claude-sonnet-4-20250514' })
    gate.setSource(() => ({ models: ['*'] }))
    gate.onChange()
    expect(applyActorContract(markedBody('sonnet'), candidates, actorContractPatterns(ctx))).toContain('NO-USER-IDENTITY-SENTINEL')

    gate.setSource(() => ({ models: [] }))
    gate.onChange()
    expect(applyActorContract(markedBody('sonnet'), candidates, actorContractPatterns(ctx))).not.toContain('NO-USER-IDENTITY-SENTINEL')
  })

  it('rc.5 invariant: the dispatch path itself never puts persona on the start request', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'gated', markedBody('sonnet'))
    const { ctx, continuableStarts: starts } = await mount({
      routes: { resolve: (m) => m === 'sonnet' ? { provider: 'glm', model: 'glm-4.7' } : undefined },
    })
    await call(ctx, { subagent_type: 'gated', description: 'x', prompt: 't' }, agentAt(ws))
    expect(starts()).toHaveLength(1)
    expect(starts()[0]!['persona']).toBeUndefined()
  })
})
