/**
 * Built-in repeat-reminder rule (upstream guard/repeat-tool-reminder port):
 * threshold firing per consecutive run, onUserRestart reset, include/exclude
 * transparency, canonical-args key-insensitivity, default-off wiring, and
 * preview truncation.
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createRepeatReminderRule } from '../src/builtins.ts'
import { registerListeners } from '../src/wiring.ts'
import { readUserSettings } from '../src/settings.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tr-builtins-'))
  dirs.push(home)
  return home
}

function agent(): Agent {
  return {
    session: { header: { id: 'sess-1', origin: 'user', delegationDepth: 0 } },
    inject: undefined,
  } as unknown as Agent
}

function execWith(name: string, args: unknown, agentArg?: Agent): ToolExecution {
  return { name, arguments: args, agent: agentArg ?? agent() } as unknown as ToolExecution
}

const results = (text = 'ok'): Readonly<ToolExecutionResult> =>
  ({ content: [{ type: 'text', text }], isError: false }) as unknown as Readonly<ToolExecutionResult>

describe('createRepeatReminderRule (unit)', () => {
  it('fires at each threshold separately (3, then 5, then 8) and never between', () => {
    const rule = createRepeatReminderRule({ thresholds: [3, 5, 8], include: [], exclude: [], argumentsPreviewChars: 500 })
    const a = agent()
    const bodies: (string | undefined)[] = []
    for (let i = 1; i <= 8; i++) bodies.push(rule.observe(execWith('edit', { a: 1 }, a), results(), undefined))
    expect(bodies).toEqual([
      undefined, undefined, 'edit × 3 — {"a":1}', undefined, 'edit × 5 — {"a":1}', undefined, undefined, 'edit × 8 — {"a":1}',
    ])
  })

  it('a different tracked call resets the chain to a new one', () => {
    const rule = createRepeatReminderRule({ thresholds: [3], include: [], exclude: [], argumentsPreviewChars: 0 })
    const a = agent()
    for (let i = 0; i < 2; i++) rule.observe(execWith('edit', { a: 1 }, a), results(), undefined)
    rule.observe(execWith('bash', { cmd: 'ls' }, a), results(), undefined)
    for (let i = 0; i < 2; i++) expect(rule.observe(execWith('edit', { a: 1 }, a), results(), undefined)).toBeUndefined()
    expect(rule.observe(execWith('edit', { a: 1 }, a), results(), undefined)).toBe('edit × 3')
  })

  it('an untracked (excluded) call is transparent: neither extends nor breaks the chain', () => {
    const rule = createRepeatReminderRule({ thresholds: [3], include: [], exclude: ['bash'], argumentsPreviewChars: 0 })
    const a = agent()
    rule.observe(execWith('edit', {}, a), results(), undefined)
    rule.observe(execWith('edit', {}, a), results(), undefined)
    rule.observe(execWith('bash', {}, a), results(), undefined) // untracked → transparent
    expect(rule.observe(execWith('edit', {}, a), results(), undefined)).toBe('edit × 3')
    const excluded = createRepeatReminderRule({ thresholds: [1], include: [], exclude: ['bash'], argumentsPreviewChars: 0 })
    expect(excluded.observe(execWith('bash', {}, agent()), results(), undefined)).toBeUndefined()
  })

  it('include filters: a call not included is transparent (does not break the chain)', () => {
    const rule = createRepeatReminderRule({ thresholds: [2], include: ['edit'], exclude: [], argumentsPreviewChars: 0 })
    const a = agent()
    rule.observe(execWith('edit', {}, a), results(), undefined)
    rule.observe(execWith('bash', {}, a), results(), undefined) // not included → transparent
    expect(rule.observe(execWith('edit', {}, a), results(), undefined)).toBe('edit × 2')
  })

  it('canonical args: key order never splits a chain', () => {
    const rule = createRepeatReminderRule({ thresholds: [2], include: [], exclude: [], argumentsPreviewChars: 0 })
    const a = agent()
    rule.observe(execWith('edit', { a: 1, b: 2 }, a), results(), undefined)
    expect(rule.observe(execWith('edit', { b: 2, a: 1 }, a), results(), undefined)).toBe('edit × 2')
  })

  it('onUserRestart clears all chain state', () => {
    const rule = createRepeatReminderRule({ thresholds: [2], include: [], exclude: [], argumentsPreviewChars: 0 })
    const a = agent()
    rule.observe(execWith('edit', {}, a), results(), undefined)
    rule.onUserRestart()
    expect(rule.observe(execWith('edit', {}, a), results(), undefined)).toBeUndefined()
    expect(rule.observe(execWith('edit', {}, a), results(), undefined)).toBe('edit × 2')
  })

  it('preview: truncated to argumentsPreviewChars and omitted when 0 or empty args', () => {
    const long = JSON.stringify({ x: 'y'.repeat(50) })
    const rule = createRepeatReminderRule({ thresholds: [1], include: [], exclude: [], argumentsPreviewChars: 10 })
    expect(rule.observe(execWith('edit', { x: 'y'.repeat(50) }, agent()), results(), undefined)).toBe(`edit × 1 — ${long.slice(0, 10)}`)
    const off = createRepeatReminderRule({ thresholds: [1], include: [], exclude: [], argumentsPreviewChars: 0 })
    expect(off.observe(execWith('edit', { x: 1 }, agent()), results(), undefined)).toBe('edit × 1')
    expect(off.observe(execWith('edit', {}, agent()), results(), undefined)).toBe('edit × 1')
  })
})

interface Rig {
  post: (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  preStep: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
}

function rig(home: string, settings: Record<string, unknown>): Rig {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-turn-rules': settings }), 'utf8')
  const listeners = new Map<string, unknown>()
  const ctx = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    on: vi.fn((event: string, listener: unknown) => { listeners.set(event, listener) }),
    get: () => undefined,
    dshHomePath: (...segments: string[]) => join(home, ...segments),
  }
  registerListeners(ctx as never)
  return {
    post: listeners.get('tools/post-execute') as Rig['post'],
    preStep: listeners.get('agent/pre-step') as Rig['preStep'],
  }
}

const nextAccept = async (): Promise<PostToolDecision> => ({ kind: 'accept' }) as unknown as PostToolDecision

describe('repeat-reminder wiring', () => {
  it('default-off: no fire without the enabling settings', async () => {
    const home = tempHome()
    const r = rig(home, { enabled: true })
    const a = agent()
    for (let i = 0; i < 5; i++) {
      const decision = await r.post(execWith('edit', {}, a), results(), nextAccept)
      expect(decision.additionalContexts).toBeUndefined()
    }
  })

  it('enabled: fires on the third consecutive call as an additionalContext with source kind turn-rules; cap-aware; reset on user pre-step', async () => {
    const home = tempHome()
    const r = rig(home, { enabled: true, 'repeat-reminder': { enabled: true } })
    const a = agent()
    for (let i = 0; i < 2; i++) {
      const decision = await r.post(execWith('edit', {}, a), results(), nextAccept)
      expect(decision.additionalContexts).toBeUndefined()
    }
    const fired = await r.post(execWith('edit', {}, a), results(), nextAccept)
    const message = fired.additionalContexts![0] as unknown as { content: { text: string }[]; source: { kind: string; form: string; summary: string } }
    expect(message.content[0].text).toBe('edit × 3')
    expect(message.source).toMatchObject({ kind: 'turn-rules', form: 'notice', summary: 'repeat-reminder' })

    // A user-source pre-step resets the chain.
    await r.preStep({ agent: a, messages: [{ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }], signal: new AbortController().signal }, async () => ({}))
    const afterReset = await r.post(execWith('edit', {}, a), results(), nextAccept)
    expect(afterReset.additionalContexts).toBeUndefined()
  })

  it('fires on a block decision too', async () => {
    const home = tempHome()
    const r = rig(home, { enabled: true, 'repeat-reminder': { enabled: true } })
    const a = agent()
    const nextBlock = async (): Promise<PostToolDecision> => ({ kind: 'block', feedback: [] }) as unknown as PostToolDecision
    for (let i = 0; i < 2; i++) {
      const decision = await r.post(execWith('edit', {}, a), results(), nextBlock)
      expect(decision.additionalContexts).toBeUndefined()
    }
    const fired = await r.post(execWith('edit', {}, a), results(), nextBlock)
    expect((fired.additionalContexts![0] as unknown as { content: { text: string }[] }).content[0].text).toBe('edit × 3')
  })

  it('readUserSettings resolves the repeat-reminder section with defaults', async () => {
    const home = tempHome()
    const resolved = await readUserSettings(home)
    expect(resolved.repeatReminder).toEqual({ enabled: false, thresholds: [3, 5, 8], include: [], exclude: [], argumentsPreviewChars: 500 })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      'cc-turn-rules': { enabled: true, 'repeat-reminder': { enabled: true, 'arguments-preview-chars': 20 } },
    }), 'utf8')
    const hot = await readUserSettings(home)
    expect(hot.repeatReminder.enabled).toBe(true)
    expect(hot.repeatReminder.argumentsPreviewChars).toBe(20)
    expect(hot.repeatReminder.thresholds).toEqual([3, 5, 8])
  })
})
