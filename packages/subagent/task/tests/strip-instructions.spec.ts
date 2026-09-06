/**
 * Tests for the workspace-instruction strip on delegated Task children:
 * an `agent/pre-step` listener that drops harness `agent-instructions`
 * messages (CLAUDE.md / AGENTS.md baseline) from delegated children so
 * they keep their own persona, plus the inbox drain that removes the
 * pending copy. Top-level agents pass through untouched.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { apply, isAgentInstructions, isDelegated, mountStripWorkspaceInstructions } from '../src/index.ts'

interface FakeInbox {
  nextStep: { id: string; content: unknown; source?: { kind?: string } }[]
  remove: (id: string) => boolean
  removed: string[]
}

/** A fake inbox recording removals without mutating the held array. */
function fakeInbox(messages: FakeInbox['nextStep'] = []): FakeInbox {
  const removed: string[] = []
  return {
    nextStep: messages,
    removed,
    remove(id: string) {
      removed.push(id)
      return true
    },
  } satisfies FakeInbox
}

/** A duck-typed agent whose delegation depth comes from the session header. */
function agentAt(depth: number, inbox?: FakeInbox): Agent {
  return {
    session: { header: { cwd: '/work/repo', delegationDepth: depth } },
    options: {},
    inbox: inbox ?? { nextStep: [], remove: () => false },
  } as unknown as Agent
}

/** A fake agent whose runtime subagentDepth makes `delegationDepthOf` throw. */
function agentWithBadDepth(inbox?: FakeInbox): Agent {
  return {
    session: { header: { cwd: '/work' } },
    options: { subagentDepth: -1 },
    inbox: inbox ?? { nextStep: [], remove: () => false },
  } as unknown as Agent
}

const claudeMd = {
  id: 'ai-1',
  content: [{ type: 'text', text: '<system-reminder>\nInstructions from: CLAUDE.md\n\nrules\n</system-reminder>' }],
  source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
}

const taskPrompt = {
  id: 'task-1',
  content: [{ type: 'text', text: 'do the task' }],
  source: { kind: 'user' },
}

const otherPlugin = {
  id: 'plugin-1',
  content: [{ type: 'text', text: 'hook context' }],
  source: { kind: 'plugin', plugin: 'hooks-claude-code' },
}

const threeMessages = [taskPrompt, claudeMd, otherPlugin]

/** Register the strip listener and drive the pre-step waterfall. */
async function drive(agent: Agent, inner: PreStepDecision): Promise<PreStepDecision> {
  const ctx = new Context()
  mountStripWorkspaceInstructions(ctx)
  return await ctx.waterfall(
    ctx as never,
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(inner),
  )
}

describe('isDelegated / isAgentInstructions', () => {
  it('treats depth 0 as top-level and positive depth as delegated', () => {
    expect(isDelegated(agentAt(0))).toBe(false)
    expect(isDelegated(agentAt(1))).toBe(true)
  })

  it('fails closed when reading the depth throws', () => {
    expect(isDelegated(agentWithBadDepth())).toBe(true)
  })

  it('matches only the agent-instructions source kind', () => {
    expect(isAgentInstructions(claudeMd)).toBe(true)
    expect(isAgentInstructions(taskPrompt)).toBe(false)
    expect(isAgentInstructions(otherPlugin)).toBe(false)
  })
})

describe('strip workspace instructions on delegated children', () => {
  it('passes the enter batch through unchanged at depth 0', async () => {
    const inbox = fakeInbox()
    const decision = await drive(agentAt(0, inbox), { kind: 'enter', messages: threeMessages })
    expect(decision).toEqual({ kind: 'enter', messages: threeMessages })
    expect(inbox.removed).toEqual([])
  })

  it('strips agent-instructions from an enter batch at depth 1', async () => {
    const inbox = fakeInbox()
    const decision = await drive(agentAt(1, inbox), { kind: 'enter', messages: threeMessages })
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt, otherPlugin] })
    expect(inbox.removed).toEqual([])
  })

  it('fails closed and strips for a depth-throwing agent', async () => {
    const inbox = fakeInbox()
    const decision = await drive(agentWithBadDepth(inbox), { kind: 'enter', messages: threeMessages })
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt, otherPlugin] })
  })

  it('keeps a reject decision but drains the inbox', async () => {
    const inbox = fakeInbox([claudeMd])
    const decision = await drive(agentAt(1, inbox), { kind: 'reject' })
    expect(decision).toEqual({ kind: 'reject' })
    expect(inbox.removed).toEqual(['ai-1'])
  })

  it('drains pending agent-instructions from the inbox and keeps other messages', async () => {
    const otherPending = { id: 'pending-1', content: [], source: { kind: 'user' } }
    const inbox = fakeInbox([claudeMd, otherPending])
    const decision = await drive(agentAt(1, inbox), { kind: 'reject' })
    expect(decision).toEqual({ kind: 'reject' })
    expect(inbox.removed).toEqual(['ai-1'])
    expect(inbox.nextStep).toEqual([claudeMd, otherPending])
  })

  it('strips instructions injected by an earlier-registered outer listener', async () => {
    // Production mount order (preset/cc/agent.cordis.yml): `agent-instructions`
    // is rowed far above `cc-subagent-task`, and the cordis waterfall is
    // outermost-first in registration order — an appended injector therefore
    // wraps the strip and would splice the baseline into the enter batch
    // during unwind, AFTER an inner strip already ran. The strip registers
    // with `prepend` to stay outermost and see the injector's output.
    const ctx = new Context()
    ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<PreStepDecision>) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      return { kind: 'enter', messages: [...decision.messages, claudeMd] }
    })
    mountStripWorkspaceInstructions(ctx)
    const inbox = fakeInbox()
    const decision = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent: agentAt(1, inbox), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [taskPrompt] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt] })
  })

  it('keeps an outer listener injection for a top-level agent', async () => {
    const ctx = new Context()
    ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<PreStepDecision>) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      return { kind: 'enter', messages: [...decision.messages, claudeMd] }
    })
    mountStripWorkspaceInstructions(ctx)
    const inbox = fakeInbox()
    const decision = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent: agentAt(0, inbox), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [taskPrompt] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt, claudeMd] })
  })

  it('registers the listener through apply()', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('subagents', { start: async () => ({ result: Promise.resolve({ stopReason: 'completed' }) }) })
    apply(ctx)
    const inbox = fakeInbox()
    const decision = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent: agentAt(1, inbox), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: threeMessages }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt, otherPlugin] })
    expect(inbox.removed).toEqual([])
  })
})
