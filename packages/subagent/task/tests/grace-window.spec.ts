/**
 * R8 grace-window auto-release + R9 two-tier delta
 * (docs/plans/2026-10-04-ephemeral-read-only-subagents.md §3.8/§3.9): the
 * arm-registry/timer module, entry-point stamping, promotion re-tier
 * (both interleavings), tombstone algebra, the send_message gate, arm-time
 * copy, resume precedence, and timer hygiene.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { tombstoneReadyRow, clearTombstone, isTombstoned, resetReleasedMarkers, runRelease } from '@dsh-cc/command-agents/release'
import { PinStore, applyResumePinsPlugin } from '@dsh-cc/subagent-resume-pins'
import {
  BACKGROUND_AUTO_RELEASE_MS,
  FOREGROUND_AUTO_RELEASE_MS,
  armGraceFromPin,
  armGraceWindow,
  cancelPendingGrace,
  graceEntryOf,
  graceWindowClause,
  graceWindowFromPin,
  isGraceRecorded,
  mountGraceWindow,
  pendingGraceTimers,
  promoteGraceTier,
  recordGraceEntry,
  resetGraceWindow,
  resolveGraceWindowMs,
} from '../src/grace-window.ts'
import { collectFirstEpoch } from '../src/epoch-collector.ts'
import { collectForeground, startBackground, type SubagentsLike } from '../src/background-start.ts'
import { outcomeToResult } from '../src/collect-copy.ts'
import { mountGraceSettledNotice } from '../src/grace-settled-notice.ts'

/** A fake cordis bus recording listener registrations and disposal. */
class FakeBus {
  private readonly listeners = new Map<string, ((info: Record<string, unknown>) => void)[]>()

  on(event: string, fn: (info: Record<string, unknown>) => void): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(fn)
    this.listeners.set(event, list)
    return () => {
      const current = this.listeners.get(event) ?? []
      const index = current.indexOf(fn)
      if (index >= 0) current.splice(index, 1)
    }
  }

  emit(event: string, info: Record<string, unknown>): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(info)
  }
}

/** Minimal test deps: spies for the tombstone ops, a scripted agents registry. */
function makeDeps(overrides: Partial<Parameters<typeof mountGraceWindow>[1]> = {}) {
  const tombstoned: string[] = []
  const cleared: string[] = []
  const warnings: string[] = []
  const deps = {
    agents: { get: (id: string) => (overrides as { agents?: { get(id: string): { status?: string } } }).agents?.get(id) },
    tombstone: (id: string) => {
      tombstoneReadyRow(id)
      tombstoned.push(id)
    },
    clearTombstone: (id: string) => {
      clearTombstone(id)
      cleared.push(id)
    },
    warn: (message: string) => {
      warnings.push(message)
    },
  }
  return { deps, tombstoned, cleared, warnings }
}

function mount(bus: FakeBus, deps: ReturnType<typeof makeDeps>['deps']): void {
  mountGraceWindow(bus as never, deps)
}

function emitEnd(bus: FakeBus, childId: string, runId = 'r1'): void {
  bus.emit('subagent/end', { runId, provider: 'spawn', id: childId, local: true, stopReason: 'completed' })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetGraceWindow()
  resetReleasedMarkers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Membership + idempotent arm ────────────────────────────────────────────

describe('arm-registry membership', () => {
  it('a non-registry id never arms (coordinator children are structurally excluded)', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    emitEnd(bus, 'coordinator-child')
    expect(pendingGraceTimers()).toBe(0)
    await vi.advanceTimersByTimeAsync(BACKGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toHaveLength(0)
    expect(isGraceRecorded('coordinator-child')).toBe(false)
  })

  it('arms on end for a recorded id and fires exactly once', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'p1', tier: 'foreground' })
    emitEnd(bus, 'c1')
    emitEnd(bus, 'c1', 'r2') // second end replaces the pending timer
    expect(pendingGraceTimers()).toBe(1)
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toEqual(['c1'])
    expect(pendingGraceTimers()).toBe(0)
  })

  it('an end WITHOUT a pending timer before any arm is the normal first arm', () => {
    const bus = new FakeBus()
    const { deps } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c2', parentId: 'p1', tier: 'background' })
    bus.emit('subagent/start', { runId: 'r0', id: 'c2' }) // start-without-pending-timer: no-op
    expect(pendingGraceTimers()).toBe(0)
  })
})

// ── Tier resolution matrix ─────────────────────────────────────────────────

describe('tier resolution (R9)', () => {
  it('foreground stamps the 30-minute default, background 2 hours', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'fg', parentId: 'p', tier: 'foreground' })
    recordGraceEntry({ childId: 'bg', parentId: 'p', tier: 'background' })
    emitEnd(bus, 'fg')
    emitEnd(bus, 'bg')
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toEqual(['fg'])
    await vi.advanceTimersByTimeAsync(BACKGROUND_AUTO_RELEASE_MS)
    expect(tombstoned).toEqual(['fg', 'bg'])
  })

  it('a definition override wins over both defaults; 0 disables (never armed)', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'ov', parentId: 'p', tier: 'foreground', overrideMs: 60_000 })
    recordGraceEntry({ childId: 'off', parentId: 'p', tier: 'background', overrideMs: 0 })
    emitEnd(bus, 'ov')
    emitEnd(bus, 'off')
    expect(pendingGraceTimers()).toBe(1) // 0 is never armed
    await vi.advanceTimersByTimeAsync(60_001)
    expect(tombstoned).toEqual(['ov'])
    expect(resolveGraceWindowMs(graceEntryOf('off')!)).toBe(0)
  })
})

// ── Fire semantics ─────────────────────────────────────────────────────────

describe('fire', () => {
  it('re-checks the registry: a live-again child skips the tombstone and re-arms', async () => {
    const bus = new FakeBus()
    let status: string | undefined = 'running'
    const { deps, tombstoned } = makeDeps()
    deps.agents = { get: () => (status === undefined ? undefined : { status }) }
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'foreground' })
    emitEnd(bus, 'c1')
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toHaveLength(0) // skip
    expect(pendingGraceTimers()).toBe(1) // re-armed
    status = undefined
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toEqual(['c1']) // fires once the child is not live
  })

  it('tomnstones a ready row and sets the marker; the marker clears on subagent/start', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned, cleared } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'background' })
    emitEnd(bus, 'c1')
    await vi.advanceTimersByTimeAsync(BACKGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toEqual(['c1'])
    expect(isTombstoned('c1')).toBe(true)
    // The residual: an in-flight send_message lands after the fire — one
    // extra epoch, tombstone cleared, window re-arms.
    bus.emit('subagent/start', { runId: 'r2', id: 'c1' })
    expect(isTombstoned('c1')).toBe(false)
    expect(cleared).toEqual(['c1'])
    emitEnd(bus, 'c1', 'r2')
    expect(pendingGraceTimers()).toBe(1)
  })

  it('a fire-callback failure is logged and does NOT rethrow (fail-open toward retention)', async () => {
    const bus = new FakeBus()
    const { deps, warnings } = makeDeps()
    deps.tombstone = () => {
      throw new Error('boom')
    }
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'foreground' })
    emitEnd(bus, 'c1')
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(warnings.some(message => message.includes('c1'))).toBe(true)
  })

  it('every grace timer is unref()d', () => {
    const bus = new FakeBus()
    const { deps } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'foreground' })
    const unref = vi.fn()
    const stub = vi.fn((_fn: unknown, _ms?: number) => ({ unref, hasRef: () => false }) as never)
    const original = globalThis.setTimeout
    vi.stubGlobal('setTimeout', stub)
    try {
      armGraceWindow('c1')
      expect(unref).toHaveBeenCalled()
    } finally {
      vi.stubGlobal('setTimeout', original)
    }
  })
})

// ── subagent/start semantics ───────────────────────────────────────────────

describe('subagent/start', () => {
  it('cancels the pending timer and clears the tombstone; a second end re-arms fresh', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'foreground' })
    emitEnd(bus, 'c1')
    bus.emit('subagent/start', { runId: 'r2', id: 'c1' })
    expect(pendingGraceTimers()).toBe(0)
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toHaveLength(0)
  })
})

// ── Entry-point stamping ───────────────────────────────────────────────────

const fakeAgent = { id: 'parent-1' } as unknown as Agent

function continuableSeam(childId: string): SubagentsLike {
  return {
    start: async () => ({ result: Promise.resolve({ stopReason: 'completed' }) }),
    startContinuable: async () => ({ childId, messageId: 'm1' }),
    getProvider: () => ({ prepareContinuable() {} }),
    list: () => [],
  } as unknown as SubagentsLike
}

const freshSignal = (): AbortSignal => new AbortController().signal

describe('entry-point stamping', () => {
  it('collectForeground stamps foreground and records BEFORE the start await (end during pending start arms 30m)', async () => {
    const bus = new FakeBus()
    const { deps } = makeDeps()
    mount(bus, deps)
    let releaseStart: (() => void) | undefined
    const seam = {
      ...continuableSeam('c1'),
      startContinuable: () => new Promise<{ childId: string; messageId: string }>(resolve => {
        releaseStart = () => resolve({ childId: 'c1', messageId: 'm1' })
      }),
    } as unknown as SubagentsLike
    const exec = { agent: fakeAgent, signal: freshSignal(), token: 't1' }
    const ctx = bus as never
    const done = collectForeground(ctx, seam, {
      label: 'l',
      prompt: [{ type: 'text', text: 'p' }],
      parent: fakeAgent,
      signal: freshSignal(),
      childId: 'c1',
    }, undefined, exec)
    // Drain microtasks until startContinuable is actually invoked (the await
    // chain through assertLiveCapacity delays it past the call).
    for (let i = 0; i < 50 && releaseStart === undefined; i++) await Promise.resolve()
    // The child settles INSIDE the pending startContinuable await (interleaving).
    bus.emit('subagent/start', { runId: 'r1', id: 'c1' })
    emitEnd(bus, 'c1', 'r1')
    releaseStart!()
    await done
    const entry = graceEntryOf('c1')
    expect(entry?.tier).toBe('foreground')
    expect(pendingGraceTimers()).toBe(1)
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(isTombstoned('c1')).toBe(true)
  })

  it('startBackground stamps background (preallocated id recorded before the await)', async () => {
    const bus = new FakeBus()
    const { deps } = makeDeps()
    mount(bus, deps)
    const seam = continuableSeam('c1')
    const done = startBackground(seam, {
      label: 'l',
      prompt: [{ type: 'text', text: 'p' }],
      parent: fakeAgent,
      signal: freshSignal(),
      childId: 'c1',
      autoReleaseMs: undefined,
    }, undefined)
    for (let i = 0; i < 50 && !isGraceRecorded('c1'); i++) await Promise.resolve()
    expect(isGraceRecorded('c1')).toBe(true)
    const result = await done
    expect(result.agentId).toBe('c1')
    expect(graceEntryOf('c1')?.tier).toBe('background')
  })

  it('the override is recorded with pins disabled (capture-independent, definition override only)', async () => {
    const bus = new FakeBus()
    const { deps } = makeDeps()
    mount(bus, deps)
    await startBackground(continuableSeam('c1'), {
      label: 'l',
      prompt: [{ type: 'text', text: 'p' }],
      parent: fakeAgent,
      signal: freshSignal(),
      childId: 'c1',
      autoReleaseMs: 7200000,
    }, undefined)
    expect(graceEntryOf('c1')?.overrideMs).toBe(7200000)
    expect(graceEntryOf('c1')?.tier).toBe('background')
  })

  it('a 0 override is recorded verbatim (identity check, never truthiness)', () => {
    recordGraceEntry({ childId: 'c0', parentId: 'p', tier: 'foreground', overrideMs: 0 })
    expect(graceEntryOf('c0')?.overrideMs).toBe(0)
    expect(resolveGraceWindowMs(graceEntryOf('c0')!)).toBe(0)
  })
})

// ── Promotion re-tier (R9) — both interleavings ────────────────────────────

describe('promotion re-tier', () => {
  it('(a) promote() during the pending start → the later end arms the BACKGROUND window directly', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'parent-1', tier: 'foreground' })
    let hookRan = false
    const collect = collectFirstEpoch({
      bus: bus as never,
      childId: 'c1',
      agent: fakeAgent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'tok',
      onPromoted: () => {
        hookRan = true
        promoteGraceTier('c1')
      },
      start: async () => {},
    })
    await vi.advanceTimersByTimeAsync(0)
    bus.emit('subagent/start', { runId: 'r1', id: 'c1' })
    const armed = (await import('../src/epoch-collector.ts')).collectorFor('parent-1\u0000tok')
    armed?.promote()
    const outcome = await collect as { kind: string }
    expect(outcome.kind).toBe('promoted')
    expect(hookRan).toBe(true)
    expect(graceEntryOf('c1')?.tier).toBe('background')
    emitEnd(bus, 'c1', 'r1')
    expect(pendingGraceTimers()).toBe(1)
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toHaveLength(0) // NOT the 30m window
    await vi.advanceTimersByTimeAsync(BACKGROUND_AUTO_RELEASE_MS - FOREGROUND_AUTO_RELEASE_MS)
    expect(tombstoned).toEqual(['c1'])
  })

  it('(b) end inside the pending start (foreground timer armed) → promote() → cancel-and-replace with the background window', async () => {
    const bus = new FakeBus()
    const { deps, tombstoned } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'parent-1', tier: 'foreground' })
    // startContinuable stays PENDING across the end + promote (the exact
    // interleaving: `settled` flips only in finish() after start() completes).
    let releaseStart: (() => void) | undefined
    const collect = collectFirstEpoch({
      bus: bus as never,
      childId: 'c1',
      agent: fakeAgent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'tok',
      onPromoted: () => {
        promoteGraceTier('c1')
      },
      start: () => new Promise<void>(resolve => {
        releaseStart = resolve
      }),
    })
    for (let i = 0; i < 50 && releaseStart === undefined; i++) await Promise.resolve()
    bus.emit('subagent/start', { runId: 'r1', id: 'c1' })
    emitEnd(bus, 'c1', 'r1') // end inside the pending start: 30m armed
    expect(pendingGraceTimers()).toBe(1)
    const armed = (await import('../src/epoch-collector.ts')).collectorFor('parent-1\u0000tok')
    armed?.promote() // cancel-and-replace → 2h
    releaseStart!()
    await expect(collect).resolves.toMatchObject({ kind: 'promoted' })
    expect(pendingGraceTimers()).toBe(1)
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(tombstoned).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(BACKGROUND_AUTO_RELEASE_MS - FOREGROUND_AUTO_RELEASE_MS)
    expect(tombstoned).toEqual(['c1'])
  })

  it('a FINISHED collect can no longer promote (settled flips only in finish() after the pending start completes)', async () => {
    const bus = new FakeBus()
    const { deps } = makeDeps()
    mount(bus, deps)
    recordGraceEntry({ childId: 'c1', parentId: 'parent-1', tier: 'foreground' })
    let hookCalls = 0
    const { collectorFor: cf } = await import('../src/epoch-collector.ts')
    const collect = collectFirstEpoch({
      bus: bus as never,
      childId: 'c1',
      agent: fakeAgent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'tok',
      onPromoted: () => {
        hookCalls++
      },
      start: async () => {},
    })
    await vi.advanceTimersByTimeAsync(0)
    bus.emit('subagent/start', { runId: 'r1', id: 'c1' })
    emitEnd(bus, 'c1', 'r1')
    const outcome = await collect as { kind: string }
    expect(outcome.kind).toBe('epoch')
    // The registration is unregistered on finish — nothing promotable remains.
    expect(cf('parent-1\u0000tok')).toBeUndefined()
    expect(hookCalls).toBe(0)
  })
})

// ── Copy ───────────────────────────────────────────────────────────────────

describe('arm-time copy (absolute expiry)', () => {
  it('the completed foreground result carries the 30m + expires clause', () => {
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'foreground' })
    armGraceWindow('c1')
    const result = outcomeToResult('c1', { kind: 'epoch', stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }, undefined)
    expect(result.text).toContain('(auto-released after 30 minutes of inactivity, expires ')
  })

  it('the background tier renders 2 hours; the override renders its own window', () => {
    recordGraceEntry({ childId: 'bg', parentId: 'p', tier: 'background' })
    armGraceWindow('bg')
    expect(graceWindowClause('bg')).toContain('auto-released after 2 hours of inactivity, expires ')
    recordGraceEntry({ childId: 'ov', parentId: 'p', tier: 'foreground', overrideMs: 45 * 60_000 })
    armGraceWindow('ov')
    expect(graceWindowClause('ov')).toContain('auto-released after 45 minutes of inactivity')
  })

  it('a 0 override renders "auto-release disabled"', () => {
    recordGraceEntry({ childId: 'off', parentId: 'p', tier: 'foreground', overrideMs: 0 })
    expect(graceWindowClause('off')).toBe(' (auto-release disabled)')
  })

  it('a non-recorded child renders no clause', () => {
    expect(graceWindowClause('nobody')).toBe('')
  })

  it('the error path appends the clause (non-completed terminals throw through stopReasonMessage)', () => {
    recordGraceEntry({ childId: 'c1', parentId: 'p', tier: 'foreground' })
    armGraceWindow('c1')
    expect(() => outcomeToResult('c1', { kind: 'epoch', stopReason: 'error' }, undefined))
      .toThrow(/auto-released after 30 minutes of inactivity, expires /)
  })

  it('the released-child error copy carries NO clause', () => {
    recordGraceEntry({ childId: 'c2', parentId: 'p', tier: 'foreground' })
    tombstoneReadyRow('c2') // not released — use the released marker instead
    resetReleasedMarkers()
    expect(() => outcomeToResult('c2', { kind: 'epoch', stopReason: 'error' }, undefined))
      .toThrow(/auto-released after/)
  })

  it('the settled wake (Ctrl+B / background) is rewritten dsh-cc-side with the clause', async () => {
    recordGraceEntry({ childId: 'c9', parentId: 'p', tier: 'background' })
    armGraceWindow('c9')
    let handler: ((env: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const off = mountGraceSettledNotice({
      on: (_name: string, h: never) => {
        handler = h as never
        return () => {}
      },
    } as never)
    off()
    const settledMessage = {
      role: 'user',
      id: 'm1',
      source: { kind: 'subagent-settled', senderSessionId: 'c9' },
      content: [{ type: 'text', text: 'child settled' }],
    }
    const decision = await handler!({}, async () => ({ kind: 'enter', messages: [settledMessage] }))
    const messages = (decision as { messages: { content: { type: string; text: string }[] }[] }).messages
    const appended = messages[0]!.content.at(-1)!
    expect(appended.type).toBe('text')
    expect(appended.text).toContain('auto-released after 2 hours of inactivity, expires ')
  })
})

// ── Resume precedence + arming ─────────────────────────────────────────────

describe('resume window precedence', () => {
  it('pin.autoReleaseMs wins, then dispatchTier foreground → 30m, else 2h (legacy → 2h)', () => {
    expect(graceWindowFromPin({})).toBe(BACKGROUND_AUTO_RELEASE_MS)
    expect(graceWindowFromPin({ dispatchTier: 'foreground' })).toBe(FOREGROUND_AUTO_RELEASE_MS)
    expect(graceWindowFromPin({ dispatchTier: 'background' })).toBe(BACKGROUND_AUTO_RELEASE_MS)
    expect(graceWindowFromPin({ dispatchTier: 'foreground', autoReleaseMs: 600_000 })).toBe(600_000)
    expect(graceWindowFromPin({ autoReleaseMs: 0 })).toBe(0)
  })

  it('armGraceFromPin records the tier and arms; a 0 override records but never arms', async () => {
    armGraceFromPin({ childId: 'r1', parentSessionId: 'p', dispatchTier: 'foreground' })
    expect(graceEntryOf('r1')?.tier).toBe('foreground')
    expect(pendingGraceTimers()).toBe(1)
    armGraceFromPin({ childId: 'off', parentSessionId: 'p', autoReleaseMs: 0 })
    expect(isGraceRecorded('off')).toBe(true)
    expect(pendingGraceTimers()).toBe(1) // unchanged
    await vi.advanceTimersByTimeAsync(FOREGROUND_AUTO_RELEASE_MS + 1)
    expect(isTombstoned('off')).toBe(false)
  })

  it('an unreadable pin is left alone (corrupt → no entry, no timer)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-grace-pins-'))
    try {
      const store = new PinStore(root)
      const id = '11111111-2222-4333-8444-555566667777'
      const { writeFileSync } = await import('node:fs')
      writeFileSync(store.pathFor(id), '{broken')
      const pin = store.read(id)
      expect(pin).toMatchObject({ kind: 'corrupt' })
      // The resume loop skips 'kind' in pin — armGraceFromPin is never called.
      expect(isGraceRecorded(id)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Release module: manual release regression pins ─────────────────────────

describe('release tombstone algebra', () => {
  function releaseDeps(status?: string) {
    const agents = { get: (_id: string) => (status === undefined ? undefined : { status }) }
    const subagents = {
      listChildren: async () => [{ id: 'c1', mode: 'continuable' }],
      drainContinuableChildren: async () => {},
    }
    return { subagents, agents }
  }

  it('T18b: manual release on a naturally settled child stays not-resident (no releasedEarlier)', async () => {
    const { subagents, agents } = releaseDeps()
    const outcome = await runRelease({
      parent: fakeAgent,
      id: 'c1',
      subagents,
      agents,
    })
    expect(outcome).toMatchObject({ kind: 'not-resident', releasedEarlier: false })
  })

  it('manual release on a tombstoned child renders not-resident with releasedEarlier: true', async () => {
    const { subagents, agents } = releaseDeps()
    tombstoneReadyRow('c1')
    const outcome = await runRelease({
      parent: fakeAgent,
      id: 'c1',
      subagents,
      agents,
    })
    expect(outcome).toMatchObject({ kind: 'not-resident', releasedEarlier: true })
  })
})

// ── send_message gate ──────────────────────────────────────────────────────

describe('send_message tombstone gate', () => {
  function fakeCtx(markers: { isTombstoned: (id: string) => boolean } | undefined) {
    const preExecute: { handler: (exec: unknown, next: () => unknown) => unknown }[] = []
    const ctx = {
      provide: () => {},
      get: (key: string) => (key === 'ccReleaseMarkers' ? markers : undefined),
      on: (_name: string, handler: never) => {
        preExecute.push({ handler })
        return () => {}
      },
      effect: () => {},
      logger: { warn: () => {} },
    }
    return { ctx, preExecute }
  }

  it('denies a tombstoned id BEFORE pin admission (next() never runs)', async () => {
    tombstoneReadyRow('t1')
    const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
    try {
      const { ctx, preExecute } = fakeCtx({ isTombstoned: id => isTombstoned(id) })
      applyResumePinsPlugin(ctx as never, { pinsRoot: root })
      const gate = preExecute[0]!.handler as (exec: unknown, next: () => Promise<string>) => Promise<{ kind: string; reason: string }>
      const next = vi.fn(async () => 'next-called')
      const decision = await gate({ name: 'send_message', arguments: { agent_id: 't1' } }, next)
      expect(decision.kind).toBe('deny')
      expect(decision.reason).toContain('auto-released after inactivity')
      expect(next).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes through for a non-tombstoned, unpinned id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
    try {
      const { ctx, preExecute } = fakeCtx({ isTombstoned: () => false })
      applyResumePinsPlugin(ctx as never, { pinsRoot: root })
      const gate = preExecute[0]!.handler as (exec: unknown, next: () => Promise<string>) => Promise<unknown>
      const next = vi.fn(async () => 'next-called')
      await expect(gate({ name: 'send_message', arguments: { agent_id: 'live' } }, next)).resolves.toBe('next-called')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Executor frontmatter pin ───────────────────────────────────────────────

describe('executor exemption frontmatter', () => {
  it('dsh-cc-agents:executor pins autoReleaseMs: 7200000 (the documented mitigation recipe)', () => {
    const text = readFileSync(
      new URL('../../../plugin/dsh-cc-agents/agents/executor.md', import.meta.url),
      'utf8',
    )
    expect(text).toContain('autoReleaseMs: 7200000')
  })
})
