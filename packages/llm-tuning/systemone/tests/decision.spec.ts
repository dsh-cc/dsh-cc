import { describe, expect, it, vi } from 'vitest'
import { S1_ENVELOPE_TOKENS, S1_MARGIN_TOKENS, estimateSystemOneTokens } from '../src/budget.ts'
import type { SystemOneQuestion } from '../src/client.ts'
import { canonicalJson, estimateDecisionInputTokens, inputHashForDecision } from '../src/decision-hash.ts'
import { createDecisionRunner } from '../src/decision.ts'
import type {
  DecisionBudgetPermit,
  DecisionBudgetPermitProvider,
  DecisionFeature,
  DecisionLedgerRow,
  DecisionPermitOutcome,
  DecisionRequest,
  DecisionRouteResolution,
  DecisionRunnerDeps,
  DecisionScope,
} from '../src/decision.ts'

// ---------------------------------------------------------------------------
// fixtures (neutral names only; the state/question markers must never leak
// into any ledger row)
// ---------------------------------------------------------------------------

const SCOPE: DecisionScope = { projectKey: 'proj-a', sessionId: 'sess-a', agentId: 'agent-a', originSeq: 3 }

const ROUTE: DecisionRouteResolution = {
  provider: 'testlane',
  model: 'checkpoint-x',
  actualModelId: 'checkpoint-x.v1',
  baseURL: 'http://127.0.0.1:9',
  apiKey: 'test-api-key-ZXQ',
  revision: 'rev-1',
  perRequestTokens: 16000,
  perQuestionTokens: 4000,
  maxOutputTokens: 2000,
  maxQuestions: 8,
}

const QUESTIONS: Record<string, SystemOneQuestion> = {
  verdict: { type: 'choice', instructions: 'ZXQ-instructions-never-ledgered', criteria: { optA: 'first', optB: 'second' } },
}

const RATE_LIMITED = '{"error":{"type":"rate_limit_error","message":"slow down"}}'

function envelope(model: string, input: number, output: number): string {
  return JSON.stringify({
    model,
    answers: { verdict: { type: 'choice', choice: 'optA', probabilities: { optA: 0.8, optB: 0.2 } } },
    usage: { input_tokens: input, output_tokens: output },
  })
}

// ---------------------------------------------------------------------------
// fake quota provider: enforces retained accounting like the durable quota
// (settled actual refunds the reservation difference, unknown keeps the full
// reservation, not-dispatched refunds in full)
// ---------------------------------------------------------------------------

interface FakeQuotaOptions {
  inputLimit?: number
  attemptLimit?: number
  reject?: boolean
  failSettle?: boolean
  gate?: Promise<void>
  onEnter?: () => void
}

class FakePermit implements DecisionBudgetPermit {
  readonly settleCalls: DecisionPermitOutcome[] = []

  constructor(
    private readonly quota: FakeQuota,
    readonly attempt: number,
    readonly inputTokens: number,
    readonly outputTokens: number,
    private readonly failSettle: boolean,
  ) {}

  async settle(outcome: DecisionPermitOutcome): Promise<void> {
    this.settleCalls.push(outcome)
    if (this.failSettle) throw new Error('settle failed')
    this.quota.applySettle(this, outcome)
  }
}

interface ReserveInput {
  decisionId: string
  scope: DecisionScope
  feature: DecisionFeature
  attempt: number
  inputTokens: number
  outputTokens: number
  signal: AbortSignal
}

class FakeQuota implements DecisionBudgetPermitProvider {
  readonly reserveCalls: ReserveInput[] = []
  readonly permits: FakePermit[] = []
  retainedInput = 0
  retainedOutput = 0
  attemptsUsed = 0
  peakRetainedInput = 0
  onGranted?: () => void

  constructor(private readonly options: FakeQuotaOptions = {}) {}

  async reserve(input: ReserveInput): Promise<DecisionBudgetPermit | undefined> {
    this.options.onEnter?.()
    this.reserveCalls.push(input)
    if (this.options.gate !== undefined) await this.options.gate
    if (this.options.reject === true) return undefined
    if (this.retainedInput + input.inputTokens > (this.options.inputLimit ?? Number.MAX_SAFE_INTEGER)) return undefined
    if (this.attemptsUsed + 1 > (this.options.attemptLimit ?? 100)) return undefined
    this.retainedInput += input.inputTokens
    this.retainedOutput += input.outputTokens
    this.peakRetainedInput = Math.max(this.peakRetainedInput, this.retainedInput)
    this.attemptsUsed += 1
    const permit = new FakePermit(this, input.attempt, input.inputTokens, input.outputTokens, this.options.failSettle === true)
    this.permits.push(permit)
    this.onGranted?.()
    return permit
  }

  applySettle(permit: FakePermit, outcome: DecisionPermitOutcome): void {
    if (outcome.kind === 'actual') {
      this.retainedInput += outcome.usage.input_tokens - permit.inputTokens
      this.retainedOutput += outcome.usage.output_tokens - permit.outputTokens
    } else if (outcome.kind === 'not-dispatched') {
      this.retainedInput -= permit.inputTokens
      this.retainedOutput -= permit.outputTokens
      this.attemptsUsed -= 1
    }
    // unknown keeps the full reservation by design.
  }
}

// ---------------------------------------------------------------------------
// fake deps plumbing
// ---------------------------------------------------------------------------

function scriptedFetch(script: Array<{ status: number; body: string; headers?: Record<string, string> }>): typeof fetch {
  const queue = [...script]
  return vi.fn(async () => {
    const next = queue.shift() ?? { status: 500, body: 'script exhausted' }
    return new Response(next.body, {
      status: next.status,
      ...(next.headers !== undefined ? { headers: next.headers } : {}),
    })
  }) as unknown as typeof fetch
}

function okFetch(model = ROUTE.actualModelId, input = 83, output = 7): typeof fetch {
  return scriptedFetch([{ status: 200, body: envelope(model, input, output) }])
}

interface DepsSetup {
  deps: DecisionRunnerDeps
  rows: DecisionLedgerRow[]
  globalQuota: FakeQuota
}

function makeDeps(overrides: Partial<DecisionRunnerDeps> = {}): DepsSetup {
  const rows: DecisionLedgerRow[] = []
  const globalQuota = new FakeQuota()
  let uuidCounter = 0
  const deps: DecisionRunnerDeps = {
    validateScope: () => true,
    resolveRoute: () => ROUTE,
    reserveGlobal: globalQuota,
    append: (row) => {
      rows.push(structuredClone(row))
    },
    now: () => 1000,
    uuid: () => `uuid-${(uuidCounter += 1)}`,
    fetchImpl: okFetch(),
  }
  Object.assign(deps, overrides)
  if (overrides.reserveGlobal !== undefined && !(overrides.reserveGlobal instanceof FakeQuota)) {
    throw new Error('tests track reserveGlobal via the returned quota; pass a FakeQuota')
  }
  return { deps, rows, globalQuota: (overrides.reserveGlobal as FakeQuota | undefined) ?? globalQuota }
}

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    feature: 'memory-recall',
    mode: 'active',
    routeAlias: 'lane-a',
    questionVersion: 'qv-1',
    policyVersion: 'pv-1',
    scope: SCOPE,
    state: { marker: 'ZXQ-state-secret' },
    questions: QUESTIONS,
    timeoutMs: 10_000,
    maxInputTokens: 100_000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

const phases = (rows: DecisionLedgerRow[]): string[] => rows.map((row) => row.phase)

// ---------------------------------------------------------------------------
// decision-hash
// ---------------------------------------------------------------------------

describe('decision-hash', () => {
  it('canonicalJson is key-order invariant and recursively sorted', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } })
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('inputHash is a stable 64-hex full SHA-256, independent of key order', () => {
    const base = { provider: 'p', model: 'm', routeRevision: 'r', state: { x: 1, y: 2 }, questions: QUESTIONS, questionVersion: 'qv', policyVersion: 'pv' }
    const reordered = { ...base, state: { y: 2, x: 1 } }
    const hash = inputHashForDecision(base)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(inputHashForDecision(reordered)).toBe(hash)
    expect(inputHashForDecision({ ...base, questionVersion: 'qv-2' })).not.toBe(hash)
    expect(inputHashForDecision({ ...base, policyVersion: 'pv-2' })).not.toBe(hash)
    expect(inputHashForDecision({ ...base, routeRevision: 'r-2' })).not.toBe(hash)
    expect(inputHashForDecision({ ...base, state: { x: 1, y: 3 } })).not.toBe(hash)
  })

  it('estimation composes envelope + margin over state and questions', () => {
    const state = { marker: 'text' }
    const estimate = estimateDecisionInputTokens(state, QUESTIONS)
    const stateTokens = estimateSystemOneTokens(canonicalJson(state))
    expect(estimate.requestTokens).toBe(
      S1_ENVELOPE_TOKENS + stateTokens + estimateSystemOneTokens(canonicalJson(QUESTIONS)) + S1_MARGIN_TOKENS,
    )
    expect(estimate.questionTokens.verdict).toBe(
      S1_ENVELOPE_TOKENS + stateTokens + estimateSystemOneTokens(canonicalJson({ verdict: QUESTIONS.verdict })) + S1_MARGIN_TOKENS,
    )
  })
})

// ---------------------------------------------------------------------------
// runner state machine
// ---------------------------------------------------------------------------

describe('createDecisionRunner', () => {
  it('answered on a valid run, with reserve/dispatch/settle/outcome rows and no secret leakage', async () => {
    const { deps, rows, globalQuota } = makeDeps()
    const result = await createDecisionRunner(deps).run(makeRequest())
    expect(result.status).toBe('answered')
    if (result.status !== 'answered') return
    expect(result.model).toBe(ROUTE.actualModelId)
    expect(result.usage).toEqual({ input_tokens: 83, output_tokens: 7 })
    expect(result.decisionId).toBe('uuid-1')
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/)
    expect(phases(rows)).toEqual(['reserve', 'dispatch', 'settle', 'outcome'])
    expect(rows.every((row) => row.schemaVersion === 1 && row.decisionId === 'uuid-1' && row.attempt === 1)).toBe(true)
    expect(rows.map((row) => row.outcome)).toEqual(['reserved', 'dispatched', 'actual', 'answered'])
    const settleRow = rows[2]
    expect(settleRow).toMatchObject({
      outcome: 'actual',
      reservedInputTokens: 16000,
      reservedOutputTokens: 2000,
      actualInputTokens: 83,
      actualOutputTokens: 7,
    })
    expect(globalQuota.retainedInput).toBe(83)
    expect(globalQuota.retainedOutput).toBe(7)
    // privacy: no API key, baseURL, state/question text in any row.
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('test-api-key-ZXQ')
    expect(serialized).not.toContain('127.0.0.1:9')
    expect(serialized).not.toContain('ZXQ-state-secret')
    expect(serialized).not.toContain('ZXQ-instructions-never-ledgered')
    expect(serialized).not.toContain('optA')
  })

  it('forged scope is rejected before route resolution: zero reserve, zero fetch', async () => {
    const globalQuota = new FakeQuota()
    const resolveRoute = vi.fn(() => ROUTE)
    const fetchImpl = okFetch()
    const { deps, rows } = makeDeps({ validateScope: () => false, resolveRoute, reserveGlobal: globalQuota, fetchImpl })
    const result = await createDecisionRunner(deps).run(makeRequest())
    expect(result).toEqual({ status: 'unavailable', reason: 'unconfigured', decisionId: 'uuid-1' })
    expect(globalQuota.reserveCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(resolveRoute).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('mismatched response model is charged at actual usage but never acted on', async () => {
    const { deps, rows, globalQuota } = makeDeps({ fetchImpl: okFetch('checkpoint-x.OLD', 900, 20) })
    const result = await createDecisionRunner(deps).run(makeRequest())
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('malformed')
    // charged at the reported actual usage, never refunded
    expect(globalQuota.permits).toHaveLength(1)
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'actual', usage: { input_tokens: 900, output_tokens: 20 } }])
    expect(globalQuota.retainedInput).toBe(900)
    const outcomeRow = rows[rows.length - 1]!
    expect(outcomeRow.phase).toBe('outcome')
    expect(outcomeRow.outcome).toBe('malformed')
    expect(outcomeRow.reasonCode).toBe('model-version-mismatch')
    expect(outcomeRow.actualModel).toBe('checkpoint-x.OLD')
  })

  it('usage above the capability bound settles actual, records accounting-overrun and is not answered', async () => {
    const { deps, rows, globalQuota } = makeDeps({ fetchImpl: okFetch(ROUTE.actualModelId, 17000, 20) })
    const result = await createDecisionRunner(deps).run(makeRequest())
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('malformed')
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'actual', usage: { input_tokens: 17000, output_tokens: 20 } }])
    const outcomeRow = rows[rows.length - 1]!
    expect(outcomeRow.reasonCode).toBe('accounting-overrun')
    expect(outcomeRow.actualModel).toBe(ROUTE.actualModelId)
  })

  it('two concurrent runs cannot over-reserve the global quota', async () => {
    const globalQuota = new FakeQuota({ inputLimit: 20000 })
    let openResponse!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      openResponse = resolve
    })
    const fetchImpl = vi.fn(async () => pending) as unknown as typeof fetch
    const { deps } = makeDeps({ reserveGlobal: globalQuota, fetchImpl })
    const runner = createDecisionRunner(deps)
    const firstGrant = new Promise<void>((resolve) => {
      globalQuota.onGranted = () => {
        globalQuota.onGranted = undefined
        resolve()
      }
    })
    const runA = runner.run(makeRequest())
    await firstGrant
    // B arrives while A still holds 16000 of the 20000: admission must fail.
    const resultB = await runner.run(makeRequest())
    expect(resultB.status).toBe('unavailable')
    if (resultB.status !== 'unavailable') throw new Error('unreachable')
    expect(resultB.reason).toBe('budget')
    expect(globalQuota.peakRetainedInput).toBeLessThanOrEqual(20000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    openResponse(new Response(envelope(ROUTE.actualModelId, 1000, 20), { status: 200 }))
    const resultA = await runA
    expect(resultA.status).toBe('answered')
    expect(globalQuota.retainedInput).toBe(1000)
    expect(globalQuota.retainedOutput).toBe(20)
    expect(globalQuota.reserveCalls).toHaveLength(2)
  })

  it('a rejecting business provider yields no fetch and refunds the global permit not-dispatched', async () => {
    const business = new FakeQuota({ reject: true })
    const { deps, globalQuota } = makeDeps()
    const result = await createDecisionRunner(deps).run(makeRequest(), { budgetPermit: business })
    expect(result).toEqual({ status: 'unavailable', reason: 'budget', decisionId: 'uuid-1' })
    expect(business.reserveCalls).toHaveLength(1)
    expect(globalQuota.reserveCalls).toHaveLength(1)
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'not-dispatched' }])
    expect(globalQuota.retainedInput).toBe(0)
    expect(globalQuota.attemptsUsed).toBe(0)
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('business settle failure: global is still settled exactly once (known actual) and the run errors', async () => {
    const business = new FakeQuota({ failSettle: true })
    const { deps, globalQuota } = makeDeps()
    const result = await createDecisionRunner(deps).run(makeRequest(), { budgetPermit: business })
    expect(result).toEqual({ status: 'unavailable', reason: 'error', decisionId: 'uuid-1' })
    // the failed business settle was invoked exactly once and never retried
    expect(business.permits[0]!.settleCalls).toEqual([{ kind: 'actual', usage: { input_tokens: 83, output_tokens: 7 } }])
    // the never-invoked global permit was supplemented with the known actual
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'actual', usage: { input_tokens: 83, output_tokens: 7 } }])
    expect(globalQuota.retainedInput).toBe(83)
  })

  it('global settle failure after business settled: each settle invoked exactly once, run errors', async () => {
    const globalQuota = new FakeQuota({ failSettle: true })
    const business = new FakeQuota()
    const { deps } = makeDeps({ reserveGlobal: globalQuota })
    const result = await createDecisionRunner(deps).run(makeRequest(), { budgetPermit: business })
    expect(result).toEqual({ status: 'unavailable', reason: 'error', decisionId: 'uuid-1' })
    expect(business.permits[0]!.settleCalls).toEqual([{ kind: 'actual', usage: { input_tokens: 83, output_tokens: 7 } }])
    expect(globalQuota.permits[0]!.settleCalls).toHaveLength(1)
  })

  it('429 re-reserves a fresh permit: two reserve/settle pairs and an answered second attempt', async () => {
    const fetchImpl = scriptedFetch([
      { status: 429, body: RATE_LIMITED, headers: { 'retry-after': '0' } },
      { status: 200, body: envelope(ROUTE.actualModelId, 100, 10) },
    ])
    const { deps, rows, globalQuota } = makeDeps({ fetchImpl, maxRetries: 1 })
    const result = await createDecisionRunner(deps).run(makeRequest())
    expect(result.status).toBe('answered')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // a permit never serves two attempts: one fresh reserve per attempt
    expect(globalQuota.reserveCalls.map((call) => call.attempt)).toEqual([1, 2])
    expect(globalQuota.permits).toHaveLength(2)
    // the 429 body carried no usage: settled unknown at full reservation
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'unknown' }])
    expect(globalQuota.permits[0]!.attempt).toBe(1)
    expect(globalQuota.permits[1]!.settleCalls).toEqual([{ kind: 'actual', usage: { input_tokens: 100, output_tokens: 10 } }])
    expect(phases(rows)).toEqual(['reserve', 'dispatch', 'settle', 'reserve', 'dispatch', 'settle', 'outcome'])
    expect(rows.map((row) => row.attempt)).toEqual([1, 1, 1, 2, 2, 2, 2])
  })

  it('429 with the default retry budget performs a single attempt', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, body: RATE_LIMITED }])
    const { deps, globalQuota } = makeDeps({ fetchImpl })
    const result = await createDecisionRunner(deps).run(makeRequest())
    expect(result).toEqual({ status: 'unavailable', reason: 'error', decisionId: 'uuid-1' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(globalQuota.reserveCalls).toHaveLength(1)
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'unknown' }])
  })

  it('a timeout after fetch settles unknown and keeps the full reservation', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const { deps, rows, globalQuota } = makeDeps({ fetchImpl })
    const result = await createDecisionRunner(deps).run(makeRequest({ timeoutMs: 40 }))
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('timeout')
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'unknown' }])
    expect(globalQuota.retainedInput).toBe(16000)
    expect(globalQuota.retainedOutput).toBe(2000)
    expect(phases(rows)).toEqual(['reserve', 'dispatch', 'settle', 'outcome'])
    expect(rows[2]!.outcome).toBe('unknown')
  })

  it('caller abort during reserve refunds both permits not-dispatched (cancelled before dispatch)', async () => {
    const controller = new AbortController()
    let releaseReserve!: () => void
    let entered!: () => void
    const enteredReserve = new Promise<void>((resolve) => {
      entered = resolve
    })
    const globalQuota = new FakeQuota({
      gate: new Promise<void>((resolve) => {
        releaseReserve = resolve
      }),
      onEnter: () => entered(),
    })
    const business = new FakeQuota()
    const fetchImpl = okFetch()
    const { deps } = makeDeps({ reserveGlobal: globalQuota, fetchImpl })
    const runPromise = createDecisionRunner(deps).run(makeRequest({ signal: controller.signal }), { budgetPermit: business })
    await enteredReserve
    controller.abort()
    releaseReserve()
    const result = await runPromise
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('cancelled')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'not-dispatched' }])
    expect(business.permits[0]!.settleCalls).toEqual([{ kind: 'not-dispatched' }])
    expect(globalQuota.attemptsUsed).toBe(0)
  })

  it('caller abort after dispatch is not refunded: the permit settles unknown', async () => {
    const controller = new AbortController()
    const fetchImpl = (async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    const { deps, globalQuota } = makeDeps({ fetchImpl })
    const result = await createDecisionRunner(deps).run(makeRequest({ signal: controller.signal }))
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('cancelled')
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'unknown' }])
    expect(globalQuota.retainedInput).toBe(16000)
  })

  it('an over-limit input estimate returns budget with zero reserve and zero fetch', async () => {
    const { deps, globalQuota } = makeDeps()
    const result = await createDecisionRunner(deps).run(makeRequest({ state: 'word '.repeat(400), maxInputTokens: 300 }))
    expect(result).toEqual({ status: 'unavailable', reason: 'budget', decisionId: 'uuid-1' })
    expect(globalQuota.reserveCalls).toEqual([])
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('each state+question pair is checked individually against the per-question window', async () => {
    const tightRoute: DecisionRouteResolution = { ...ROUTE, perQuestionTokens: 100 }
    const bigQuestion: Record<string, SystemOneQuestion> = {
      verdict: { type: 'choice', instructions: 'x'.repeat(1000), criteria: { optA: 'first', optB: 'second' } },
    }
    const { deps, globalQuota } = makeDeps({ resolveRoute: () => tightRoute })
    const result = await createDecisionRunner(deps).run(makeRequest({ questions: bigQuestion, maxInputTokens: 1_000_000 }))
    expect(result).toEqual({ status: 'unavailable', reason: 'budget', decisionId: 'uuid-1' })
    expect(globalQuota.reserveCalls).toEqual([])
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('a failed dispatch-row write starts no fetch and refunds the permits not-dispatched', async () => {
    const rows: DecisionLedgerRow[] = []
    const append = async (row: DecisionLedgerRow): Promise<void> => {
      if (row.phase === 'dispatch') throw new Error('ledger write failed')
      rows.push(structuredClone(row))
    }
    const business = new FakeQuota()
    const { deps, globalQuota } = makeDeps({ append })
    const result = await createDecisionRunner(deps).run(makeRequest(), { budgetPermit: business })
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') return
    expect(result.reason).toBe('error')
    expect(deps.fetchImpl).not.toHaveBeenCalled()
    expect(globalQuota.permits[0]!.settleCalls).toEqual([{ kind: 'not-dispatched' }])
    expect(business.permits[0]!.settleCalls).toEqual([{ kind: 'not-dispatched' }])
    expect(phases(rows)).toEqual(['reserve', 'settle', 'outcome'])
    expect(rows[1]!.outcome).toBe('not-dispatched')
  })

  it('identifyRoute returns the keyless identity and undefined for forged scope or missing route', () => {
    const { deps } = makeDeps()
    const runner = createDecisionRunner(deps)
    expect(runner.identifyRoute('lane-a', SCOPE)).toEqual({
      provider: ROUTE.provider,
      model: ROUTE.model,
      revision: ROUTE.revision,
      perRequestTokens: ROUTE.perRequestTokens,
      perQuestionTokens: ROUTE.perQuestionTokens,
      maxQuestions: ROUTE.maxQuestions,
      maxOutputTokens: ROUTE.maxOutputTokens,
    })
    const forged = createDecisionRunner({ ...deps, validateScope: () => false })
    expect(forged.identifyRoute('lane-a', SCOPE)).toBeUndefined()
    const missing = createDecisionRunner({ ...deps, resolveRoute: () => undefined })
    expect(missing.identifyRoute('lane-a', SCOPE)).toBeUndefined()
  })
})
