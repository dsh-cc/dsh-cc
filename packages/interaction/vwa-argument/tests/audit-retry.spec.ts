/** Audit model-output validation must share the caller's repair and diagnostics path. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseExtractResponse } from '../src/audit-input.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import type { ReviewBudget } from '../src/review-budget.ts'
import { BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot } from './review-helpers.ts'

type Failure = 'json' | 'shape' | 'null' | 'item-schema' | 'span' | 'alignment' | 'rules' | 'stage'
const TEXT = 'The document records the decision.'

function fixture(failure: Failure, failures = Infinity, limits: Partial<ReviewBudget> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vwa-audit-retry-'))
  const claim = makeClaim('fact', TEXT)
  const snapshot = makeSnapshot({ claims: [claim] })
  const artifact = { id: `art_${randomUUID()}`, path: 'docs/a.md', text: TEXT }
  const stage = ['alignment', 'rules', 'stage'].includes(failure) ? 'align' : 'extract'
  const counts = { extract: 0, align: 0 }
  const attempts: { stage: string; raw: string; messages: string[] }[] = []
  const adapter = fakeAdapter([(req) => {
    const envelope = JSON.parse(req.messages[1]!.content)
    const current: 'extract' | 'align' = envelope.stage
    const invalid = current === stage && counts[current] < failures
    counts[current]++
    const item = {
      span: { start: 0, end: TEXT.length }, exactText: TEXT, isQuotation: false,
      atomicClaims: [{ text: TEXT, kind: 'fact', scope: claim.scope, importance: 'supporting' }],
    }
    let response: unknown = current === 'extract' ? { items: [item] } : {
      stage: 'align', rubricVersion: 'humanities-v1', findings: [],
      targets: [{ targetId: artifact.id, checks: envelope.requiredRules.map((rule: { ruleId: string }) => ({
        ruleId: rule.ruleId, result: 'pass', rationale: 'checked', evidenceIds: [],
      })) }],
      alignment: envelope.items.map((entry: { extractedId: string }) => ({
        extractedId: entry.extractedId, claimIds: [claim.id], relation: 'exact', rationale: 'same claim',
      })),
    }
    if (invalid) {
      switch (failure) {
        case 'shape': response = { items: null }; break
        case 'null': response = null; break
        case 'item-schema': response = { items: [{ ...item, atomicClaims: [] }] }; break
        case 'span': response = { items: [{ ...item, exactText: 'fabricated' }] }; break
        case 'alignment': (response as { alignment: unknown[] }).alignment = []; break
        case 'rules': (response as { targets: unknown[] }).targets = []; break
        case 'stage': response = JSON.parse(claimsResponse(claim.id, 'pass')); break
      }
    }
    const raw = invalid && failure === 'json' ? '{' + 'x'.repeat(2500) : JSON.stringify(response)
    attempts.push({ stage: current, raw, messages: req.messages.map((m) => m.content) })
    return { raw, inputTokens: 10, outputTokens: 5 }
  }])
  const runId = `run_${randomUUID()}`
  const run = () => executeReviewRun({
    deps: { root, adapter, budget: { ...BUDGET, ...limits }, contractHash: 'a'.repeat(64) },
    runId, requestId: `req_${randomUUID()}`, stages: ['audit'], targetClaimIds: [claim.id],
    snapshot, signal: new AbortController().signal, artifact,
  })
  return { root, snapshot, runId, run, counts, attempts, stage }
}

async function drain<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return pending
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('audit response repair', () => {
  it('completes valid extraction and alignment without retries', async () => {
    const f = fixture('shape', 0)
    const outcome = await drain(f.run())
    expect(outcome.status, JSON.stringify(outcome.records)).toBe('completed')
    expect(f.counts).toEqual({ extract: 1, align: 1 })
  })

  it.each<Failure>(['shape', 'null', 'item-schema', 'span', 'alignment', 'rules', 'stage'])(
    'repairs %s failures on the third attempt without repeating earlier stages', async (failure) => {
      const f = fixture(failure, 2)
      const outcome = await drain(f.run())
      expect(outcome.status).toBe('completed')
      expect(f.counts).toEqual(f.stage === 'extract' ? { extract: 3, align: 1 } : { extract: 1, align: 3 })
      expect(outcome.records.map((r) => r.stage)).toEqual(['extract', 'align'])
      const retried = f.attempts.filter((a) => a.stage === f.stage)
      for (const attempt of retried.slice(1)) {
        expect(attempt.messages.at(-1)).toContain('previous response was invalid')
      }
      expect(outcome.calls).toBe(4)
      expect(outcome.inputTokens).toBe(40)
      expect(outcome.outputTokens).toBe(20)
      const store = new ReviewRunStore(f.root, f.snapshot.projectId)
      const rows = store.readUsage(f.runId)
      const reserved = rows.filter((r) => r.kind === 'reserved')
      expect(reserved).toHaveLength(4)
      const first = reserved[f.stage === 'extract' ? 0 : 1]!
      for (const row of reserved.slice(f.stage === 'extract' ? 1 : 2, f.stage === 'extract' ? 3 : 4)) {
        expect(row.retryOf).toBe(`${first.taskId}:${first.seq}`)
      }
    },
  )
})

describe('persisted audit failure diagnostics', () => {
  it('attaches a bounded response tail to extraction JSON parse errors', () => {
    const raw = '{' + 'x'.repeat(2500)
    let caught: unknown
    try { parseExtractResponse(raw) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'REVIEW_INVALID', rawResponse: raw.slice(-2000) })
  })

  it.each<Failure>(['json', 'shape', 'null', 'item-schema', 'span', 'alignment', 'rules', 'stage'])(
    'persists the final %s response tail and three attempts', async (failure) => {
      const f = fixture(failure)
      const outcome = await drain(f.run())
      expect(outcome.status).toBe('incomplete')
      const record = outcome.records.at(-1)!
      expect(record.errorCode).toBe('REVIEW_INVALID')
      expect(record.errorDetail).toMatchObject({
        retryAttempts: 3, rawResponseTail: f.attempts.at(-1)!.raw.slice(-2000),
      })
      expect(f.counts[f.stage as 'extract' | 'align']).toBe(3)
      const saved = new ReviewRunStore(f.root, f.snapshot.projectId).readRecords(f.runId)
      expect(saved.at(-1)?.errorDetail).toEqual(record.errorDetail)
    },
  )

  it('stops audit repairs when the shared caller budget is exhausted', async () => {
    const f = fixture('shape', Infinity, { maxCallsPerRun: 2 })
    const outcome = await drain(f.run())
    expect(outcome.status).toBe('budget-exhausted')
    expect(outcome.calls).toBe(2)
    expect(f.counts).toEqual({ extract: 2, align: 0 })
    expect(outcome.records.at(-1)).toMatchObject({
      errorCode: 'BUDGET_EXHAUSTED', errorDetail: { retryAttempts: 2 },
    })
  })
})
