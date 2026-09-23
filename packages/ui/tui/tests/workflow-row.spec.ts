import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Events } from '@deepseek-ai/cordis'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowResultInfo, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { attachWorkflowRow, createWorkflowEventTap } from '@dsh-cc/tui/harness/workflow-row.ts'

/**
 * D2 progress-row suite. The contract block pins the five subscribed
 * `workflow/*` payload shapes against the @deepseek-ai/dsh-workflow event
 * declarations (compile-time, via cordis `Events` augmentation) — a harness
 * shape change breaks this test before it can silently break the row.
 */

const accent = (text: string) => text
const muted = (text: string) => text

const info = (id: string): WorkflowRunInfo => ({ id: WorkflowRunId(id), meta: { name: 'review', description: 'd' } })
const agentStart = (seq: number): WorkflowAgentInfo => ({ seq, label: `a${seq}`, childId: `c${seq}` as never })
const agentEnd = (seq: number): WorkflowAgentEndInfo => ({ ...agentStart(seq), outcome: 'completed' as never })
const result = (): WorkflowResultInfo => ({ stopReason: 'completed', agentsStarted: 2 })

/** Fake ctx: like the no-polling double, plus a workflow event registry. */
function makeCtx() {
  const workflowListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const listeners = new Set<(session: { id: string }, key: string, value: unknown, seq: number) => void>()
  const states: Record<string, Record<string, unknown>> = { 's-a': {} }
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return { defaultId: 'cc', resolve: async () => ({ id: 'cc' }), mount: async () => ({ id: 'cc' }) }
      }
      if (key === 'sessionProjections') {
        return {
          onChanged(listener: (session: { id: string }, key: string, value: unknown, seq: number) => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          stateOf(session: { id: string }, key: string) {
            return states[session.id]?.[key]
          },
        }
      }
      return undefined
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!event.startsWith('workflow/')) return () => {}
      let set = workflowListeners.get(event)
      if (set === undefined) workflowListeners.set(event, set = new Set())
      set.add(listener)
      return () => { set!.delete(listener) }
    },
    agents: {
      create: async () => ({
        agent: {
          options: {},
          session: { id: 's-a', header: {}, events: [], snapshotEvents() { return this.events } },
          id: 'a-1',
          status: 'idle',
          followup: vi.fn(),
          steer: vi.fn(),
          cancel: vi.fn(),
        },
        dispose: async () => {},
      }),
      resume: async () => { throw new Error('not needed') },
    },
  }
  const emitWorkflow = (event: string, ...args: unknown[]): void => {
    for (const listener of workflowListeners.get(event) ?? []) listener(...args)
  }
  return { ctx: ctx as unknown as Context, emitWorkflow }
}

describe('workflow/* contract (pinned to @deepseek-ai/dsh-workflow payloads)', () => {
  it('the five subscribed events match the declared cordis event signatures', () => {
    // Compile-time pin: each tuple must be assignable to the declared event args.
    const run = info('r1')
    const start: Parameters<Events['workflow/start']> = [run]
    const phase: Parameters<Events['workflow/phase']> = [run, 'Build']
    const start1: Parameters<Events['workflow/agent-start']> = [run, agentStart(1)]
    const end1: Parameters<Events['workflow/agent-end']> = [run, agentEnd(1)]
    const done: Parameters<Events['workflow/end']> = [run, result()]
    // The tap dispatches exactly these arg shapes; the row handler accepts them.
    const { ctx, emitWorkflow } = makeCtx()
    const tap = createWorkflowEventTap(ctx)
    const seen: Array<[string, WorkflowRunInfo, unknown]> = []
    tap.on((name, info, detail) => seen.push([name, info, detail]))
    emitWorkflow('workflow/start', ...start)
    emitWorkflow('workflow/phase', ...phase)
    emitWorkflow('workflow/agent-start', ...start1)
    emitWorkflow('workflow/agent-end', ...end1)
    emitWorkflow('workflow/end', ...done)
    expect(seen.map(([name]) => name)).toEqual(['workflow/start', 'workflow/phase', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'])
    expect(seen[1]![2]).toBe('Build')
    tap.dispose()
    emitWorkflow('workflow/start', ...start)
    expect(seen).toHaveLength(5)
  })

  it('workflow/log is NOT subscribed', () => {
    const { ctx, emitWorkflow } = makeCtx()
    const tap = createWorkflowEventTap(ctx)
    const seen: string[] = []
    tap.on((name) => seen.push(name))
    emitWorkflow('workflow/log', info('r1'), 'noise')
    expect(seen).toEqual([])
    tap.dispose()
  })
})

describe('workflow progress row', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const advance = (ms: number) => { vi.advanceTimersByTime(ms) }

  function makeRow(fake = makeCtx()) {
    const tap = createWorkflowEventTap(fake.ctx)
    const row = attachWorkflowRow({ workflowEvents: tap }, accent, muted, () => {})
    return { ...fake, tap, row }
  }

  it('event sequence drives row contents: phase transition, settle ratio, end clears', () => {
    const { emitWorkflow, tap, row } = makeRow()
    expect(row.line.render(120)).toEqual([])

    emitWorkflow('workflow/start', info('r1'))
    expect(row.line.render(120)).toHaveLength(1)
    expect(row.line.render(120)![0]).toContain('phase …')

    emitWorkflow('workflow/phase', info('r1'), 'Build')
    emitWorkflow('workflow/agent-start', info('r1'), agentStart(1))
    emitWorkflow('workflow/agent-start', info('r1'), agentStart(2))
    emitWorkflow('workflow/agent-end', info('r1'), agentEnd(1))
    advance(65_400)
    expect(row.line.render(120)![0]).toContain('running 1m 5s · phase Build · agents 1/2')

    emitWorkflow('workflow/end', info('r1'), result())
    expect(row.line.render(120)).toEqual([])
    tap.dispose()
  })

  it('two concurrent runs render the latest with the +N more suffix; end clears on last', () => {
    const { emitWorkflow, tap, row } = makeRow()
    emitWorkflow('workflow/start', info('r1'))
    emitWorkflow('workflow/phase', info('r1'), 'One')
    emitWorkflow('workflow/start', info('r2'))
    emitWorkflow('workflow/phase', info('r2'), 'Two')
    advance(80)
    const text = row.line.render(120)![0]!
    expect(text).toContain('phase Two')
    expect(text).toContain('+1 more')
    emitWorkflow('workflow/end', info('r2'), result())
    advance(80)
    expect(row.line.render(120)![0]).toContain('phase One')
    expect(row.line.render(120)![0]).not.toContain('+1 more')
    emitWorkflow('workflow/end', info('r1'), result())
    expect(row.line.render(120)).toEqual([])
    tap.dispose()
  })

  it('unknown run id (resume-mid-run) starts the row with elapsed from first observation', () => {
    const { emitWorkflow, tap, row } = makeRow()
    advance(500_000)
    emitWorkflow('workflow/phase', info('ghost'), 'Late')
    advance(10_000)
    const text = row.line.render(120)![0]!
    expect(text).toContain('phase Late')
    expect(text).toContain('running 10s')
    emitWorkflow('workflow/end', info('ghost'), result())
    expect(row.line.render(120)).toEqual([])
    tap.dispose()
  })

  it('malformed payloads never throw the listener', () => {
    const { emitWorkflow, tap, row } = makeRow()
    expect(() => {
      emitWorkflow('workflow/phase', undefined, 'x')
      emitWorkflow('workflow/phase', { id: 'r9' }, 'x')
      emitWorkflow('workflow/agent-start', info('r9'), undefined)
      emitWorkflow('workflow/end', undefined)
    }).not.toThrow()
    tap.dispose()
    row.dispose()
  })

  it('an event without a run id starts no row (no bogus untracked run)', () => {
    const { emitWorkflow, tap, row } = makeRow()
    emitWorkflow('workflow/start', undefined)
    emitWorkflow('workflow/phase', {} as never, 'x')
    advance(80)
    expect(row.line.render(120)).toEqual([])
    tap.dispose()
    row.dispose()
  })

  it('row stops (interval gone) after workflow/end, and row.dispose() stops a mid-run line', () => {
    const { emitWorkflow, tap, row } = makeRow()
    expect(vi.getTimerCount()).toBe(0)
    emitWorkflow('workflow/start', info('r1'))
    expect(vi.getTimerCount()).toBe(1)
    emitWorkflow('workflow/end', info('r1'), result())
    expect(vi.getTimerCount()).toBe(0)
    expect(row.line.render(120)).toEqual([])

    emitWorkflow('workflow/start', info('r2'))
    expect(vi.getTimerCount()).toBe(1)
    row.dispose()
    expect(vi.getTimerCount()).toBe(0)
    tap.dispose()
  })

  it('driver dispose mid-run stops the row and disposes the tap', async () => {
    const { ctx, emitWorkflow } = makeCtx()
    const driver = await createDriver(ctx, { cwd: '/w/proj', branchProbe: async () => undefined })
    const tap = driver.workflowEvents!
    const disposeSpy = vi.spyOn(tap, 'dispose')
    const row = attachWorkflowRow(driver, accent, muted, () => {})
    emitWorkflow('workflow/start', info('r1'))
    expect(row.line.render(120)).toHaveLength(1)
    await driver.dispose()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    row.dispose() // the root-destroy teardown path
    expect(row.line.render(120)).toEqual([])
  })
})
