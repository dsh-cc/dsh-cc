/**
 * The discovery judgment cache (design
 * `docs/plans/2026-11-02-systemone-05-tool-discovery.md` § "Lifecycle, cache,
 * and failure handling"; protocol verified in
 * `specs/tla/decision-gate-coalescing`): bounded LRU with lazy TTL expiry,
 * same-key coalescing, independent per-caller cancellation, the underlying
 * request aborted only when the last waiter leaves, a completed run cached
 * before waiters wake, and a cancelled run never cached.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DiscoveryCache,
  buildDiscoveryCacheKey,
} from '../src/discovery-cache.ts'
import type { DiscoveryCacheKeyParts } from '../src/discovery-cache.ts'

/** A manually advanced clock, so TTL behaviour needs no fake timers. */
function clock(start = 0) {
  let time = start
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
  }
}

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Key parts where every field is fixed unless the test overrides it. */
function keyParts(overrides: Partial<DiscoveryCacheKeyParts> = {}): DiscoveryCacheKeyParts {
  return {
    project: 'proj',
    session: 'sess',
    agent: 'agent',
    originSeq: 7,
    query: 'which sources does this article draw on',
    catalogHash: 'sha256:catalog',
    admissionHash: 'sha256:scope',
    route: {
      provider: 'gw',
      model: 'gauge-model',
      revision: 'rev-1',
      perRequestTokens: 4096,
      perQuestionTokens: 512,
      maxQuestions: 8,
      maxOutputTokens: 256,
    },
    questionVersion: 'tool-discovery-v1',
    policyVersion: 'tool-discovery-policy-v1',
    thresholds: {
      timeoutMs: 1200,
      maxInputTokens: 4096,
      maxCandidates: 64,
      batchSize: 8,
      maxQueryChars: 2048,
      maxMetadataChars: 2048,
      minRelevanceIndex: 3,
      minDirectFit: 0.75,
      maxActivations: 3,
    },
    ...overrides,
  }
}

describe('cache key', () => {
  it('is stable for identical parts and different for every invalidation input', () => {
    const base = buildDiscoveryCacheKey(keyParts())
    expect(buildDiscoveryCacheKey(keyParts())).toBe(base)
    // The query is normalized (trimmed) before it enters the key.
    expect(buildDiscoveryCacheKey(keyParts({ query: `  ${keyParts().query}  ` }))).toBe(base)

    const variants: Array<Partial<DiscoveryCacheKeyParts>> = [
      { project: 'proj2' },
      { session: 'sess2' },
      { agent: 'agent2' },
      { originSeq: 8 },
      { query: 'what else' },
      { catalogHash: 'sha256:catalog2' },
      { admissionHash: 'sha256:scope2' },
      { questionVersion: 'tool-discovery-v2' },
      { policyVersion: 'tool-discovery-policy-v2' },
      { route: { ...keyParts().route, provider: 'gw2' } },
      { route: { ...keyParts().route, model: 'other-model' } },
      { route: { ...keyParts().route, revision: 'rev-2' } },
      { route: { ...keyParts().route, perRequestTokens: 2048 } },
      { route: { ...keyParts().route, perQuestionTokens: 256 } },
      { route: { ...keyParts().route, maxQuestions: 4 } },
      { route: { ...keyParts().route, maxOutputTokens: 128 } },
      { thresholds: { ...keyParts().thresholds, timeoutMs: 900 } },
      { thresholds: { ...keyParts().thresholds, maxInputTokens: 2048 } },
      { thresholds: { ...keyParts().thresholds, maxCandidates: 32 } },
      { thresholds: { ...keyParts().thresholds, batchSize: 4 } },
      { thresholds: { ...keyParts().thresholds, maxQueryChars: 512 } },
      { thresholds: { ...keyParts().thresholds, maxMetadataChars: 512 } },
      { thresholds: { ...keyParts().thresholds, minRelevanceIndex: 2 } },
      { thresholds: { ...keyParts().thresholds, minDirectFit: 0.5 } },
      { thresholds: { ...keyParts().thresholds, maxActivations: 2 } },
    ]
    const keys = new Set([base, ...variants.map(variant => buildDiscoveryCacheKey(keyParts(variant)))])
    expect(keys.size).toBe(variants.length + 1)
  })

  it('a changed key runs the factory again instead of reusing the judgment', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 8, ttlMs: 60_000 })
    const factory = vi.fn(async () => 'selected')
    await cache.run(buildDiscoveryCacheKey(keyParts()), factory)
    await cache.run(buildDiscoveryCacheKey(keyParts()), factory)
    expect(factory).toHaveBeenCalledTimes(1)

    // Provider/model change: the design discards the earlier judgment.
    await cache.run(buildDiscoveryCacheKey(keyParts({ route: { ...keyParts().route, model: 'other-model' } })), factory)
    // Catalog change: candidate set moved.
    await cache.run(buildDiscoveryCacheKey(keyParts({ catalogHash: 'sha256:catalog2' })), factory)
    // Admission change: permission scope moved.
    await cache.run(buildDiscoveryCacheKey(keyParts({ admissionHash: 'sha256:scope2' })), factory)
    // Threshold change: a limit change alters the key.
    await cache.run(
      buildDiscoveryCacheKey(keyParts({ thresholds: { ...keyParts().thresholds, minDirectFit: 0.6 } })),
      factory,
    )
    expect(factory).toHaveBeenCalledTimes(5)
  })
})

describe('LRU and TTL', () => {
  it('evicts the least recently used entry, and a read refreshes recency', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 2, ttlMs: 60_000 })
    const makes: Record<string, number> = {}
    for (const key of ['a', 'b', 'c']) {
      makes[key] = 0
    }
    const factoryFor = (key: string) => async () => {
      makes[key] = (makes[key] ?? 0) + 1
      return `${key}-value`
    }

    await cache.run('a', factoryFor('a'))
    await cache.run('b', factoryFor('b'))
    // Promote `a`; `b` is now the least recently used entry.
    expect(await cache.run('a', factoryFor('a'))).toEqual({ status: 'ok', value: 'a-value' })
    await cache.run('c', factoryFor('c'))
    expect(cache.size).toBe(2)

    await cache.run('a', factoryFor('a'))
    await cache.run('c', factoryFor('c'))
    expect(makes).toEqual({ a: 1, b: 1, c: 1 })

    // `b` was evicted, so it is recomputed.
    expect(await cache.run('b', factoryFor('b'))).toEqual({ status: 'ok', value: 'b-value' })
    expect(makes.b).toBe(2)
  })

  it('treats a TTL-expired entry as absent', async () => {
    const clockUnderTest = clock()
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 1000, now: clockUnderTest.now })
    const factory = vi.fn(async () => 'value')

    await cache.run('k', factory)
    clockUnderTest.advance(999)
    await cache.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(1)

    clockUnderTest.advance(1)
    await cache.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(2)
    // The expired entry was dropped, not left to accumulate.
    expect(cache.size).toBe(1)
  })

  it('a ttl of zero makes no entry reusable while still coalescing', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 0 })
    const factory = vi.fn(async () => 'value')
    await cache.run('k', factory)
    await cache.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('cache-entries 0 disables storage but keeps coalescing', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 0, ttlMs: 60_000 })
    const factory = vi.fn(async () => 'value')
    await cache.run('k', factory)
    await cache.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)

    const gate = deferred<string>()
    const shared = vi.fn(() => gate.promise)
    const first = cache.run('k0', shared)
    const second = cache.run('k0', shared)
    gate.resolve('shared')
    expect(await first).toEqual({ status: 'ok', value: 'shared' })
    expect(await second).toEqual({ status: 'ok', value: 'shared' })
    expect(shared).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
  })
})

describe('same-key coalescing and independent cancellation', () => {
  it('two concurrent callers share one factory invocation and both get the value', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    const gate = deferred<string>()
    const factory = vi.fn(() => gate.promise)

    const first = cache.run('k', factory)
    const second = cache.run('k', factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(cache.pending).toBe(1)

    // A completed run is cached BEFORE the waiters are woken.
    gate.resolve('judged')
    expect(await first).toEqual({ status: 'ok', value: 'judged' })
    expect(await second).toEqual({ status: 'ok', value: 'judged' })
    expect(cache.size).toBe(1)
    expect(cache.pending).toBe(0)

    // Reused before the TTL: no second factory invocation.
    expect(await cache.run('k', factory)).toEqual({ status: 'ok', value: 'judged' })
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('one waiter aborting cancels only that waiter; the shared run continues', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    const gate = deferred<string>()
    let underlyingSignal: AbortSignal | undefined
    const factory = vi.fn((signal: AbortSignal) => {
      underlyingSignal = signal
      return gate.promise
    })

    const leaving = new AbortController()
    const staying = new AbortController()
    const cancelled = cache.run('k', factory, leaving.signal)
    const kept = cache.run('k', factory, staying.signal)
    expect(factory).toHaveBeenCalledTimes(1)

    leaving.abort()
    expect(await cancelled).toEqual({ status: 'cancelled' })
    // The underlying request is NOT aborted while another waiter remains.
    expect(underlyingSignal?.aborted).toBe(false)
    expect(cache.pending).toBe(1)

    gate.resolve('judged')
    expect(await kept).toEqual({ status: 'ok', value: 'judged' })
    // The cancelled caller activated nothing, but the judgment is still cached
    // for later transactions.
    expect(cache.size).toBe(1)
  })

  it('the last waiter aborting aborts the underlying request and caches nothing', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    let underlyingSignal: AbortSignal | undefined
    // A real factory observes the abort and rejects with an abort error; the
    // cache must swallow that rejection (nobody is waiting) and store nothing.
    const factory = vi.fn((signal: AbortSignal) => {
      underlyingSignal = signal
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })

    const caller = new AbortController()
    const pending = cache.run('k', factory, caller.signal)
    caller.abort()
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(underlyingSignal?.aborted).toBe(true)
    expect(cache.pending).toBe(0)
    expect(cache.size).toBe(0)

    // A cancelled run is never cached: the next caller runs the factory again.
    const retry = vi.fn(async () => 'judged')
    expect(await cache.run('k', retry)).toEqual({ status: 'ok', value: 'judged' })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('cancelling every waiter after the fact caches nothing even if the run resolves', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    const gate = deferred<string>()
    const factory = vi.fn(() => gate.promise)
    const caller = new AbortController()
    const pending = cache.run('k', factory, caller.signal)

    caller.abort()
    expect(await pending).toEqual({ status: 'cancelled' })
    gate.resolve('late')
    await Promise.resolve()
    expect(cache.size).toBe(0)
  })

  it('an already-aborted caller never starts the factory', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    const factory = vi.fn(async () => 'value')
    const caller = new AbortController()
    caller.abort()
    expect(await cache.run('k', factory, caller.signal)).toEqual({ status: 'cancelled' })
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('only complete, validated judgments are stored', () => {
  type Judgment =
    | { readonly kind: 'selected'; readonly names: string[] }
    | { readonly kind: 'lexical'; readonly reason: string }
    | { readonly kind: 'cancelled' }

  it('caches a selected judgment and recomputes behind a lexical fallback', async () => {
    const cache = new DiscoveryCache<Judgment>({ maxEntries: 4, ttlMs: 60_000 })
    const selected = vi.fn(async (): Promise<Judgment> => ({ kind: 'selected', names: ['paper_references'] }))
    expect(await cache.run('selected', selected)).toEqual({
      status: 'ok',
      value: { kind: 'selected', names: ['paper_references'] },
    })
    await cache.run('selected', selected)
    expect(selected).toHaveBeenCalledTimes(1)

    // A lexical fallback is a per-transaction outcome, never reused.
    const lexical = vi.fn(async (): Promise<Judgment> => ({ kind: 'lexical', reason: 'bounds' }))
    await cache.run('lexical', lexical)
    await cache.run('lexical', lexical)
    expect(lexical).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(1)

    // Nor is a cancelled judgment.
    const cancelled = vi.fn(async (): Promise<Judgment> => ({ kind: 'cancelled' }))
    await cache.run('cancelled', cancelled)
    await cache.run('cancelled', cancelled)
    expect(cancelled).toHaveBeenCalledTimes(2)
  })

  it('recomputes behind a failed run and propagates the failure to every waiter', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    const gate = deferred<string>()
    const factory = vi.fn(() => gate.promise)

    const first = cache.run('k', factory)
    const second = cache.run('k', factory)
    const settled = Promise.allSettled([first, second])
    gate.reject(new Error('timeout'))
    const outcomes = await settled
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(cache.size).toBe(0)
    expect(cache.pending).toBe(0)

    const retry = vi.fn(async () => 'judged')
    expect(await cache.run('k', retry)).toEqual({ status: 'ok', value: 'judged' })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('a factory that throws synchronously fails the run instead of leaking it', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    const factory = vi.fn(() => {
      throw new Error('no runner')
    })
    await expect(cache.run('k', factory)).rejects.toThrow('no runner')
    expect(cache.pending).toBe(0)
    expect(cache.size).toBe(0)
  })
})

describe('plugin unload', () => {
  it('clear() drops entries and cancels every in-flight request', async () => {
    const cache = new DiscoveryCache<string>({ maxEntries: 4, ttlMs: 60_000 })
    await cache.run('warm', async () => 'stored')
    expect(cache.size).toBe(1)

    let underlyingSignal: AbortSignal | undefined
    const factory = vi.fn((signal: AbortSignal) => {
      underlyingSignal = signal
      return new Promise<string>(() => {})
    })
    const pending = cache.run('cold', factory)
    expect(cache.pending).toBe(1)

    cache.clear()
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(underlyingSignal?.aborted).toBe(true)
    expect(cache.size).toBe(0)
    expect(cache.pending).toBe(0)
  })
})
