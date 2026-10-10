/**
 * Lineage + horizon pins (plan docs/plans/2026-10-09-runtime-verified-
 * completion.md §5.13): duck-typed fake sessions pin the lift happy path,
 * the depth-≥2 receipt-silent-intermediate corner, and the degraded-horizon
 * (no witnessed child ⇒ no nudge) decision function. Turn-stopping
 * integration lives in the next slice.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  DELEGATION_TOOL_IDS,
  LineageRegistry,
  countGenuineUserMessages,
  horizonDegraded,
  walkRoot,
  type SessionLike,
} from '../src/lineage.ts'
import { buildReceipt } from '../src/receipts.ts'

function fakeSession(id: string, parentSession?: string, events: unknown[] = []): SessionLike {
  return {
    id,
    header: { id, parentSession },
    snapshotEvents: () => events,
  } as unknown as SessionLike
}

describe('genuine user counting (shared procedure §3.2)', () => {
  it('counts user/message with absent or user-kind source only', () => {
    const events = [
      { type: 'user/message', data: { content: [] } }, // genuine (source absent)
      { type: 'user/message', data: { source: { kind: 'user' }, content: [] } }, // genuine
      { type: 'user/message', data: { source: { kind: 'completion-gate' }, content: [] } }, // nudge, NOT genuine
      { type: 'user/message', data: { source: { kind: 'plugin' }, content: [] } }, // checkpoint, NOT
      { type: 'assistant/message', data: { content: [] } },
    ]
    expect(countGenuineUserMessages(events)).toBe(2)
  })
})

describe('lineage lift (§5.13)', () => {
  it('child bash receipt lifts to the parent bucket with root ordinal', () => {
    const parentEvents = [
      { type: 'user/message', data: { content: [] } },
      { type: 'assistant/message', data: { content: [] } },
      { type: 'user/message', data: { content: [] } },
    ]
    const parent = fakeSession('root', undefined, parentEvents)
    const child = fakeSession('child-1', 'root')
    const registry = new LineageRegistry()
    registry.witness(parent)
    const receipt = buildReceipt(
      {
        callId: 'call_1',
        name: 'bash',
        arguments: { command: 'pnpm test' },
        agent: { session: child },
      } as never,
      { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
      { headEnabled: true },
    )
    registry.record(child, receipt)
    const lifts = registry.liftsFor('root')
    expect(lifts).toHaveLength(1)
    expect(lifts[0]).toMatchObject({ tool: 'bash', head: 'pnpm test', stampedOrdinal: 2 })
  })

  it('own-session receipts never lift', () => {
    const root = fakeSession('root')
    const registry = new LineageRegistry()
    const receipt = { sessionId: 'root', tool: 'bash' }
    registry.record(root, receipt)
    expect(registry.liftsFor('root')).toHaveLength(0)
  })

  it('depth-≥2 receipt-silent intermediate is never learned (documented corner §4)', () => {
    // grandchild's parent chain passes through an intermediate that ran no
    // tools — its parent link is never learned, so walkRoot stalls there.
    const registry = new LineageRegistry()
    const grandchild = fakeSession('gc', 'mid')
    const receipt = { sessionId: 'gc', tool: 'bash' }
    registry.record(grandchild, receipt)
    // 'mid' has no parent link: root = 'mid' ≠ 'gc' ⇒ lifts to 'mid' bucket.
    expect(registry.liftsFor('root')).toHaveLength(0)
    expect(registry.liftsFor('mid')).toHaveLength(1)
  })

  it('walkRoot is depth-bounded and cycle-guarded', () => {
    const parents = new Map([['a', 'b'], ['b', 'a']])
    expect(walkRoot('a', parents)).toBe('b') // cycle guard stops re-entry
    const deep: [string, string][] = []
    for (let i = 0; i < 12; i++) deep.push([`s${i}`, `s${i + 1}`])
    const map = new Map(deep)
    expect(walkRoot('s0', map)).toBe('s8') // 8 hops max
  })
})

describe('degraded horizon (§5.13 / §3.4)', () => {
  it('delegation receipts with zero witnessed children ⇒ degraded (skip nudge)', () => {
    expect(horizonDegraded([{ tool: 'subagent_fork' }], 0)).toBe(true)
    expect(horizonDegraded([{ tool: 'workflow' }], 0)).toBe(true)
  })
  it('any witnessed child opens the horizon', () => {
    expect(horizonDegraded([{ tool: 'ralph' }], 1)).toBe(false)
  })
  it('plain tool receipts never degrade', () => {
    expect(horizonDegraded([{ tool: 'bash' }], 0)).toBe(false)
  })
  it('delegation id set is pinned (§5.13)', () => {
    expect([...DELEGATION_TOOL_IDS].sort()).toEqual(['ralph', 'subagent_fork', 'workflow'])
  })
})
