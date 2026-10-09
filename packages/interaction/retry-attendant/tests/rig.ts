/**
 * Shared listener-level test rig (post-edit-verify tests/recovery-wiring.spec.ts
 * precedent): a fake ctx capturing the listeners `apply`/`registerListeners`
 * register, driven directly at the seam boundaries — no full agent-loop rig.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { createState, type RetryState } from '../src/state.ts'
import { registerListeners } from '../src/wiring.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'retry-attendant-home-'))
  dirs.push(home)
  return home
}

export function enable(home: string, section: Record<string, unknown> = { enabled: true }): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'retry-attendant': section }))
}

export interface Rig {
  ctx: {
    logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
    get: (key: string) => unknown
  }
  state: RetryState
  post: (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<unknown>) => Promise<unknown>
  pre: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown>
  execute: (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>
  result: (exec: ToolExecution, result: ToolExecutionResult) => void
}

/**
 * Mount the listeners with an inspectable state. `approval` controls the
 * per-escalation `ctx.get('approval')` lookup (undefined = approval-absent
 * fallback path). A throwing `stateFor` forces internal errors.
 */
export function rig(options: { home: string; approval?: unknown; stateFor?: () => RetryState }): Rig {
  const state = createState()
  const stateFor = options.stateFor ?? ((): RetryState => state)
  const ctx = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    get: (key: string): unknown => (key === 'approval' ? options.approval : undefined),
    dshHomePath: (): string => options.home,
  }
  registerListeners(ctx as never, () => stateFor())
  const listener = (event: string): (...args: never[]) => unknown => {
    const call = (ctx.on as ReturnType<typeof vi.fn>).mock.calls.find(([name]: [string]) => name === event)
    if (call === undefined) throw new Error(`no ${event} listener registered`)
    return call[1] as (...args: never[]) => unknown
  }
  return {
    ctx,
    state,
    post: listener('tools/post-execute') as Rig['post'],
    pre: listener('tools/pre-execute') as Rig['pre'],
    execute: listener('tools/execute') as Rig['execute'],
    result: listener('tools/result') as Rig['result'],
  }
}

export interface FakeAgent {
  session: { header: { id: string }; append: ReturnType<typeof vi.fn> }
  inject: ReturnType<typeof vi.fn>
}

export function fakeAgent(id = 's1'): FakeAgent {
  return { session: { header: { id }, append: vi.fn() }, inject: vi.fn() }
}

/** A bash exec; extra fields (callId, agent, reworded description) via overrides. Agent defaults to a fake s1 agent. */
export function bashExec(command: string, overrides: Record<string, unknown> = {}): ToolExecution {
  const { agent = fakeAgent(), ...rest } = overrides
  return { name: 'bash', arguments: { command, description: 'run it', ...rest }, agent, ...rest } as unknown as ToolExecution
}

/** Success-shaped promoted bash timeout (the default-composition surface). */
export function promotedResult(): ToolExecutionResult {
  return {
    isError: false,
    value: { kind: 'promoted', jobId: 'j1', timeoutMs: 1000 },
    content: [{ type: 'text', text: '[still running after 1000ms] output tail' }],
  } as unknown as ToolExecutionResult
}

/** Clean foreground success (no ambiguous signal). */
export function successResult(text = 'done', exitCode = 0): ToolExecutionResult {
  return {
    isError: false,
    value: { kind: 'foreground', exitCode, output: text },
    content: [{ type: 'text', text }],
  } as unknown as ToolExecutionResult
}

/** Failure result with rendered text (persistent-bash marker etc.). */
export function failureResult(text: string): ToolExecutionResult {
  return { isError: true, error: { message: text }, content: [{ type: 'text', text }] } as unknown as ToolExecutionResult
}

/** The contexts of an accept decision, typed for assertions. */
export function contextsOf(decision: unknown): { source?: { kind?: string }; content?: { type: string; text: string }[] }[] {
  return ((decision as { additionalContexts?: unknown[] }).additionalContexts ?? []) as never
}
