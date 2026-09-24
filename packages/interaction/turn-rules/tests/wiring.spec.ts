/**
 * Listener-level tests at the `tools/post-execute` / `agent/pre-step` /
 * `agent/turn-stopping` boundaries with a fake ctx (edit-recovery-hint
 * wiring.spec pattern): denylist exclusion, lastPromptText dedupe,
 * value-accept passthrough, `exec.agent === undefined` no-op counter, and the
 * top-level gate (plan §5).
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerListeners } from '../src/wiring.ts'
import { writeLedger } from '../src/ledger.ts'
import type { TurnRule } from '../src/discovery.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tr-wiring-'))
  dirs.push(home)
  return home
}

function rule(overrides: Partial<TurnRule> = {}): TurnRule {
  return {
    ruleKey: 'plug/rules/a.mdc',
    trigger: 'FORBIDDEN_PATTERN',
    triggerOn: ['tool-results', 'user-prompts'],
    repeat: 'once',
    repeatGap: 10,
    body: 'ADVISORY REMINDER BODY',
    ...overrides,
  }
}

interface Rig {
  debug: ReturnType<typeof vi.fn>
  post: (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  preStep: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  turnStopping: (payload: { agent: Agent }) => void
  inject: ReturnType<typeof vi.fn>
}

function rig(options: { home?: string; rules?: TurnRule[] } = {}): Rig {
  const home = options.home ?? tempHome()
  const debug = vi.fn()
  const inject = vi.fn()
  const listeners = new Map<string, unknown>()
  const ctx = {
    logger: { debug, warn: vi.fn() },
    on: vi.fn((event: string, listener: unknown) => { listeners.set(event, listener) }),
    get: () => undefined,
    dshHomePath: (...segments: string[]) => join(home, ...segments),
  }
  registerListeners(ctx as never, Promise.resolve(options.rules ?? [rule()]))
  expect(listeners.get('tools/post-execute')).toBeTruthy()
  return {
    debug,
    post: listeners.get('tools/post-execute') as Rig['post'],
    preStep: listeners.get('agent/pre-step') as Rig['preStep'],
    turnStopping: listeners.get('agent/turn-stopping') as Rig['turnStopping'],
    inject,
  }
}

function agent(options: { id?: string; origin?: string; depth?: number } = {}): Agent {
  return {
    session: { header: { id: options.id ?? 'sess-1', origin: options.origin ?? 'user', delegationDepth: options.depth ?? 0 } },
    inject: undefined,
  } as unknown as Agent
}

function agentWithInject(options: { id?: string; origin?: string; depth?: number } = {}): Agent {
  const base = agent(options) as unknown as { inject: ReturnType<typeof vi.fn> }
  base.inject = vi.fn()
  return base as unknown as Agent
}

const nextAccept = (content?: unknown) => async () =>
  ({ kind: 'accept', ...(content !== undefined ? { content } : {}) }) as unknown as PostToolDecision

function execWith(args: unknown, agentArg?: Agent): ToolExecution {
  return { name: 'edit', arguments: args, agent: agentArg ?? agentWithInject() } as unknown as ToolExecution
}

function result(text: string): ToolExecutionResult {
  return { content: [{ type: 'text', text }], isError: false } as unknown as ToolExecutionResult
}

async function preStepOf(r: Rig, agentArg: Agent, messages: unknown[]): Promise<unknown> {
  return r.preStep({ agent: agentArg, messages, signal: new AbortController().signal }, async () => ({ kind: 'continue' }))
}

describe('tools/post-execute channel', () => {
  it('fires once on a matching tool unit and appends the reminder as additionalContexts; second identical exec does not re-fire', async () => {
    const r = rig()
    const first = await r.post(execWith({ code: 'calls FORBIDDEN_PATTERN here' }), result('tool output'), nextAccept())
    const contexts = (first as { additionalContexts?: { content: { type: string; text?: string }[] }[] }).additionalContexts
    expect(contexts).toHaveLength(1)
    expect(contexts![0]!.content[0]!.text).toBe('ADVISORY REMINDER BODY')
    // Second identical exec: `once` already claimed.
    const second = await r.post(execWith({ code: 'calls FORBIDDEN_PATTERN here' }), result('tool output'), nextAccept())
    expect((second as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
  })

  it('value-accept passthrough: a value decision is never composed onto', async () => {
    const r = rig()
    const decision = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }), result('out'), async () =>
      ({ kind: 'accept', value: 42 }) as unknown as PostToolDecision)
    expect((decision as { value?: unknown }).value).toBe(42)
    expect((decision as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
  })

  it('exec.agent === undefined: no-op with a debug counter, never persisted', async () => {
    const r = rig()
    // No `agent` property at all (distinct from a falsy one).
    const agentless = { name: 'edit', arguments: { code: 'FORBIDDEN_PATTERN' } } as unknown as ToolExecution
    const decision = await r.post(agentless, result('out'), nextAccept())
    expect((decision as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('agent-undefined'))
    // The claim was NOT persisted: a later top-level exec with the same session fires.
    const later = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }), result('out'), nextAccept())
    expect((later as { additionalContexts?: unknown[] }).additionalContexts).toHaveLength(1)
  })

  it('subagent-origin and delegated agents pass through untouched', async () => {
    const r = rig()
    for (const sub of [agentWithInject({ origin: 'subagent' }), agentWithInject({ depth: 2 })]) {
      const decision = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }, sub), result('out'), nextAccept())
      expect((decision as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
      expect(sub.inject).not.toHaveBeenCalled()
    }
  })

  it('resume rehydration: a ledger-marked once rule does NOT re-fire on the first event of a fresh in-memory state', async () => {
    // Resume/compaction regression pin (§4.6): gate evaluation must run AFTER
    // ledger hydration — a pre-restart fire persisted on disk must suppress
    // the first post-restart match under `once`.
    const home = tempHome()
    await writeLedger(home, 'sess-1', { version: 1, turnCounter: 5, fired: { 'plug/rules/a.mdc': 3 } })
    const r = rig({ home })
    const decision = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }), result('out'), nextAccept())
    expect((decision as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    // And the pen-state survives: no second ledger write resurrected a claim.
    const again = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }), result('out'), nextAccept())
    expect((again as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
  })
})

describe('agent/pre-step channel', () => {
  it('injects one attributed message per fired rule; denylisted turn-rules messages never match (self-feed prevention)', async () => {
    const r = rig()
    const main = agentWithInject()
    await preStepOf(r, main, [
      { content: [{ type: 'text', text: 'please FORBIDDEN_PATTERN the thing' }] },
    ])
    expect(main.inject).toHaveBeenCalledTimes(1)
    const injected = (main.inject as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { content: { text?: string }[]; source: { kind: string } }
    expect(injected.source.kind).toBe('turn-rules')
    expect(injected.content[0]!.text).toBe('ADVISORY REMINDER BODY')
    // Self-feed: the injected reminder text itself on a later step never matches.
    await preStepOf(r, main, [{ content: [{ type: 'text', text: 'ADVISORY REMINDER BODY FORBIDDEN_PATTERN' }], source: { kind: 'turn-rules' } }])
    expect(main.inject).toHaveBeenCalledTimes(1)
  })

  it('lastPromptText dedupe: the same pending text on a later step does not re-evaluate (and cannot re-fire)', async () => {
    const r = rig({ rules: [rule({ repeat: 'after-gap', repeatGap: 1 })] })
    const main = agentWithInject()
    const messages = [{ content: [{ type: 'text', text: 'FORBIDDEN_PATTERN please' }] }]
    await preStepOf(r, main, messages)
    await preStepOf(r, main, messages)
    expect(main.inject).toHaveBeenCalledTimes(1)
    // Turn stops advance the counter; the same text still never re-evaluates.
    r.turnStopping({ agent: main })
    await preStepOf(r, main, messages)
    expect(main.inject).toHaveBeenCalledTimes(1)
  })

  it('subagent pre-steps never inject', async () => {
    const r = rig()
    const sub = agentWithInject({ origin: 'subagent' })
    await preStepOf(r, sub, [{ content: [{ type: 'text', text: 'FORBIDDEN_PATTERN' }] }])
    expect(sub.inject).not.toHaveBeenCalled()
  })
})

describe('agent/turn-stopping counter', () => {
  it('advances the counter so after-gap re-arms exactly at the gap; subagents never bump', async () => {
    const r = rig({ rules: [rule({ repeat: 'after-gap', repeatGap: 2 })] })
    const main = agentWithInject()
    // Fire on the tool channel (counter = 0).
    const first = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }, main), result('out'), nextAccept())
    expect((first as { additionalContexts?: unknown[] }).additionalContexts).toHaveLength(1)
    // Two turn stops → counter 2 → 2 - 0 >= 2 → re-armed.
    r.turnStopping({ agent: main })
    r.turnStopping({ agent: main })
    const second = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }, main), result('out'), nextAccept())
    expect((second as { additionalContexts?: unknown[] }).additionalContexts).toHaveLength(1)
    // Not yet re-armed again after one further stop.
    r.turnStopping({ agent: main })
    const third = await r.post(execWith({ code: 'FORBIDDEN_PATTERN' }, main), result('out'), nextAccept())
    expect((third as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
  })
})
