/**
 * F-2 (continuation admission at rc.5): the harness residency pool is the
 * ONLY capacity valve — for cold-resumed continuations as for spawns — so
 * the dsh-cc running-count guard was deleted. What these tests pin is what
 * remains: the refusal literal (kept byte-shared with the spawn lane), and
 * the per-parent admission lease the `tools/execute` wiring holds across
 * `send_message` acceptance.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIVE_CAPACITY_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN,
  admitContinuation,
  applyResumePinsPlugin,
} from '../src/index.ts'

const parent = { id: 'parent-1' }

describe('live-capacity constants (rc.5)', () => {
  it('keeps the refusal literal on residency semantics and the shared cap', () => {
    expect(MAX_LIVE_CONTINUABLE_CHILDREN).toBe(25)
    expect(LIVE_CAPACITY_REFUSAL).toContain('25 resident subagents')
    expect(LIVE_CAPACITY_REFUSAL).toContain('cold-resumed')
    expect(LIVE_CAPACITY_REFUSAL).toContain('already-resident')
    expect(LIVE_CAPACITY_REFUSAL).toContain('release_agent')
  })
})

describe('admitContinuation (lease-only at rc.5)', () => {
  it('admits a cold-resume target and a resident target identically (the pool decides capacity)', async () => {
    const services = { get: () => undefined }
    const signal = new AbortController().signal
    const cold = await admitContinuation(services, { id: 'parent-1', session: { header: {} } }, 'settled-child', signal)
    expect(cold.admitted).toBe(true)
    cold.release()
    const resident = await admitContinuation(services, { id: 'parent-1', session: { header: {} } }, 'running-child', signal)
    expect(resident.admitted).toBe(true)
    resident.release()
  })

  it('exempts child-to-parent reports from the lease', async () => {
    const services = { get: () => undefined }
    const admission = await admitContinuation(
      services,
      { id: 'child-x', session: { header: { parentSession: 'parent-target' } } },
      'parent-target',
      new AbortController().signal,
    )
    expect(admission.admitted).toBe(true)
    admission.release()
  })

  it('serializes continuations per parent (a second admission queues behind the first)', async () => {
    const services = { get: () => undefined }
    const first = await admitContinuation(services, { id: 'parent-1', session: { header: {} } }, 'a', new AbortController().signal)
    let secondAdmitted = false
    const queued = admitContinuation(services, { id: 'parent-1', session: { header: {} } }, 'b', new AbortController().signal)
      .then((admission) => {
        secondAdmitted = admission.admitted
        admission.release()
        return admission.admitted
      })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(secondAdmitted).toBe(false)
    first.release()
    await expect(queued).resolves.toBe(true)
    expect(secondAdmitted).toBe(true)
  })
})

// ── Gate wiring (tools/execute) ────────────────────────────────────────

describe('send_message admission wiring', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-cc-live-capacity-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function fakeGate() {
    const handlers: Array<(exec: unknown, next: () => Promise<string>) => Promise<unknown>> = []
    const ctx = {
      provide: () => {},
      get: () => undefined,
      on: (name: string, handler: never) => {
        if (name === 'tools/execute') handlers.push(handler)
        return () => {}
      },
      effect: () => {},
      logger: { warn: () => {} },
    }
    applyResumePinsPlugin(ctx as never, { pinsRoot: root })
    return handlers[0]! as (exec: unknown, next: () => Promise<string>) => Promise<unknown>
  }

  function sendMessage(callId: string, agent: unknown = { id: 'parent-1', session: { header: {} } }) {
    return { name: 'send_message', arguments: { agent_id: callId }, agent, signal: new AbortController().signal }
  }

  it('admits a continuation and releases the admission after the body settles', async () => {
    const gate = fakeGate()
    const next = vi.fn(async () => 'next-called')
    await expect(gate(sendMessage('settled-child'), next)).resolves.toBe('next-called')
    expect(next).toHaveBeenCalledOnce()
    // Admission released: a follow-up does not queue behind the settled first.
    const next2 = vi.fn(async () => 'next-again')
    await expect(gate(sendMessage('settled-child'), next2)).resolves.toBe('next-again')
  })

  it('passes non-send_message executions straight through without admission', async () => {
    const gate = fakeGate()
    const next = vi.fn(async () => 'passed')
    await expect(
      gate({ name: 'read', arguments: {}, agent: { id: 'parent-1' }, signal: new AbortController().signal }, next),
    ).resolves.toBe('passed')
  })
})
