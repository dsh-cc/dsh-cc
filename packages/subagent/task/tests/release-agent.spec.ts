/**
 * Tests for the shared release operation and the `release_agent` tool
 * (plan docs/plans/2026-09-30-subagent-release-valve.md §6). Every §5 variant
 * is `toEqual`-pinned (full string), never substring. The 10 s drain timeout
 * is paid with REAL timers exactly once (the T13b primary); the T13b
 * late-continuation sub-variants re-run the timeout under fake timers.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@dsh-cc/tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DRAIN_OBSERVE_TIMEOUT_MS,
  ReleaseFailure,
  isReleased,
  isReleasing,
  markReleased,
  renderReleaseOutcome,
  resetReleasedMarkers,
  runRelease,
  type ReleaseRegistryLike,
  type ReleaseSubagentsLike,
} from '@dsh-cc/command-agents/release'
import { RELEASE_AGENT_TOOL, registerReleaseAgentTool } from '../src/release-agent.ts'

function renderCopy(outcome: Awaited<ReturnType<typeof runRelease>>): string {
  return renderReleaseOutcome(outcome)
}

// --- §5 copy literals (verbatim contracts) ---------------------------------

const COPY = {
  unknownId: (id: string) =>
    `No agent ${id} among this session's continuable children; use list_agents or /agents for current ids.`,
  notContinuable: (id: string, mode: string) =>
    `Agent ${id} is not a continuable child (mode: ${mode}); release only covers continuable children.`,
  noDrainSeam: (id: string) =>
    `Cannot release ${id}: this composition's subagents seam exposes no drainContinuableChildren; free capacity by letting children settle or by restarting the session.`,
  catalogUnreadable: (id: string, cause: string) =>
    `Cannot verify ${id} against this session's child catalog (${cause}); refusing to release blind. Retry, or restart the session if listing stays broken.`,
  notDirectChild: (id: string) =>
    `Agent ${id} is not a direct child of this session (the drain seam refused with UNAUTHORIZED); release its direct parent instead — if that parent is one of this session's children. Releasing a parent evicts its whole resident subtree.`,
  staleParent: () =>
    `This session's agent handle is stale (the drain seam refused with UNAUTHORIZED against the parent identity); retry the release, or restart the turn if it persists.`,
  releasedRunning: (id: string) =>
    `Released agent ${id}: its in-flight turn was aborted and its resident activation evicted — the capacity slot it held is free. Its resident descendants (if any) were evicted with it. The persisted session survives on disk. Within this session it cannot be continued (send_message resolves but runs no turn — upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`,
  releasedIdle: (id: string) =>
    `Released agent ${id}: its resident (idle) activation was evicted; it held no capacity slot (only running children count toward the 25-child guard). Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`,
  releasedUnknown: (id: string) =>
    `Released agent ${id}: its resident activation was evicted; any capacity slot it held is free (its running state could not be observed). Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`,
  registryOnlyPrepend: (id: string) =>
    `(Note: ${id} was absent from the readable child catalog — released via the live registry only.) `,
  catalogUnreadablePrepend: (cause: string) =>
    `(Note: the child catalog was unreadable (${cause}) — released via the live registry only.) `,
  issuedUnobservable: (id: string) =>
    `Release of agent ${id} was issued against the authoritative drain seam; this composition cannot observe the registry, so residency after the drain could not be confirmed and the child is NOT marked released. Eviction, when it applies, also covers resident descendants. If it was resident, the drain evicts it by the seam's own contract; its continuation state here is unknown.`,
  evictedDegraded: (id: string, failure: string) =>
    `Release of agent ${id} reported a teardown failure (${failure}), but the activation entry is removed before that failure surfaces per the seam's disposal order — any capacity slot is free. Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued; /agents marks it [released] for the rest of this process.`,
  notResident: (id: string) =>
    `Agent ${id} has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.`,
  notResidentEarlier: (id: string) =>
    `Agent ${id} was released earlier in this process and has no resident activation; nothing was evicted.`,
  stillResidentSettled: (id: string) =>
    `Release of agent ${id} was issued, but the registry still reports it resident after the drain; check /agents detail ${id} and retry if it persists.`,
  stillResidentPending: (id: string) =>
    `Release of agent ${id} is in flight: its turn did not reach idle within 10s (a cancel-resistant turn). The release still completes by itself if the turn ever becomes idle — /agents then marks it [released] — but nothing locally force-evicts a cancel-resistant turn; a process restart is the only hard boundary.`,
}

// --- fixture ----------------------------------------------------------------

const PARENT_ID = 'parent-1'
const CHILD_ID = 'child-abc'

function mkErr(message: string, code?: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string }
  if (code !== undefined) error.code = code
  return error
}

interface DrainControl {
  drain: (parent: unknown, ids: unknown[]) => Promise<void>
  calls: { parent: unknown; ids: unknown[]; releasingAtCall: boolean }[]
  resolveDrain: () => void
  rejectDrain: (error: unknown) => void
}

/** A recorded, externally-resolvable drainContinuableChildren stub. */
function makeDrain(): DrainControl {
  const calls: DrainControl['calls'] = []
  let resolveDrain!: () => void
  let rejectDrain!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolveDrain = resolve
    rejectDrain = reject
  })
  const drain = (parent: unknown, ids: unknown[]): Promise<void> => {
    calls.push({ parent, ids, releasingAtCall: isReleasing(String((ids as string[])[0])) })
    return promise
  }
  return { drain, calls, resolveDrain, rejectDrain }
}

interface RegistryControl {
  registry: ReleaseRegistryLike | undefined
  drop: (id: string) => void
  breakGets: () => void
}

function makeRegistry(initial: Record<string, { status?: string }> = {}): RegistryControl {
  const rows = new Map(Object.entries(initial))
  let broken = false
  return {
    registry: {
      get: (id: string) => {
        if (broken) throw new Error('registry exploded')
        return rows.get(id)
      },
    },
    drop: id => { rows.delete(id) },
    breakGets: () => { broken = true },
  }
}

/** The continuable catalog row every drain-path test uses. */
function catalogRow(mode = 'continuable'): { id: string; mode?: string } {
  return { id: CHILD_ID, mode }
}

function parentAgent(overrides: Record<string, unknown> = {}): Agent {
  return { id: PARENT_ID, session: { id: PARENT_ID }, ...overrides } as unknown as Agent
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  resetReleasedMarkers()
})

describe('runRelease gate errors (no marking, no drain)', () => {
  it('T1: clean catalog miss + registry miss → unknown-id, no drain', async () => {
    const d = makeDrain()
    const reg = makeRegistry()
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [],
      drainContinuableChildren: d.drain as never,
    }
    await expect(runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry }))
      .rejects.toEqual(new ReleaseFailure('unknown-id', COPY.unknownId(CHILD_ID)))
    expect(d.calls).toHaveLength(0)
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T2: mode one-shot → not-continuable with the mode interpolated; T2b absent mode → the literal unknown', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow('one-shot')],
      drainContinuableChildren: d.drain as never,
    }
    await expect(runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry }))
      .rejects.toEqual(new ReleaseFailure('not-continuable', COPY.notContinuable(CHILD_ID, 'one-shot')))
    const subagentsNoMode: ReleaseSubagentsLike = {
      listChildren: async () => [{ id: CHILD_ID }],
      drainContinuableChildren: d.drain as never,
    }
    await expect(runRelease({ parent: parentAgent(), id: CHILD_ID, subagents: subagentsNoMode, agents: reg.registry }))
      .rejects.toEqual(new ReleaseFailure('not-continuable', COPY.notContinuable(CHILD_ID, 'unknown')))
    expect(d.calls).toHaveLength(0)
  })

  it('T3: catalog hit continuable + registry miss → not-resident, no drain', async () => {
    const d = makeDrain()
    const reg = makeRegistry()
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const outcome = await runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    expect(outcome).toEqual({ kind: 'not-resident', id: CHILD_ID, releasedEarlier: false })
    expect(renderCopy(outcome)).toEqual(COPY.notResident(CHILD_ID))
    expect(d.calls).toHaveLength(0)
  })

  it('T3b: releasedEarlier full text; a repeat release after released → same', async () => {
    const d = makeDrain()
    const reg = makeRegistry()
    markReleased(CHILD_ID)
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const outcome = await runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    expect(outcome).toEqual({ kind: 'not-resident', id: CHILD_ID, releasedEarlier: true })
    expect(renderCopy(outcome)).toEqual(COPY.notResidentEarlier(CHILD_ID))
    // The pre-existing mark persists (grok r6 #5).
    expect(isReleased(CHILD_ID)).toBe(true)
    const outcome2 = await runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    expect(outcome2).toEqual({ kind: 'not-resident', id: CHILD_ID, releasedEarlier: true })
  })

  it('T11: no drain seam → no-drain-seam', async () => {
    const reg = makeRegistry()
    const subagents: ReleaseSubagentsLike = { listChildren: async () => [catalogRow()] }
    await expect(runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry }))
      .rejects.toEqual(new ReleaseFailure('no-drain-seam', COPY.noDrainSeam(CHILD_ID)))
  })

  it('T10c: listChildren method absent + registry miss → catalog-unreadable with the exposes-no-listChildren cause, no drain', async () => {
    const d = makeDrain()
    const reg = makeRegistry()
    const subagents: ReleaseSubagentsLike = { drainContinuableChildren: d.drain as never }
    await expect(runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry }))
      .rejects.toEqual(new ReleaseFailure(
        'catalog-unreadable',
        COPY.catalogUnreadable(CHILD_ID, 'the subagents seam exposes no listChildren'),
      ))
    expect(d.calls).toHaveLength(0)
  })

  it('T10b: listing throws + registry miss → catalog-unreadable error, no drain', async () => {
    const d = makeDrain()
    const reg = makeRegistry()
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => { throw new Error('catalog io failed') },
      drainContinuableChildren: d.drain as never,
    }
    await expect(runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry }))
      .rejects.toEqual(new ReleaseFailure(
        'catalog-unreadable',
        COPY.catalogUnreadable(CHILD_ID, 'catalog io failed'),
      ))
    expect(d.calls).toHaveLength(0)
  })
})

/** Render via the shared renderer; the literal pins in the tests stay primary. */

describe('runRelease drain paths', () => {
  it('T5: catalog hit + running → released running-variant full text; drain args (exactParent, [SessionId(id)])', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const parent = parentAgent()
    const pending = runRelease({ parent, id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0]!.parent).toBe(parent)
    expect(d.calls[0]!.ids).toEqual([SessionId(CHILD_ID)])
    reg.drop(CHILD_ID) // the seam's own disposal drops the resident entry
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'released', id: CHILD_ID, preStatus: 'running', catalogNote: 'catalog' })
    expect(renderCopy(outcome)).toEqual(COPY.releasedRunning(CHILD_ID))
    expect(isReleased(CHILD_ID)).toBe(true)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T6: catalog hit + idle → released idle-variant full text (causation is positional per F4)', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'idle' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    reg.drop(CHILD_ID)
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'released', id: CHILD_ID, preStatus: 'idle', catalogNote: 'catalog' })
    expect(renderCopy(outcome)).toEqual(COPY.releasedIdle(CHILD_ID))
  })

  it('T6b: registry hit whose status is neither running nor idle → released unknown-preStatus variant', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'paused' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    reg.drop(CHILD_ID)
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'released', id: CHILD_ID, preStatus: 'unknown', catalogNote: 'catalog' })
    expect(renderCopy(outcome)).toEqual(COPY.releasedUnknown(CHILD_ID))
  })

  it('T4: clean catalog miss + registry hit → released with the registry-only prepend', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    reg.drop(CHILD_ID)
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'released', id: CHILD_ID, preStatus: 'running', catalogNote: 'registry-only' })
    expect(renderCopy(outcome)).toEqual(COPY.registryOnlyPrepend(CHILD_ID) + COPY.releasedRunning(CHILD_ID))
  })

  it('T4b: as T4 but the drain rejects not-direct → not-direct-child; markers cleared', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    d.rejectDrain(mkErr('subagent "x" is not a direct child of agent "p"'))
    await expect(pending).rejects.toEqual(new ReleaseFailure('not-direct-child', COPY.notDirectChild(CHILD_ID)))
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T7: ACTIVATION_TEARDOWN_FAILED + post absent → evicted-degraded full text, marked', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    reg.drop(CHILD_ID) // the seam deletes the resident entry BEFORE the failure surfaces (F4)
    d.rejectDrain(mkErr('teardown boom', 'ACTIVATION_TEARDOWN_FAILED'))
    const outcome = await pending
    expect(outcome).toEqual({
      kind: 'evicted-degraded', id: CHILD_ID, failure: 'teardown boom', catalogNote: 'catalog',
    })
    expect(renderCopy(outcome)).toEqual(COPY.evictedDegraded(CHILD_ID, 'teardown boom'))
    expect(isReleased(CHILD_ID)).toBe(true)
  })

  it('T7b: evicted-degraded carries the registry-only prepend; T7c post present → rethrow, cleared', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagentsMiss: ReleaseSubagentsLike = {
      listChildren: async () => [],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents: subagentsMiss, agents: reg.registry })
    await flush()
    reg.drop(CHILD_ID)
    d.rejectDrain(mkErr('teardown boom', 'ACTIVATION_TEARDOWN_FAILED'))
    const outcome = await pending
    expect(renderCopy(outcome)).toEqual(
      COPY.registryOnlyPrepend(CHILD_ID) + COPY.evictedDegraded(CHILD_ID, 'teardown boom'),
    )
    resetReleasedMarkers()

    const d3 = makeDrain()
    const reg2 = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagentsHit: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d3.drain as never,
    }
    const pending2 = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents: subagentsHit, agents: reg2.registry })
    await flush()
    const original = mkErr('teardown boom', 'ACTIVATION_TEARDOWN_FAILED')
    d3.rejectDrain(original)
    await expect(pending2).rejects.toBe(original)
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T10a: listing throws + registry hit → drain with the catalog-unreadable prepend', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => { throw new Error('catalog io failed') },
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    reg.drop(CHILD_ID)
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({
      kind: 'released', id: CHILD_ID, preStatus: 'running',
      catalogNote: 'catalog-unreadable', cause: 'catalog io failed',
    })
    expect(renderCopy(outcome)).toEqual(
      COPY.catalogUnreadablePrepend('catalog io failed') + COPY.releasedRunning(CHILD_ID),
    )
  })

  it('T8: reject unknown code → verbatim rethrow; cleared', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    const original = mkErr('some other refusal')
    d.rejectDrain(original)
    await expect(pending).rejects.toBe(original)
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T9: reject message-matched "exact live parent" → stale-parent; cleared', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    d.rejectDrain(mkErr('selected child teardown requires the exact live parent agent'))
    await expect(pending).rejects.toEqual(new ReleaseFailure('stale-parent', COPY.staleParent()))
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T15: the pre-issuance releasing mark is visible to a collect resolving DURING the drain; T15b: cleared after a not-direct-child failure', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    expect(d.calls[0]!.releasingAtCall).toBe(true)
    reg.drop(CHILD_ID)
    d.resolveDrain()
    await pending
    expect(isReleasing(CHILD_ID)).toBe(false)

    const d2 = makeDrain()
    resetReleasedMarkers() // part 1 marked the id released; T15b is a fresh attempt
    const reg2 = makeRegistry({ [CHILD_ID]: { status: 'running' } }) // the child is resident again
    const subagents2: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d2.drain as never,
    }
    const pending2 = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents: subagents2, agents: reg2.registry })
    await flush()
    d2.rejectDrain(mkErr('subagent "x" is not a direct child of agent "p"'))
    await expect(pending2).rejects.toBeInstanceOf(ReleaseFailure)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T15d: the join contract — drain resolves with the registry dropping the row, no end/cancel evidence, released (idle-variant) still renders in full', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'idle' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: (parent, ids) => {
        void d.drain(parent, ids)
        // The seam's own disposal drops the entry; no cancel/end signal of ours.
        reg.drop(CHILD_ID)
        return Promise.resolve()
      },
    }
    const outcome = await runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    expect(outcome).toEqual({ kind: 'released', id: CHILD_ID, preStatus: 'idle', catalogNote: 'catalog' })
    expect(renderCopy(outcome)).toEqual(COPY.releasedIdle(CHILD_ID))
  })

  it('T13c: pre-read HIT, drain resolves, post-read THROWS → released with the preStatus from the hit (full text)', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    d.resolveDrain()
    reg.breakGets()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'released', id: CHILD_ID, preStatus: 'running', catalogNote: 'catalog' })
    expect(renderCopy(outcome)).toEqual(COPY.releasedRunning(CHILD_ID))
    expect(isReleased(CHILD_ID)).toBe(true)
  })

  it('T14a: registry face absent + catalog hit, drain resolves → issued-unobservable full text, markers cleared', async () => {
    const d = makeDrain()
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: undefined })
    await flush()
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'issued-unobservable', id: CHILD_ID, catalogNote: 'catalog' })
    expect(renderCopy(outcome)).toEqual(COPY.issuedUnobservable(CHILD_ID))
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  })

  it('T14b: registry face absent + ACTIVATION_TEARDOWN_FAILED → evicted-degraded (marked)', async () => {
    const d = makeDrain()
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: undefined })
    await flush()
    d.rejectDrain(mkErr('teardown boom', 'ACTIVATION_TEARDOWN_FAILED'))
    const outcome = await pending
    expect(outcome).toEqual({
      kind: 'evicted-degraded', id: CHILD_ID, failure: 'teardown boom', catalogNote: 'catalog',
    })
    expect(isReleased(CHILD_ID)).toBe(true)
  })
})

describe('runRelease timing arms', () => {
  it('T13: resolved + still present past the poll budget → still-resident (drainPending false); cleared', async () => {
    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
    const subagents: ReleaseSubagentsLike = {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    }
    const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
    await flush()
    d.resolveDrain()
    const outcome = await pending
    expect(outcome).toEqual({ kind: 'still-resident', id: CHILD_ID, drainPending: false })
    expect(renderCopy(outcome)).toEqual(COPY.stillResidentSettled(CHILD_ID))
    expect(isReleased(CHILD_ID)).toBe(false)
    expect(isReleasing(CHILD_ID)).toBe(false)
  }, 5_000)

  it('T13b primary: drain never resolves within 10 s (real timers) → still-resident (drainPending true), the releasing mark STAYS; a late resolve to an absent registry flips it to released with no unhandled rejection', async () => {
    expect(DRAIN_OBSERVE_TIMEOUT_MS).toBe(10_000)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const d = makeDrain()
      const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
      const subagents: ReleaseSubagentsLike = {
        listChildren: async () => [catalogRow()],
        drainContinuableChildren: d.drain as never,
      }
      const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
      await flush()
      const outcome = await pending
      expect(outcome).toEqual({ kind: 'still-resident', id: CHILD_ID, drainPending: true })
      expect(renderCopy(outcome)).toEqual(COPY.stillResidentPending(CHILD_ID))
      expect(isReleasing(CHILD_ID)).toBe(true)
      expect(isReleased(CHILD_ID)).toBe(false)
      // Late completion: the registry drops the row, the drain resolves.
      reg.drop(CHILD_ID)
      d.resolveDrain()
      await flush()
      expect(isReleased(CHILD_ID)).toBe(true)
      expect(isReleasing(CHILD_ID)).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 15_000)

  describe('T13b late-continuation sub-variants (fake timers for the 10 s arm)', () => {
    afterEach(() => { vi.useRealTimers() })

    interface TimeoutFixture {
      pending: Promise<Awaited<ReturnType<typeof runRelease>>>
      d: DrainControl
      reg: RegistryControl
    }

    async function runToTimeout(): Promise<TimeoutFixture> {
      vi.useFakeTimers()
      const d = makeDrain()
      const reg = makeRegistry({ [CHILD_ID]: { status: 'running' } })
      const subagents: ReleaseSubagentsLike = {
        listChildren: async () => [catalogRow()],
        drainContinuableChildren: d.drain as never,
      }
      const pending = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents, agents: reg.registry })
      await flush()
      await vi.advanceTimersByTimeAsync(DRAIN_OBSERVE_TIMEOUT_MS)
      expect(await pending).toEqual({ kind: 'still-resident', id: CHILD_ID, drainPending: true })
      expect(isReleasing(CHILD_ID)).toBe(true)
      return { pending, d, reg }
    }

    it('(ii) late reject ACTIVATION_TEARDOWN_FAILED + guarded absent → markReleased + swallowed', async () => {
      const { d, reg } = await runToTimeout()
      reg.drop(CHILD_ID)
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      d.rejectDrain(mkErr('teardown boom', 'ACTIVATION_TEARDOWN_FAILED'))
      await flush()
      await vi.runAllTimersAsync()
      process.off('unhandledRejection', onUnhandled)
      expect(isReleased(CHILD_ID)).toBe(true)
      expect(unhandled).toEqual([])
    })

    it('(iii) late reject unknown code → clearReleasing + swallowed (no unhandled rejection)', async () => {
      const { d } = await runToTimeout()
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      d.rejectDrain(mkErr('unknown late failure'))
      await flush()
      await vi.runAllTimersAsync()
      process.off('unhandledRejection', onUnhandled)
      expect(isReleased(CHILD_ID)).toBe(false)
      expect(isReleasing(CHILD_ID)).toBe(false)
      expect(unhandled).toEqual([])
    })

    it('(iv) late resolve with the registry unobservable at that read → the releasing mark is KEPT', async () => {
      const { d, reg } = await runToTimeout()
      reg.breakGets()
      d.resolveDrain()
      await flush()
      await vi.runAllTimersAsync()
      expect(isReleasing(CHILD_ID)).toBe(true)
      expect(isReleased(CHILD_ID)).toBe(false)
    })

    it('(v) clobber-proofing: attempt 1 times out, attempt 2 completes released, attempt 1\'s drain then rejects → the tag survives', async () => {
      const first = await runToTimeout()
      // Attempt 2 completes released against the same id.
      const d2 = makeDrain()
      const reg2 = makeRegistry({ [CHILD_ID]: { status: 'running' } })
      const subagents2: ReleaseSubagentsLike = {
        listChildren: async () => [catalogRow()],
        drainContinuableChildren: d2.drain as never,
      }
      const pending2 = runRelease({ parent: parentAgent(), id: CHILD_ID, subagents: subagents2, agents: reg2.registry })
      await flush()
      reg2.drop(CHILD_ID)
      d2.resolveDrain()
      const outcome2 = await pending2
      expect(outcome2.kind).toBe('released')
      expect(isReleased(CHILD_ID)).toBe(true)
      // Attempt 1's stale drain then rejects late — it must NOT unmark.
      first.d.rejectDrain(mkErr('late stale failure'))
      await flush()
      await vi.runAllTimersAsync()
      expect(isReleased(CHILD_ID)).toBe(true)
      expect(isReleasing(CHILD_ID)).toBe(false)
    })

    it('(vi) late RESOLVE arms against the retry shape: absent → idempotent markReleased (tag stays); present → clearReleasing refused (tag stays); unobservable → KEEP is a pure no-op', async () => {
      // Absent after an already-released retry: markReleased is idempotent.
      {
        const { d, reg } = await runToTimeout()
        markReleased(CHILD_ID) // the concurrent retry already completed
        reg.drop(CHILD_ID)
        d.resolveDrain()
        await flush()
        await vi.runAllTimersAsync()
        expect(isReleased(CHILD_ID)).toBe(true)
        expect(isReleasing(CHILD_ID)).toBe(false)
        resetReleasedMarkers()
      }
      // Present after an already-released retry: clearReleasing is refused.
      {
        const { d, reg } = await runToTimeout()
        markReleased(CHILD_ID)
        d.resolveDrain() // registry still reports the row present
        await flush()
        await vi.runAllTimersAsync()
        expect(isReleased(CHILD_ID)).toBe(true)
        expect(isReleasing(CHILD_ID)).toBe(false)
        resetReleasedMarkers()
      }
      // Unobservable after an already-released retry: KEEP is a pure no-op —
      // never a re-insert into releasing after markReleased.
      {
        const { d, reg } = await runToTimeout()
        markReleased(CHILD_ID)
        reg.breakGets()
        d.resolveDrain()
        await flush()
        await vi.runAllTimersAsync()
        expect(isReleased(CHILD_ID)).toBe(true)
        expect(isReleasing(CHILD_ID)).toBe(false)
      }
    })

    it('(i) late resolve with the registry now absent → markReleased (tag on), no unhandled rejection', async () => {
      const { d, reg } = await runToTimeout()
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', onUnhandled)
      reg.drop(CHILD_ID)
      d.resolveDrain()
      await flush()
      await vi.runAllTimersAsync()
      process.off('unhandledRejection', onUnhandled)
      expect(isReleased(CHILD_ID)).toBe(true)
      expect(unhandled).toEqual([])
    })
  })
})

describe('release_agent tool surface', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
  })

  it('T12: exec.agent undefined → the guard error', async () => {
    registerReleaseAgentTool(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'call-t12' as never,
      name: RELEASE_AGENT_TOOL,
      arguments: { agent_id: CHILD_ID },
    })
    expect(result.isError).toBe(true)
    expect((result as { content: { text: string }[] }).content[0]!.text)
      .toContain('release_agent requires a calling agent (exec.agent was undefined)')
  })

  it('missing tools seam → undefined (F16); the description is the verbatim D2 contract; a release renders the outcome text', async () => {
    const bare = new Context()
    expect(registerReleaseAgentTool(bare)).toBeUndefined()

    const d = makeDrain()
    const reg = makeRegistry({ [CHILD_ID]: { status: 'idle' } })
    const agent = {
      id: PARENT_ID,
      session: { id: PARENT_ID },
      ctx: { get: (key: string) => key === 'agents' ? reg.registry : undefined },
    } as unknown as Agent
    registerReleaseAgentTool(ctx)
    ctx.provide('subagents', {
      listChildren: async () => [catalogRow()],
      drainContinuableChildren: d.drain as never,
    } satisfies ReleaseSubagentsLike)
    const def = ctx.tools.get(RELEASE_AGENT_TOOL) as { description: string }
    expect(def.description).toBe(
      'Release a direct continuable subagent: its resident activation is evicted, '
      + 'and with it the resident activations of any descendants (a running turn is '
      + 'aborted; no separate interrupt needed). Eviction is cooperative — a turn that '
      + 'refuses cancellation keeps its slot until it settles (this tool reports that '
      + 'as still-resident with the release still in flight instead of hanging). A '
      + 'slot toward the 25-child capacity guard is freed only when the agent was '
      + 'running; idle agents hold no slot but are still evicted (one-way); an '
      + 'already-settled agent is a harmless no-op. The persisted session survives on '
      + 'disk. Within THIS session a released agent cannot be continued: '
      + '`send_message` resolves but runs no turn (a known upstream '
      + 'cold-resume-after-drain gap); continuation from a future session is not '
      + 'currently verified. `list_agents` and `/agents` still list a released agent '
      + '(the durable catalog is retained); `/agents` marks it [released] for the '
      + 'rest of this process.',
    )
    const pending = ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'call-t14' as never,
      name: RELEASE_AGENT_TOOL,
      arguments: { agent_id: CHILD_ID },
      agent,
    })
    await flush()
    reg.drop(CHILD_ID)
    d.resolveDrain()
    const result = (await pending) as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toEqual(COPY.releasedIdle(CHILD_ID))
  })
})
