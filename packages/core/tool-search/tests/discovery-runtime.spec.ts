/**
 * S1-05 discovery runtime at its own boundary: `createDiscoveryRuntime` driven
 * by a fake runner and an in-memory cache, without the cordis registry.
 *
 * These pin the outcomes the tool-facing integration spec cannot observe
 * directly — the shadow counters, the cancellation verdict, and the mapping of
 * every runner refusal onto a whole lexical fallback
 * (`docs/plans/2026-11-02-systemone-05-tool-discovery.md` § "Lifecycle, cache,
 * and failure handling").
 */

import { describe, expect, it } from 'vitest'
import { DiscoveryCache } from '../src/discovery-cache.ts'
import { createDiscoveryRuntime } from '../src/discovery-runtime.ts'
import type { DiscoveryDecisionRequest, DiscoveryDecisionRun, DiscoveryFallbackReason, DiscoveryRunner } from '../src/discovery-runtime.ts'
import { DEFAULT_DISCOVERY_SETTINGS } from '../src/discovery-settings.ts'
import type { DeferredEntry, DiscoveryRouteIdentity, DiscoverySettings } from '../src/discovery.ts'
import type { DiscoveryScope } from '../src/discovery-contract.ts'

/** The design's § "Settings" table, with the mode under test. */
function settings(overrides: Partial<DiscoverySettings> = {}): DiscoverySettings {
  return { ...DEFAULT_DISCOVERY_SETTINGS, mode: 'active', ...overrides }
}

/** A deliberately wide route: nothing is window-limited here. */
const WIDE_ROUTE: DiscoveryRouteIdentity = {
  provider: 'gw',
  model: 'gauge-model',
  revision: 'rev-1',
  perRequestTokens: 100_000,
  perQuestionTokens: 10_000,
  maxQuestions: 64,
  maxOutputTokens: 512,
}

const SCOPE: DiscoveryScope = { projectKey: 'proj', sessionId: 'sess', agentId: 'agent', originSeq: 1 }

/** One pool entry as the registry snapshots it. */
function entry(name: string): DeferredEntry {
  return { name, description: `${name} capability.`, alwaysLoad: false, activated: false, admitted: true, lexicalScore: 0 }
}

/** A scripted stand-in for S1-02's `BoundDecisionRunner`. */
class FakeRunner implements DiscoveryRunner {
  readonly requests: DiscoveryDecisionRequest[] = []

  /** Answers one request; mutated per test. */
  answer: (request: DiscoveryDecisionRequest) => DiscoveryDecisionRun = request => ({
    status: 'answered',
    answers: answerAll(request),
    decisionId: `d${this.requests.length}`,
  })

  /** Optional per-request hook, run before the answer resolves. */
  beforeAnswer: () => Promise<void> | void = () => {}

  identifyRoute(): DiscoveryRouteIdentity {
    return WIDE_ROUTE
  }

  scope(): DiscoveryScope {
    return SCOPE
  }

  async run(request: DiscoveryDecisionRequest): Promise<DiscoveryDecisionRun> {
    this.requests.push(request)
    await this.beforeAnswer()
    return this.answer(request)
  }
}

/** Every candidate relevant at 4/.9. */
function answerAll(request: DiscoveryDecisionRequest) {
  const state = request.state as { candidates: Array<{ id: string }> }
  const answers: Record<string, unknown> = {}
  for (const candidate of state.candidates) {
    answers[`${candidate.id}_relevance`] = { type: 'score', probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 } }
    answers[`${candidate.id}_direct`] = { type: 'noul', noul: 0.9 }
  }
  return answers as never
}

/** A runtime over fixed entries, with a fresh in-memory cache. */
function runtime(options: {
  mode: 'off' | 'shadow' | 'active'
  runner: FakeRunner
  entries?: readonly DeferredEntry[]
  settings?: Partial<DiscoverySettings>
}) {
  return createDiscoveryRuntime({
    readSettings: () => settings({ mode: options.mode, ...options.settings }),
    snapshotEntries: () => options.entries ?? [entry('capability_a'), entry('capability_b')],
    resolveRunner: () => options.runner,
    cache: new DiscoveryCache({ maxEntries: 16, ttlMs: 60_000 }),
  })
}

describe('the discovery runtime on its own', () => {
  it('tallies shadow differences in memory without persisting names', async () => {
    const runner = new FakeRunner()
    const discovery = runtime({ mode: 'shadow', runner })
    const evaluation = await discovery.evaluate({ query: 'capability', maxResults: 3, actor: {}, lexicalNames: ['capability_a'] })
    expect(evaluation).toEqual({ kind: 'lexical', reason: 'shadow' })
    // Counts only: the suggested set was {a, b}, the lexical set {a}.
    expect(discovery.shadow()).toEqual({ judgments: 1, differing: 1, suggestedOnly: 1, lexicalOnly: 0 })
  })

  it('returns cancelled (and activates nothing) when the caller signal aborts mid-flight', async () => {
    const runner = new FakeRunner()
    const controller = new AbortController()
    runner.beforeAnswer = () => controller.abort()
    const discovery = runtime({ mode: 'active', runner, entries: [entry('capability_a')] })
    const evaluation = await discovery.evaluate({
      query: 'capability',
      maxResults: 3,
      actor: {},
      lexicalNames: [],
      signal: controller.signal,
    })
    expect(evaluation).toEqual({ kind: 'cancelled' })
  })

  it('falls back as a whole for every unavailable runner reason', async () => {
    for (const reason of ['budget', 'unconfigured', 'timeout', 'error', 'malformed'] as const) {
      const runner = new FakeRunner()
      runner.answer = () => ({ status: 'unavailable', reason, decisionId: 'd1' })
      const evaluation = await runtime({ mode: 'active', runner })
        .evaluate({ query: 'capability', maxResults: 3, actor: {}, lexicalNames: [] })
      expect(evaluation).toEqual({ kind: 'lexical', reason: 'unavailable' satisfies DiscoveryFallbackReason })
    }
  })

  it('needs no runner when the mode is off', async () => {
    const runner = new FakeRunner()
    const evaluation = await runtime({ mode: 'off', runner })
      .evaluate({ query: 'capability', maxResults: 3, actor: {}, lexicalNames: [] })
    expect(evaluation).toEqual({ kind: 'lexical', reason: 'off' })
    expect(runner.requests.length).toBe(0)
  })

  it('falls back to lexical when no runner resolves for the actor', async () => {
    const runner = new FakeRunner()
    const discovery = createDiscoveryRuntime({
      readSettings: () => settings(),
      snapshotEntries: () => [entry('capability_a')],
      cache: new DiscoveryCache({ maxEntries: 16, ttlMs: 60_000 }),
    })
    expect(await discovery.evaluate({ query: 'capability', maxResults: 3, actor: {}, lexicalNames: [] }))
      .toEqual({ kind: 'lexical', reason: 'unavailable' })
    expect(runner.requests.length).toBe(0)
  })
})
