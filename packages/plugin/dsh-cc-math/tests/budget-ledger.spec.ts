/**
 * Budget ledger behavioral tests (design §3.3 write-ahead intents, §5.3
 * reservation/settlement admission): admission rule incl. refusal on both
 * axes, idempotent opId-keyed settlement, rollback that never refunds (the
 * envelope is retained as a conservative charge), fixed resume order
 * (reconcile by result.json hash FIRST, then roll back), whole-file atomic
 * writes, and the cooperative run deadline.
 */
import { readdir, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initLedger, ledgerStatus, main, reserve, resume, rollbackUnsettled, settle,
} from '../skills/math-research/scripts/budget-ledger.mjs'
import { initRun } from '../skills/math-research/scripts/init-run.mjs'
import { cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

async function makeRun(overrides: { attempts?: number; tokens?: number; wallClockMs?: number } = {}) {
  const root = await roots.make('mrh-budget-')
  const budget = { attempts: overrides.attempts ?? 8, tokens: overrides.tokens ?? 1000, wallClockMs: overrides.wallClockMs ?? 3600000 }
  await writeFile(join(root, 'run-manifest.json'), JSON.stringify({ goal: 'test run', createdAt: isoNow(), budget }))
  await initLedger(root)
  return root
}

const tokens = async (root: string) => (await ledgerStatus(root)).totals

describe('budget-ledger init', () => {
  it('materializes caps from the strict run manifest and is idempotent', async () => {
    const root = await makeRun({ attempts: 3, tokens: 500 })
    const status = await ledgerStatus(root)
    expect(status.totals.attemptsCap).toBe(3)
    expect(status.totals.tokensCap).toBe(500)
    const again = await initLedger(root)
    expect(again.reused).toBe(true)
    // A re-init with different caps is a hard error, never a clobber.
    await writeFile(join(root, 'run-manifest.json'), JSON.stringify({ goal: 'g', createdAt: isoNow(), budget: { attempts: 4, tokens: 500, wallClockMs: 3600000 } }))
    await expect(initLedger(root)).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('rejects an invalid manifest (strict schema, unknown fields)', async () => {
    const root = await roots.make('mrh-budget-')
    await writeFile(join(root, 'run-manifest.json'), JSON.stringify({ goal: 'g', createdAt: isoNow(), budget: { attempts: 3, tokens: 1, wallClockMs: 1, extra: true } }))
    await expect(initLedger(root)).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('budget-ledger admission rule', () => {
  it('refuses a reservation that would exceed the token cap (§5.3: settled + outstanding + new ≤ cap), exit 2', async () => {
    const root = await makeRun({ tokens: 100 })
    await reserve(root, { opId: 'op-1', envelopeTokens: 60 })
    // 60 outstanding + 50 new = 110 > 100 → refused; admission does not mutate the ledger.
    await expect(reserve(root, { opId: 'op-2', envelopeTokens: 50 })).rejects.toMatchObject({ code: 'budget-exceeded' })
    expect((await tokens(root)).outstandingReservedTokens).toBe(60)
    // CLI-level: the refusal is a single-line JSON with exit code 2.
    const { exitCode, output } = await cli(main, ['reserve', '--run', root, '--op-id', 'op-3', '--envelope-tokens', '50'])
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ command: 'budget-ledger', status: 'blocked', reason: { code: 'budget-exceeded' } })
  })

  it('refuses a reservation exceeding maxAttempts (attempts axis)', async () => {
    const root = await makeRun({ attempts: 1, tokens: 1000000 })
    await reserve(root, { opId: 'op-1', envelopeTokens: 10 })
    await expect(reserve(root, { opId: 'op-2', envelopeTokens: 10 })).rejects.toMatchObject({ code: 'attempt-cap-exceeded' })
  })

  it('settled usage releases the envelope for later admission', async () => {
    const root = await makeRun({ tokens: 100 })
    await reserve(root, { opId: 'op-1', envelopeTokens: 80 })
    await settle(root, { opId: 'op-1', promptTokens: 20, completionTokens: 10 })
    // Charged is now 30, not 80: a 60-token reservation is again admissible (30 + 60 ≤ 100).
    await reserve(root, { opId: 'op-2', envelopeTokens: 60 })
    expect((await tokens(root)).chargedTokens).toBe(90)
  })

  it('checks the run deadline at reservation time (cooperative wall-clock)', async () => {
    const root = await makeRun({ tokens: 100 })
    const afterDeadline = () => '2999-01-01T00:00:00.000Z'
    await expect(reserve(root, { opId: 'op-1', envelopeTokens: 10 }, { now: afterDeadline })).rejects.toMatchObject({ code: 'deadline-exceeded' })
  })
})

describe('budget-ledger settlement', () => {
  it('is keyed by opId and idempotent: the same settlement twice changes nothing', async () => {
    const root = await makeRun()
    await reserve(root, { opId: 'op-1', envelopeTokens: 100 })
    const first = await settle(root, { opId: 'op-1', promptTokens: 7, completionTokens: 3 })
    expect(first.changed).toBe(true)
    const second = await settle(root, { opId: 'op-1', promptTokens: 7, completionTokens: 3 })
    expect(second.changed).toBe(false)
    expect((await tokens(root)).settledTokens).toBe(10)
    const raw = await readFile(join(root, 'budget.json'), 'utf8')
    await settle(root, { opId: 'op-1', promptTokens: 7, completionTokens: 3 })
    expect(await readFile(join(root, 'budget.json'), 'utf8')).toBe(raw)
  })

  it('rejects settlement of an unknown opId (exit 2)', async () => {
    const root = await makeRun()
    await expect(settle(root, { opId: 'nope', promptTokens: 1, completionTokens: 1 })).rejects.toMatchObject({ code: 'unknown-op' })
    const { exitCode } = await cli(main, ['settle', '--run', root, '--op-id', 'nope', '--prompt-tokens', '1', '--completion-tokens', '1'])
    expect(exitCode).toBe(2)
  })
})

describe('budget-ledger rollback (never refunds, §3.3)', () => {
  it('marks unsettled intents discarded but RETAINS the envelope as a conservative charge', async () => {
    const root = await makeRun({ tokens: 100 })
    await reserve(root, { opId: 'op-1', envelopeTokens: 60 })
    const rolled = await rollbackUnsettled(root)
    expect(rolled.discarded).toEqual(['op-1'])
    const totals = await tokens(root)
    // Nothing is refunded: the 60-token envelope still charges against the cap…
    expect(totals.discardedChargeTokens).toBe(60)
    expect(totals.chargedTokens).toBe(60)
    // …which provably blocks an admission that a refund would have allowed.
    await expect(reserve(root, { opId: 'op-2', envelopeTokens: 50 })).rejects.toMatchObject({ code: 'budget-exceeded' })
  })

  it('a later settlement replaces the retained charge with actual usage (evidence wins)', async () => {
    const root = await makeRun({ tokens: 100 })
    await reserve(root, { opId: 'op-1', envelopeTokens: 60 })
    await rollbackUnsettled(root)
    await settle(root, { opId: 'op-1', promptTokens: 10, completionTokens: 10 })
    expect((await tokens(root)).chargedTokens).toBe(20)
    await reserve(root, { opId: 'op-2', envelopeTokens: 50 })
    expect((await tokens(root)).chargedTokens).toBe(70)
  })
})

describe('budget-ledger resume (fixed order, §3.3/§5.1)', () => {
  it('reconciles by result.json hash FIRST, then rolls back the rest', async () => {
    const root = await makeRun({ tokens: 100 })
    await reserve(root, { opId: 'op-1', envelopeTokens: 40 })
    await reserve(root, { opId: 'op-2', envelopeTokens: 40 })
    const results = join(root, 'results')
    await mkdir(join(results, 'attempt-2'), { recursive: true })
    await writeFile(join(results, 'attempt-2', 'result.json'), JSON.stringify({ opId: 'op-2', status: 'passed', usage: { promptTokens: 12, completionTokens: 8 } }))
    await writeFile(join(results, 'garbage.json'), 'not json')
    const resumed = await resume(root, results)
    // op-2 settled from evidence…
    expect(resumed.reconciled).toHaveLength(1)
    expect(resumed.reconciled[0]).toMatchObject({ opId: 'op-2' })
    expect(resumed.reconciled[0].resultHash).toMatch(/^[a-f0-9]{64}$/)
    // …and only THEN was op-1 rolled back, retaining its envelope.
    expect(resumed.discarded).toEqual(['op-1'])
    const totals = await tokens(root)
    expect(totals.settledTokens).toBe(20)
    expect(totals.discardedChargeTokens).toBe(40)
    expect(totals.chargedTokens).toBe(60)
    // Replay is idempotent: a second resume changes nothing.
    const raw = await readFile(join(root, 'budget.json'), 'utf8')
    const again = await resume(root, results)
    expect(again.reconciled).toHaveLength(0)
    expect(again.discarded).toEqual([])
    expect(await readFile(join(root, 'budget.json'), 'utf8')).toBe(raw)
  })
})

describe('budget-ledger write discipline (§3.3)', () => {
  it('every mutation is a whole-file atomic write: a failed rename leaves the previous file byte-identical and no temp files behind', async () => {
    const root = await makeRun()
    await reserve(root, { opId: 'op-1', envelopeTokens: 10 })
    const before = await readFile(join(root, 'budget.json'), 'utf8')
    const fs = await import('node:fs/promises')
    const failingIo = { ...fs, rename: async () => { throw new Error('boom') } }
    await expect(reserve(root, { opId: 'op-2', envelopeTokens: 10 }, { io: failingIo as never })).rejects.toThrow('boom')
    expect(await readFile(join(root, 'budget.json'), 'utf8')).toBe(before)
    const leftovers = (await readdir(root)).filter(name => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('init-run (§9.1 skeleton)', () => {
  it('creates the run directory with the strict schema materialized and budget initialized', async () => {
    const root = await roots.make('mrh-initrun-')
    const result = await initRun(root, 'run-2026-11-21-a', { goal: 'prove something', createdAt: isoNow(), budget: { attempts: 4, tokens: 50000, wallClockMs: 600000 } })
    expect(result.status).toBe('ok')
    const manifest = JSON.parse(await readFile(join(root, 'run-2026-11-21-a', 'run-manifest.json'), 'utf8'))
    expect(manifest.budget).toEqual({ attempts: 4, tokens: 50000, wallClockMs: 600000 })
    expect(manifest.allowHumanFidelity).toBe(false)
    expect(manifest.tierPolicy).toBe('main')
    expect(manifest.discovery).toBeNull()
    for (const rel of ['problems', 'population', 'evidence', 'claims.jsonl', 'budget.json', 'report.md']) {
      await expect(readFile(join(root, 'run-2026-11-21-a', rel), 'utf8').catch(() => readdir(join(root, 'run-2026-11-21-a', rel)))).resolves.toBeDefined()
    }
    const budget = JSON.parse(await readFile(join(root, 'run-2026-11-21-a', 'budget.json'), 'utf8'))
    expect(budget.cap.tokens).toBe(50000)
    await expect(initRun(root, 'run-2026-11-21-a', { goal: 'x' })).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('rejects unknown manifest fields (strict schema parity with math-eval)', async () => {
    const root = await roots.make('mrh-initrun-')
    await expect(initRun(root, 'run-b', { goal: 'g', createdAt: isoNow(), bogus: 1 } as never)).rejects.toMatchObject({ code: 'config-invalid' })
  })
})
