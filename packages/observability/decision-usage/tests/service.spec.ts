/**
 * Host service tests (design §"Public interface", §"Architecture and
 * files"): the binder contract (per-Agent UUID via WeakMap, scope capture,
 * forged-scope rejection, invalid seq, missing cwd, dispose invalidation —
 * never a process.cwd guess), the keyless route identity, and an end-to-end
 * answered run against a fake fetch with the durable ledger beneath. The
 * service itself never triggers a request. All legs use tmpdirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DECISION_LANE_ALIAS } from '@dsh-cc/systemone'
import type { DecisionRequest, DecisionScope } from '@dsh-cc/systemone'
import { createSystemOneDecisionsService } from '../src/service.ts'
import { readProviderRecord } from '../src/service.ts'
import type { DecisionUsageServiceDeps, DecisionTrustedSettingsReader } from '../src/service.ts'
import { decisionUsageDir, readDecisionLedger, usageFilePath } from '../src/ledger.ts'
import { projectKeyOf } from '@dsh-cc/sidecar-io'
import { resolve as resolvePath } from 'node:path'

let tmp: string
let cwd: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'decision-usage-svc-'))
  cwd = join(tmp, 'worktree')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const ACTUAL_MODEL = 's1-ckpt-2026-01'
/** The lane alias's pin row: every field optional, all present here. */
const PIN_ROW = {
  revision: 'rev-1',
  'actual-model-id': ACTUAL_MODEL,
  'per-request-tokens': 4000,
  'per-question-tokens': 1000,
  'max-output-tokens': 500,
  'max-questions': 4,
}

function settingsSection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'max-attempts-per-session': 10,
    'max-input-tokens-per-session': 100_000,
    'max-output-tokens-per-session': 10_000,
    'max-retries': 0,
    routes: { [DECISION_LANE_ALIAS]: PIN_ROW },
    'ledger-max-bytes': 1_048_576,
    ...over,
  }
}

/** A minimal fake Agent: session {id, header.cwd, seq}, effect-capable ctx. */
function fakeAgent(init: { cwd?: string; id?: string; seq?: number } = {}): {
  agent: Agent
  dispose(): void
  setSeq(seq: number): void
  setSessionId(id: string): void
} {
  const cleanups: Array<() => void> = []
  const session = {
    id: init.id ?? 'sess-1',
    header: { cwd: 'cwd' in init ? init.cwd : cwd },
    currentSeq: init.seq ?? 3,
    get seq(): number {
      return this.currentSeq
    },
  }
  const agent = {
    id: session.id,
    session,
    ctx: {
      effect(body: () => (() => void) | void, _label?: string): void {
        const cleanup = body()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
    },
  } as unknown as Agent
  return {
    agent,
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
    setSeq(seq: number) {
      session.currentSeq = seq
    },
    setSessionId(id: string) {
      session.id = id
    },
  }
}

/** Successful System One wire response (validated usage, matching model). */
function answeredResponse(input = 800, output = 42): Response {
  return new Response(
    JSON.stringify({
      model: ACTUAL_MODEL,
      answers: { q1: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } } },
      usage: { input_tokens: input, output_tokens: output },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** Stand-in cascade exposing ONLY the trusted view (`trustedSection`). */
const TRUSTED_SETTINGS: DecisionTrustedSettingsReader = {
  trustedSection: (key: string) =>
    key === 'llm-pi-ai'
      ? { providers: { testone: { baseURL: 'http://127.0.0.1:9/unreachable', apiKeyEnv: 'DECISION_USAGE_TEST_KEY' } } }
      : undefined,
}

function makeService(over: Partial<DecisionUsageServiceDeps> = {}): {
  deps: DecisionUsageServiceDeps
  fetchSpy: ReturnType<typeof vi.fn>
} {
  const fetchSpy = vi.fn(async () => answeredResponse())
  const deps: DecisionUsageServiceDeps = {
    readSettings: () => settingsSection(),
    home: () => tmp,
    resolveAlias: () => ({ provider: 'testone', model: 's1-wire', protocol: 'systemone' }),
    readProviderRecord: (provider) => readProviderRecord(TRUSTED_SETTINGS, provider),
    fetchImpl: fetchSpy as unknown as typeof fetch,
    ...over,
  }
  return { deps, fetchSpy }
}

function makeRequest(scope: DecisionScope, over: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    feature: 'moa-acceptance',
    mode: 'active',
    routeAlias: DECISION_LANE_ALIAS,
    questionVersion: 'qv1',
    policyVersion: 'pv1',
    scope,
    state: { review: 'unit-test' },
    questions: { q1: { type: 'choice', instructions: 'Accept the hunk?', criteria: { yes: 'accept it', no: 'reject it' } } },
    timeoutMs: 15_000,
    maxInputTokens: 4000,
    signal: new AbortController().signal,
    ...over,
  }
}

describe('binder contract', () => {
  it('pins a stable process-wide agentId per Agent and captures seq synchronously', () => {
    const { deps } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const first = service.forAgent(agent)
    const second = service.forAgent(agent)
    expect(first.scope().agentId).toBe(second.scope().agentId)
    expect(second.scope().originSeq).toBe(3)
    const other = fakeAgent({ id: 'sess-2' })
    expect(service.forAgent(other.agent).scope().agentId).not.toBe(first.scope().agentId)
  })

  it('a forged scope (wrong agent/session/project) buys zero reserve and zero fetch', async () => {
    const { deps, fetchSpy } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const bound = service.forAgent(agent)
    const real = bound.scope()
    // Forged agentId.
    const forgedRun = await bound.run(makeRequest({ ...real, agentId: 'forged-agent' }))
    expect(forgedRun.status).toBe('unavailable')
    if (forgedRun.status === 'unavailable') expect(forgedRun.reason).toBe('unconfigured')
    // A scope minted by binder A replayed through binder B of the same session.
    const otherBound = service.forAgent(fakeAgent().agent)
    const replayRun = await otherBound.run(makeRequest(real))
    expect(replayRun.status).toBe('unavailable')
    if (replayRun.status === 'unavailable') expect(replayRun.reason).toBe('unconfigured')
    // A session switch after mint: the stale scope is rejected at validate time.
    const rig = fakeAgent()
    const sessionBound = service.forAgent(rig.agent)
    const mintedBeforeSwitch = sessionBound.scope()
    rig.setSessionId('sess-2')
    const staleRun = await sessionBound.run(makeRequest(mintedBeforeSwitch))
    expect(staleRun.status).toBe('unavailable')
    if (staleRun.status === 'unavailable') expect(staleRun.reason).toBe('unconfigured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('originSeq outside [0, session.seq] is rejected, structurally or by validate', async () => {
    const { deps, fetchSpy } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const bound = service.forAgent(agent)
    // Structurally invalid originSeqs are a malformed request.
    for (const bad of [-1, 3.7]) {
      const run = await bound.run(makeRequest(bound.scope(bad)))
      expect(run.status).toBe('unavailable')
      if (run.status === 'unavailable') expect(run.reason).toBe('malformed')
    }
    // A well-formed originSeq beyond the current seq fails validateScope.
    for (const bad of [4, Number.MAX_SAFE_INTEGER]) {
      const run = await bound.run(makeRequest(bound.scope(bad)))
      expect(run.status).toBe('unavailable')
      if (run.status === 'unavailable') expect(run.reason).toBe('unconfigured')
    }
    // The inclusive boundary itself is valid.
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope(3))).toBeDefined()
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope(0))).toBeDefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a missing cwd degrades to unconfigured, never a process.cwd guess', async () => {
    const { deps } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent({ cwd: undefined })
    const bound = service.forAgent(agent)
    const minted = bound.scope()
    // No real project key was minted (and never a process.cwd-derived one).
    expect(minted.projectKey).not.toBe(projectKeyOf(resolvePath(process.cwd())))
    const run = await bound.run(makeRequest(minted))
    expect(run.status).toBe('unavailable')
    if (run.status === 'unavailable') expect(run.reason).toBe('unconfigured')
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toBeUndefined()
  })

  it('Agent dispose permanently invalidates the binder', async () => {
    const { deps, fetchSpy } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const rig = fakeAgent()
    const bound = service.forAgent(rig.agent)
    rig.dispose()
    const run = await bound.run(makeRequest(bound.scope()))
    expect(run.status).toBe('unavailable')
    if (run.status === 'unavailable') expect(run.reason).toBe('unconfigured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mounting and identifyRoute trigger no request', async () => {
    const { deps, fetchSpy } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const bound = service.forAgent(agent)
    const identity = bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())
    expect(identity).toBeDefined()
    // Route-identity contract: no secrets and no actual-model-id.
    expect(identity).toEqual({
      provider: 'testone',
      model: 's1-wire',
      revision: 'rev-1',
      perRequestTokens: 4000,
      perQuestionTokens: 1000,
      maxQuestions: 4,
      maxOutputTokens: 500,
    })
    expect(JSON.stringify(identity)).not.toContain(ACTUAL_MODEL)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('end-to-end against a fake fetch', () => {
  it('runs answered and lands reserve/dispatch/settle/outcome rows durably', async () => {
    const { deps, fetchSpy } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const bound = service.forAgent(agent)
    const scope = bound.scope()
    const run = await bound.run(makeRequest(scope))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(run.status).toBe('answered')
    if (run.status !== 'answered') return
    expect(run.model).toBe(ACTUAL_MODEL)
    expect(run.usage).toEqual({ input_tokens: 800, output_tokens: 42 })
    expect(run.answers.q1?.choice).toBe('yes')

    const dir = decisionUsageDir(tmp, projectKeyOf(resolvePath(cwd)), 'sess-1')
    const ledger = await readDecisionLedger(usageFilePath(dir))
    const phases = ledger.rows.map((row) => `${row.phase}:${row.outcome}`)
    expect(phases).toContain('reserve:reserved')
    expect(phases).toContain('dispatch:dispatched')
    expect(phases).toContain('settle:actual')
    expect(phases).toContain('outcome:answered')
    // One reserve row per lease (the runner's rich row dedups by leaseId).
    expect(ledger.rows.filter((row) => row.phase === 'reserve')).toHaveLength(1)
    // No secrets anywhere: no apiKey, no baseURL query, no state/answer text.
    const rawText = JSON.stringify(ledger.rows)
    expect(rawText).not.toContain('DECISION_USAGE_TEST_KEY')
    expect(rawText).not.toContain('unit-test')
    expect(rawText).not.toContain('127.0.0.1')
    expect(Array.isArray(ledger.corruptLines)).toBe(true)
    expect(ledger.corruptLines).toHaveLength(0)
    expect(ledger.tornTail).toBe(false)
    // The reserved delta is refunded at settle: only actuals remain charged.
    const reserveRow = ledger.rows.find((row) => row.phase === 'reserve')
    expect(reserveRow?.reservedInputTokens).toBe(4000)
    expect(reserveRow?.reservedOutputTokens).toBe(500)
    const settleRow = ledger.rows.find((row) => row.phase === 'settle')
    expect(settleRow?.actualInputTokens).toBe(800)
    expect(settleRow?.actualOutputTokens).toBe(42)
  })

  it('a consumed attempt ceiling turns the next run into budget with no fetch', async () => {
    const { deps, fetchSpy } = makeService()
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    deps.readSettings = () => settingsSection({ 'max-attempts-per-session': 1 })
    const bound = service.forAgent(agent)
    const first = await bound.run(makeRequest(bound.scope()))
    expect(first.status).toBe('answered')
    const second = await bound.run(makeRequest(bound.scope()))
    expect(second.status).toBe('unavailable')
    if (second.status === 'unavailable') expect(second.reason).toBe('budget')
    // The second run never reached the network.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a malformed quota key fails the section closed: no route, zero dispatch, zero rows', async () => {
    const { deps, fetchSpy } = makeService()
    // The route pin row is perfectly valid; one bad quota key must still kill
    // every route (quota admission may compute ship defaults, nothing runs).
    deps.readSettings = () => settingsSection({ 'max-retries': 9 })
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const bound = service.forAgent(agent)
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toBeUndefined()
    const run = await bound.run(makeRequest(bound.scope()))
    expect(run.status).toBe('unavailable')
    if (run.status === 'unavailable') expect(run.reason).toBe('unconfigured')
    expect(fetchSpy).not.toHaveBeenCalled()
    const dir = decisionUsageDir(tmp, projectKeyOf(resolvePath(cwd)), 'sess-1')
    const ledger = await readDecisionLedger(usageFilePath(dir))
    expect(ledger.rows).toHaveLength(0)
  })

  it('a leftover non-empty capabilities table is invalid: no route, zero dispatch', async () => {
    const { deps, fetchSpy } = makeService()
    deps.readSettings = () => settingsSection({
      capabilities: [{ provider: 'testone', model: 's1-wire', revision: 'rev-1' }],
    })
    const service = createSystemOneDecisionsService(deps)
    const { agent } = fakeAgent()
    const bound = service.forAgent(agent)
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toBeUndefined()
    const run = await bound.run(makeRequest(bound.scope()))
    expect(run.status).toBe('unavailable')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an empty leftover capabilities array is tolerated and the pin row still applies', async () => {
    const { deps } = makeService()
    deps.readSettings = () => settingsSection({ capabilities: [] })
    const service = createSystemOneDecisionsService(deps)
    const bound = service.forAgent(fakeAgent().agent)
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toEqual({
      provider: 'testone',
      model: 's1-wire',
      revision: 'rev-1',
      perRequestTokens: 4000,
      perQuestionTokens: 1000,
      maxQuestions: 4,
      maxOutputTokens: 500,
    })
  })

  it('no pin row still yields a usable alias-derived route on registry defaults', async () => {
    const { deps, fetchSpy } = makeService({
      resolveAlias: () => ({ provider: 'testone', model: 'llmbox_systemone/bjev', protocol: 'systemone' }),
      readProviderRecord: (provider) => readProviderRecord(TRUSTED_SETTINGS, provider),
    })
    // The session output cap must cover the registry default reservation.
    deps.readSettings = () => settingsSection({ routes: {}, 'max-output-tokens-per-session': 1_000_000 })
    const service = createSystemOneDecisionsService(deps)
    const bound = service.forAgent(fakeAgent().agent)
    // `llmbox_systemone/bjev` keys the registry as `bjev` (16384 tokens).
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toEqual({
      provider: 'testone',
      model: 'llmbox_systemone/bjev',
      revision: 'llmbox_systemone/bjev',
      perRequestTokens: 16384,
      perQuestionTokens: 16384,
      maxQuestions: 32,
      maxOutputTokens: 32768,
    })
    const run = await bound.run(makeRequest(bound.scope()))
    expect(run.status).toBe('answered')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('an invalid pin field disables that alias only, leaving the sibling usable', () => {
    const { deps } = makeService({
      resolveAlias: (alias) =>
        alias === 'sibling'
          ? { provider: 'testone', model: 's1-wire', protocol: 'systemone' }
          : { provider: 'testone', model: 's1-wire', protocol: 'systemone' },
    })
    deps.readSettings = () => settingsSection({
      routes: { [DECISION_LANE_ALIAS]: { 'per-request-tokens': 0 }, sibling: { 'per-request-tokens': 2048 } },
    })
    const service = createSystemOneDecisionsService(deps)
    const bound = service.forAgent(fakeAgent().agent)
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toBeUndefined()
    expect(bound.identifyRoute('sibling', bound.scope())?.perRequestTokens).toBe(2048)
  })

  it('a settings object without trustedSection leaves the provider record unresolvable', async () => {
    const { deps, fetchSpy } = makeService()
    // The merged (provenance-lossy) describe() read exists but MUST NOT be used.
    const mergedOnly = {
      describe: () => [{ ns: 'llm-pi-ai', user: { providers: { testone: { baseURL: 'http://repo-controlled.invalid' } } } }],
    }
    expect(readProviderRecord(mergedOnly as unknown as DecisionTrustedSettingsReader, 'testone')).toBeUndefined()
    deps.readProviderRecord = (provider) =>
      readProviderRecord(mergedOnly as unknown as DecisionTrustedSettingsReader, provider)
    const service = createSystemOneDecisionsService(deps)
    const bound = service.forAgent(fakeAgent().agent)
    expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope())).toBeUndefined()
    const run = await bound.run(makeRequest(bound.scope()))
    expect(run.status).toBe('unavailable')
    if (run.status === 'unavailable') expect(run.reason).toBe('unconfigured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('trusted provider-record read', () => {
  it('reads the record out of the trusted view only', () => {
    expect(readProviderRecord(TRUSTED_SETTINGS, 'testone')).toEqual({
      baseURL: 'http://127.0.0.1:9/unreachable',
      apiKeyEnv: 'DECISION_USAGE_TEST_KEY',
    })
    expect(readProviderRecord(TRUSTED_SETTINGS, 'missing')).toBeUndefined()
    expect(readProviderRecord(undefined, 'testone')).toBeUndefined()
    expect(readProviderRecord({}, 'testone')).toBeUndefined()
  })

  it('a throwing trusted view is unresolvable, never a crash', () => {
    const throwing: DecisionTrustedSettingsReader = {
      trustedSection: () => {
        throw new Error('boom')
      },
    }
    expect(readProviderRecord(throwing, 'testone')).toBeUndefined()
  })
})

describe('frozen cascade sections (issue #373)', () => {
  /** Deep-freeze the resolved shape the cascade read-through actually serves. */
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      Object.freeze(value)
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    }
    return value
  }

  it('a deep-frozen section with a non-empty routes pin keeps the route usable end to end', async () => {
    // The regression: the frozen routes dict used to throw the schema
    // re-admission, parse invalid, fail the section closed, and kill every
    // identifyRoute — silently, with zero ledger rows.
    const frozen = deepFreeze(structuredClone(settingsSection()))
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen((frozen as Record<string, { routes: unknown }>).routes)).toBe(true)
    const { deps } = makeService({ readSettings: () => frozen })
    const service = createSystemOneDecisionsService(deps)
    const holder = fakeAgent()
    try {
      const bound = service.forAgent(holder.agent)
      expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope(3))).toBeDefined()
    } finally {
      holder.dispose()
    }
  })

  it('an invalid section warns exactly once through deps.warn with a stable reason', async () => {
    const warnSpy = vi.fn()
    const { deps } = makeService({
      readSettings: () => settingsSection({ 'max-retries': 'nope' as unknown as number }),
      warn: warnSpy,
    })
    const service = createSystemOneDecisionsService(deps)
    const holder = fakeAgent()
    try {
      const bound = service.forAgent(holder.agent)
      // Two route resolutions, one warn (warn-once semantics).
      expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope(3))).toBeUndefined()
      expect(bound.identifyRoute(DECISION_LANE_ALIAS, bound.scope(3))).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/systemone-decisions: section invalid \([a-z-]+\) — no decision route is usable/)
    } finally {
      holder.dispose()
    }
  })
})
