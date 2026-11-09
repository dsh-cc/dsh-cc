/**
 * Durable quota unit tests (design §"Durable quota and concurrency"; TLA-
 * backed): the three crash cut points (after reserve / after dispatch /
 * mid-line in settle — no restart may hand out free quota), reserve
 * rejection, settle idempotency + conflicting-terminal freeze, torn-tail
 * freeze, lock contention, quota-limit enforcement, the concurrent A/B
 * example, and the freeze-persist-failure kept lock. Every leg uses tmpdirs
 * and fresh quota instances to simulate restarts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionBudgetPermit, DecisionLedgerRow } from '@dsh-cc/systemone'
import {
  LOCK_WAIT_BUDGET_MS,
  createDecisionQuota,
  DecisionQuotaError,
} from '../src/quota.ts'
import type { DecisionQuota, DecisionQuotaLimits } from '../src/quota.ts'
import { lockFilePath, readDecisionLedger, usageFilePath } from '../src/ledger.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'decision-usage-quota-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const SCOPE = { projectKey: 'proj-9', sessionId: 'sess-9', agentId: 'agent-9', originSeq: 4 }

type ReserveInput = Parameters<DecisionQuota['reserve']>[0]

let eventCounter = 0
const freshIds = (): (() => string) => {
  return () => `evt-${++eventCounter}`
}

function makeLimits(over: Partial<DecisionQuotaLimits> = {}): DecisionQuotaLimits {
  return {
    maxAttempts: 10,
    maxInputTokens: 1000,
    maxOutputTokens: 100,
    ledgerMaxBytes: 10 * 1024 * 1024,
    ...over,
  }
}

/** Fresh quota instance over `dir` with a live limits holder (restart model). */
function makeQuota(dir: string, holder: { current: DecisionQuotaLimits } = { current: makeLimits() }): {
  quota: DecisionQuota
  holder: { current: DecisionQuotaLimits }
} {
  return {
    quota: createDecisionQuota({ dir, limits: () => holder.current, uuid: freshIds() }),
    holder,
  }
}

function reserveInput(over: Partial<ReserveInput> = {}): ReserveInput {
  return {
    decisionId: 'dec-1',
    scope: { ...SCOPE },
    feature: 'moa-acceptance',
    attempt: 1,
    inputTokens: 100,
    outputTokens: 10,
    signal: new AbortController().signal,
    ...over,
  }
}

function rowOf(over: Partial<DecisionLedgerRow> = {}): DecisionLedgerRow {
  return {
    schemaVersion: 1,
    eventId: `evt-${++eventCounter}`,
    decisionId: 'dec-1',
    attempt: 1,
    phase: 'dispatch',
    time: 1_700_000_000_000,
    scope: { ...SCOPE },
    feature: 'moa-acceptance',
    mode: 'active',
    provider: 'testone',
    requestedModel: 's1-wire',
    actualModel: null,
    routeRevision: 'rev-1',
    questionVersion: 'qv1',
    policyVersion: 'pv1',
    inputHash: 'hash-1',
    reservedInputTokens: 100,
    reservedOutputTokens: 10,
    latencyMs: 0,
    outcome: 'dispatched',
    ...over,
  }
}

function settleRow(
  lease: { decisionId: string; attempt: number },
  outcome: 'actual' | 'unknown' | 'not-dispatched',
  actual: { input: number; output: number } = { input: 40, output: 8 },
): DecisionLedgerRow {
  const row = rowOf({ decisionId: lease.decisionId, attempt: lease.attempt, phase: 'settle', outcome })
  if (outcome === 'actual') {
    row.actualInputTokens = actual.input
    row.actualOutputTokens = actual.output
  }
  return row
}

/** The runner's settle sequence against the quota: permit settle, then the settle row. */
async function settleThroughRunner(
  quota: DecisionQuota,
  permit: DecisionBudgetPermit,
  lease: { decisionId: string; attempt: number },
  outcome: 'actual' | 'unknown' | 'not-dispatched',
  actual: { input: number; output: number } = { input: 40, output: 8 },
): Promise<void> {
  await permit.settle(outcome === 'actual' ? { kind: 'actual', usage: { input_tokens: actual.input, output_tokens: actual.output } } : { kind: outcome })
  await quota.append(settleRow(lease, outcome, actual))
}

describe('crash recovery: no restart may hand out free quota', () => {
  it('crash after reserve: the unpaired reserve keeps its full amount', async () => {
    const dir = join(tmp, 'crash-reserve')
    const { quota: before } = makeQuota(dir)
    const permit = await before.reserve(reserveInput())
    expect(permit).toBeDefined()
    // "Crash": the instance is abandoned unsettled; a new instance reads the ledger.
    const { quota: after, holder } = makeQuota(dir)
    const report = await after.report()
    expect(report.attemptsUsed).toBe(1)
    expect(report.retainedInputTokens).toBe(100)
    expect(report.retainedOutputTokens).toBe(10)
    holder.current = makeLimits({ maxAttempts: 1 })
    expect(await after.reserve(reserveInput({ decisionId: 'dec-2' }))).toBeUndefined()
    expect(after.lastRejection()).toBe('budget')
  })

  it('crash after dispatch: retained in full, counted, no over-reserve boundary slip', async () => {
    const dir = join(tmp, 'crash-dispatch')
    const { quota: before } = makeQuota(dir)
    expect(await before.reserve(reserveInput())).toBeDefined()
    await before.append(rowOf())
    const { quota: after } = makeQuota(dir)
    const report = await after.report()
    expect(report.attemptsUsed).toBe(1)
    expect(report.retainedInputTokens).toBe(100)
    // Boundary math is inclusive: 100 retained + 900 = exactly the 1000 limit passes.
    expect(await after.reserve(reserveInput({ decisionId: 'dec-2', inputTokens: 900 }))).toBeDefined()
    const third = makeQuota(dir)
    await expect(third.quota.reserve(reserveInput({ decisionId: 'dec-3', inputTokens: 1 }))).resolves.toBeUndefined()
  })

  it('crash mid-line in settle: the torn tail freezes the session quota durably', async () => {
    const dir = join(tmp, 'crash-settle-torn')
    const { quota: before } = makeQuota(dir)
    const permit = await before.reserve(reserveInput())
    expect(permit).toBeDefined()
    await before.append(rowOf())
    // "Crash" torn mid-settle write: a partial line with no trailing newline.
    writeFileSync(usageFilePath(dir), `${readFileSync(usageFilePath(dir), 'utf8')}{"schemaVersion":1,"eventId":"evt-x","phase":"set`, 'utf8')
    const { quota: after } = makeQuota(dir)
    expect(await after.reserve(reserveInput({ decisionId: 'dec-2' }))).toBeUndefined()
    expect(after.lastRejection()).toBe('torn-tail')
    const ledger = await readDecisionLedger(usageFilePath(dir))
    const freeze = ledger.rows.find((r) => r.reasonCode === 'torn-tail')
    expect(freeze).toBeDefined()
    expect(freeze?.phase).toBe('outcome')
    // Durable: a later instance reads the freeze back from the ledger.
    const { quota: third } = makeQuota(dir)
    const report = await third.report()
    expect(report.frozen).toBe(true)
    expect(report.freezeReasonCode).toBe('torn-tail')
    expect(await third.reserve(reserveInput({ decisionId: 'dec-3' }))).toBeUndefined()
    // Bookkeeping still lands: a pre-existing lease may settle after the freeze.
    await third.append(settleRow({ decisionId: 'dec-1', attempt: 1 }, 'unknown'))
    expect((await third.report()).retainedInputTokens).toBe(100)
  })
})

describe('reserve rejection and limits', () => {
  it('rejects when the attempt ceiling is reached; a durable not-dispatched refunds the slot', async () => {
    const dir = join(tmp, 'attempts')
    const { quota, holder } = makeQuota(dir)
    holder.current = makeLimits({ maxAttempts: 1 })
    const permit = await quota.reserve(reserveInput())
    expect(permit).toBeDefined()
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-2' }))).toBeUndefined()
    expect(quota.lastRejection()).toBe('budget')
    // A rejected reserve writes no row.
    expect((await readDecisionLedger(usageFilePath(dir))).rows).toHaveLength(1)
    await settleThroughRunner(quota, permit!, { decisionId: 'dec-1', attempt: 1 }, 'not-dispatched')
    expect((await quota.report()).attemptsUsed).toBe(0)
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-3' }))).toBeDefined()
  })

  it('enforces input and output ceilings with inclusive boundary', async () => {
    const dir = join(tmp, 'tokens')
    const { quota, holder } = makeQuota(dir)
    holder.current = makeLimits({ maxInputTokens: 150, maxOutputTokens: 25 })
    expect(await quota.reserve(reserveInput({ inputTokens: 100, outputTokens: 10 }))).toBeDefined()
    // 100 + 100 > 150 → reject.
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-2', inputTokens: 100, outputTokens: 10 }))).toBeUndefined()
    // 100 + 50 = 150 ≤ 150 → admit; 10 + 15 = 25 ≤ 25 → admit.
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-3', inputTokens: 50, outputTokens: 15 }))).toBeDefined()
    // Output: 25 + 1 > 25 → reject.
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-4', inputTokens: 0, outputTokens: 1 }))).toBeUndefined()
  })

  it('ledger-max-bytes stops new decisions without deleting records', async () => {
    const dir = join(tmp, 'bytes')
    const { quota, holder } = makeQuota(dir)
    expect(await quota.reserve(reserveInput())).toBeDefined()
    const size = (await quota.report()).bytes
    expect(size).toBeGreaterThan(0)
    holder.current = makeLimits({ ledgerMaxBytes: size })
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-2' }))).toBeUndefined()
    expect(quota.lastRejection()).toBe('budget')
    // The existing record is untouched, and bookkeeping may still land.
    const ledger = await readDecisionLedger(usageFilePath(dir))
    expect(ledger.rows).toHaveLength(1)
    await quota.append(rowOf())
    expect((await readDecisionLedger(usageFilePath(dir))).rows).toHaveLength(2)
  })

  it('two concurrent reserves cannot over-reserve (the A/B example)', async () => {
    const dir = join(tmp, 'concurrent')
    const { quota, holder } = makeQuota(dir)
    holder.current = makeLimits({ maxAttempts: 1 })
    const [a, b] = await Promise.all([
      quota.reserve(reserveInput({ decisionId: 'dec-a' })),
      quota.reserve(reserveInput({ decisionId: 'dec-b' })),
    ])
    expect([a, b].filter((p) => p !== undefined)).toHaveLength(1)
    expect((await quota.report()).attemptsUsed).toBe(1)
  })

  it('lowering a limit below what is already consumed rejects subsequent requests', async () => {
    const dir = join(tmp, 'lowered')
    const { quota, holder } = makeQuota(dir)
    expect(await quota.reserve(reserveInput({ inputTokens: 400 }))).toBeDefined()
    holder.current = makeLimits({ maxInputTokens: 300 })
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-2', inputTokens: 1 }))).toBeUndefined()
  })
})

describe('settle idempotency and conflicting-terminal freeze', () => {
  it('an actual settle retains only actuals; repeating it charges nothing more', async () => {
    const dir = join(tmp, 'settle-ok')
    const { quota } = makeQuota(dir)
    const permit = await quota.reserve(reserveInput())
    expect(permit).toBeDefined()
    await quota.append(rowOf())
    await settleThroughRunner(quota, permit!, { decisionId: 'dec-1', attempt: 1 }, 'actual', { input: 40, output: 8 })
    expect((await quota.report()).retainedInputTokens).toBe(40)
    const before = (await readDecisionLedger(usageFilePath(dir))).rows.length
    await quota.append(settleRow({ decisionId: 'dec-1', attempt: 1 }, 'actual'))
    expect((await quota.report()).retainedInputTokens).toBe(40)
    expect((await readDecisionLedger(usageFilePath(dir))).rows.length).toBe(before)
  })

  it('a conflicting terminal settle appends quota-frozen and throws; new reserves stop', async () => {
    const dir = join(tmp, 'settle-conflict-row')
    const { quota } = makeQuota(dir)
    const permit = await quota.reserve(reserveInput())
    expect(permit).toBeDefined()
    await settleThroughRunner(quota, permit!, { decisionId: 'dec-1', attempt: 1 }, 'actual', { input: 40, output: 8 })
    await expect(quota.append(settleRow({ decisionId: 'dec-1', attempt: 1 }, 'actual', { input: 45, output: 8 })))
      .rejects.toBeInstanceOf(DecisionQuotaError)
    const ledger = await readDecisionLedger(usageFilePath(dir))
    expect(ledger.rows.some((r) => r.reasonCode === 'quota-frozen')).toBe(true)
    expect(await quota.reserve(reserveInput({ decisionId: 'dec-2' }))).toBeUndefined()
  })

  it('the permit itself detects a conflicting terminal against the durable row', async () => {
    const dir = join(tmp, 'settle-conflict-permit')
    const { quota } = makeQuota(dir)
    const first = await quota.reserve(reserveInput())
    expect(first).toBeDefined()
    await settleThroughRunner(quota, first!, { decisionId: 'dec-1', attempt: 1 }, 'actual', { input: 40, output: 8 })
    // A second permit for the SAME lease (a retried reservation is idempotent)
    // settling a different terminal is a conflict.
    const retry = await quota.reserve(reserveInput())
    expect(retry).toBeDefined()
    await expect(retry!.settle({ kind: 'unknown' })).rejects.toMatchObject({ code: 'settle-conflict' })
    expect((await quota.report()).frozen).toBe(true)
    expect((await quota.report()).freezeReasonCode).toBe('quota-frozen')
  })
})

describe('lock protocol', () => {
  it('a held lock fails the call as quota-lock-unavailable within the bounded wait', async () => {
    const dir = join(tmp, 'contention')
    mkdirSync(dir, { recursive: true })
    writeFileSync(lockFilePath(dir), 'held', { mode: 0o600 })
    const { quota } = makeQuota(dir)
    const started = Date.now()
    expect(await quota.reserve(reserveInput())).toBeUndefined()
    const elapsed = Date.now() - started
    expect(quota.lastRejection()).toBe('quota-lock-unavailable')
    expect(elapsed).toBeGreaterThanOrEqual(LOCK_WAIT_BUDGET_MS - 15)
    expect(elapsed).toBeLessThan(5000)
    // And no ledger row was written while the lock was held.
    expect(existsSync(usageFilePath(dir))).toBe(false)
    // Releasing the holder unblocks the very next call (no stale state).
    unlinkSync(lockFilePath(dir))
    expect(await quota.reserve(reserveInput())).toBeDefined()
  })

  it('when persisting the freeze row fails, the lock file is KEPT in place', async () => {
    const dir = join(tmp, 'freeze-persist-fails')
    const { quota } = makeQuota(dir)
    const permit = await quota.reserve(reserveInput())
    expect(permit).toBeDefined()
    await settleThroughRunner(quota, permit!, { decisionId: 'dec-1', attempt: 1 }, 'actual', { input: 40, output: 8 })
    // Make the ledger unappendable but still readable: the conflict freeze
    // row cannot persist, so the transaction keeps the lock as the alarm.
    chmodSync(usageFilePath(dir), 0o444)
    try {
      await expect(quota.append(settleRow({ decisionId: 'dec-1', attempt: 1 }, 'actual', { input: 45, output: 8 })))
        .rejects.toThrow()
      expect(existsSync(lockFilePath(dir))).toBe(true)
      // A fresh instance is stopped by the stuck lock (human clears it in v1).
      const { quota: after, holder } = makeQuota(dir)
      expect(await after.reserve(reserveInput({ decisionId: 'dec-2' }))).toBeUndefined()
      expect(after.lastRejection()).toBe('quota-lock-unavailable')
      expect(holder.current.maxAttempts).toBeGreaterThan(0)
    } finally {
      chmodSync(usageFilePath(dir), 0o600)
    }
  })
})
