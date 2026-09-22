import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { RECOVERY_HINT } from '../src/hint.ts'
import { apply } from '../src/index.ts'

/**
 * Listener-level tests at the `tools/post-execute` boundary with a fake ctx:
 * we capture the listener `apply` registers and drive it directly, so every
 * trigger permutation is observable end-to-end without a full agent-loop rig.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'erh-home-'))
  dirs.push(home)
  return home
}

interface CtxLike {
  logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  get: (key: string) => unknown
  dshHomePath?: (...segments: string[]) => string
}

interface Rig {
  ctx: CtxLike
  listener: (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
}

function rig(options: { home?: string; dshHomeThrows?: boolean }): Rig {
  const ctx: CtxLike = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    get: () => undefined,
  }
  if (options.home !== undefined) ctx.dshHomePath = () => options.home!
  if (options.dshHomeThrows) {
    ;(ctx as unknown as { dshHomePath: () => string }).dshHomePath = () => {
      throw new Error('no home')
    }
  }
  apply(ctx as never)
  const call = ctx.on.mock.calls.find(([event]) => event === 'tools/post-execute') as unknown as [
    string,
    (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>,
  ]
  expect(call).toBeTruthy()
  return { ctx, listener: call[1] }
}

function enable(home: string, enabled: boolean): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-edit-recovery-hint': { enabled } }))
}

function editExec(oldString: string): ToolExecution {
  return { name: 'edit', arguments: { old_string: oldString } } as unknown as ToolExecution
}

function result(text: string, isError = true): ToolExecutionResult {
  return { content: [{ type: 'text', text }], isError } as unknown as ToolExecutionResult
}

const NOT_FOUND = 'The file /proj/a.ts has not been read yet. old_string was not found in it.'
const MULTI = 'line one\nline two'
const nextAccept = (content = NOT_FOUND) => async () =>
  // Realistic: the downstream decision content mirrors the tool result text
  // (a failed edit's not-found message), so the anchor is visible there.
  ({ kind: 'accept', content: [{ type: 'text', text: content }] }) as unknown as PostToolDecision
const nextBare = () => async () => ({ kind: 'accept' }) as unknown as PostToolDecision

describe('listener trigger permutations', () => {
  it('fires on edit + error + multi-line + not-found + enabled; appends hint as additionalContexts', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const decision = await listener(editExec(MULTI), result(NOT_FOUND), nextAccept())
    expect(decision.kind).toBe('accept')
    expect('value' in decision && decision.value !== undefined).toBe(false)
    const contexts = (decision as { additionalContexts?: { content: { type: 'text'; text: string }[] }[] }).additionalContexts
    expect(contexts).toHaveLength(1)
    expect(contexts![0]!.content).toEqual([{ type: 'text', text: RECOVERY_HINT }])
  })

  it('bare accept falls back to result.content for the anchor and still fires', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const decision = await listener(editExec(MULTI), result(NOT_FOUND), nextBare())
    const contexts = (decision as { additionalContexts?: unknown[] }).additionalContexts
    expect(contexts).toHaveLength(1)
  })

  it('enabled=false (flag flip via raw reader) → passthrough', async () => {
    const home = tempHome()
    enable(home, false)
    const { listener } = rig({ home })
    const downstream = await listener(editExec(MULTI), result(NOT_FOUND), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('non-edit tool → passthrough (Write has no old_string, so it can never match)', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const downstream = await listener({ ...editExec(MULTI), name: 'write' } as unknown as ToolExecution, result(NOT_FOUND), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('non-error result → passthrough', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const downstream = await listener(editExec(MULTI), result('ok', false), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('value-accept downstream → passthrough (runtime throws on content+value)', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const next = async () => ({ kind: 'accept', value: { x: 1 } }) as unknown as PostToolDecision
    const downstream = await listener(editExec(MULTI), result(NOT_FOUND), next)
    expect(downstream).toEqual({ kind: 'accept', value: { x: 1 } })
  })

  it('decision with existing additionalContexts → appended, not replaced', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const existing = { role: 'user', content: [{ type: 'text', text: 'earlier' }] } as unknown as PostToolDecision
    const next = async () => ({
      kind: 'accept',
      content: [{ type: 'text', text: NOT_FOUND }],
      additionalContexts: [existing],
    }) as unknown as PostToolDecision
    const decision = await listener(editExec(MULTI), result(NOT_FOUND), next)
    const contexts = (decision as { additionalContexts?: unknown[] }).additionalContexts
    expect(contexts).toHaveLength(2)
    expect(contexts![0]).toBe(existing)
    expect((contexts![1] as { content: { text: string }[] }).content[0]!.text).toBe(RECOVERY_HINT)
    expect((decision as { content: unknown[] }).content).toHaveLength(1) // content untouched
  })

  it('not-found text absent (single-line old_string) → passthrough', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const downstream = await listener(editExec('only line'), result(NOT_FOUND), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('settings.json absent → inert passthrough (fail-soft)', async () => {
    const home = tempHome()
    const { listener } = rig({ home })
    const downstream = await listener(editExec(MULTI), result(NOT_FOUND), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('malformed settings.json → inert passthrough (fail-soft)', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'settings.json'), '{not json')
    const { listener } = rig({ home })
    const downstream = await listener(editExec(MULTI), result(NOT_FOUND), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('no dshHome available → inert', async () => {
    const { listener } = rig({ dshHomeThrows: true })
    const downstream = await listener(editExec(MULTI), result(NOT_FOUND), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: NOT_FOUND }] })
  })

  it('a throwing next() still surfaces (the seam never swallows upstream errors)', async () => {
    const home = tempHome()
    enable(home, true)
    const { listener } = rig({ home })
    const next = async () => {
      throw new Error('upstream boom')
    }
    await expect(listener(editExec(MULTI), result(NOT_FOUND), next)).rejects.toThrow('upstream boom')
  })
})
