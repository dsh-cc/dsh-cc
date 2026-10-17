/**
 * Slice-5 turn-end integration spec (§16/§16.2/§17.3, D15/D16/D17/D20/D22):
 * the v2 receipt write path (discriminated union on the SAME session
 * ledger), the bound-artifact turn-end branch with a fake
 * VwaArgumentDeliveryProvider, the closed nudge trigger (never-run/pending →
 * abstained + no nudge), the SHARED nudge budget across v1+v2, and v1-reader
 * compatibility (D20/D17/D22).
 * @module tests/delivery
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { createEvaluatorState, evaluateTurnStopping, type EvaluatorState } from '../src/evaluator.ts'
import { isWhitelistedRel } from '../src/verify.ts'
import {
  sha256Hex,
  nudgeBudgetConsumed,
  receiptHashOf,
  receiptLedgerPath,
  staleAgainst,
  type ReceiptV2,
} from '../src/receipt.ts'
import {
  buildReceiptV2,
  deliveryState,
  overallOf,
  readCurrentProject,
  resolveDeliveryProvider,
  type DeliveryCheckLike,
  type VwaArgumentDeliveryProvider,
} from '../src/vwa-delivery.ts'
import { DEFAULT_VWA_EVIDENCE_SETTINGS, type VwaEvidenceSettings } from '../src/settings.ts'
import type { Executor } from '../src/gates.ts'

const roots: string[] = []
const homes: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const passExec: Executor = async () => ({ code: 0, stdout: '', stderr: '' })

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vwa-dlv-'))
  roots.push(root)
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'a.md'), '# A\nbody\n', 'utf8')
  return root
}

function userEvent(): EvalEvent {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } }
}

function assistantEvent(turn: number): EvalEvent {
  return { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'done' }] } } }
}

/** A minimal consistent DeliveryCheckLike fixture. */
function makeCheck(overrides: Partial<DeliveryCheckLike> = {}): DeliveryCheckLike {
  return {
    artifactId: 'art_' + '1'.repeat(32),
    artifactHash: 'a'.repeat(64),
    projectRevision: 3,
    graphHash: 'b'.repeat(64),
    dependencyDigest: 'c'.repeat(64),
    policyHash: 'd'.repeat(64),
    reviewerConfigHash: 'e'.repeat(64),
    checks: { mechanical: 'pass', evidence: 'pass', argument: 'pass', audit: 'pass' },
    metrics: { mappedAtomicClaims: 2, extractedAtomicClaims: 2, reviewedCoreClaims: 1, coreClaims: 1 },
    assessments: [],
    findings: [],
    reviewRunIds: ['run_' + '2'.repeat(32)],
    pendingRunIds: [],
    sources: [{ sourceId: 'src_' + '3'.repeat(32), snapshotHash: 'f'.repeat(64), evidenceIds: [] }],
    eligibleForReviewed: true,
    findingCounts: { blocker: 0, major: 0, minor: 0 },
    ...overrides,
  }
}

/** Fake provider over an in-memory check + injected failure modes. */
function fakeProvider(input: {
  check: DeliveryCheckLike
  failCheckWith?: Error
  reportText?: string
}): VwaArgumentDeliveryProvider {
  let calls = 0
  return {
    listBoundArtifacts: () => [{ artifactId: input.check.artifactId, path: 'docs/a.md' }],
    checkForDelivery: async () => {
      calls += 1
      if (input.failCheckWith !== undefined) throw input.failCheckWith
      return { evaluationId: `eval_${calls}`, bindingDigest: 'd'.repeat(64), check: input.check }
    },
    renderReport: async () => ({
      text: input.reportText ?? '# report\n',
      reportHash: sha256Hex(input.reportText ?? '# report\n'),
      bindingDigest: 'd'.repeat(64),
    }),
  }
}

interface Env {
  root: string
  home: string
  settings: VwaEvidenceSettings
  state: ReturnType<typeof createEvaluatorState>
  debug: string[]
}

async function env(): Promise<Env> {
  const root = await workspace()
  const home = await mkdtemp(join(tmpdir(), 'vwa-dlv-home-'))
  homes.push(home)
  return { root, home, settings: { ...DEFAULT_VWA_EVIDENCE_SETTINGS }, state: createEvaluatorState(), debug: [] }
}

async function bindProject(root: string, projectId = 'prj_' + '9'.repeat(32)): Promise<string> {
  await mkdir(join(root, '.dsh', 'vwa'), { recursive: true })
  await writeFile(
    join(root, '.dsh', 'vwa', 'current-project.json'),
    JSON.stringify({ schemaVersion: 1, projectId, workspaceIdentity: 'x'.repeat(64) }),
    'utf8',
  )
  return projectId
}

async function runTurn(
  e: Env,
  events: EvalEvent[],
  provider?: VwaArgumentDeliveryProvider,
  turn = 1,
): Promise<{ outcome: any; injected: any[] }> {
  const injected: any[] = []
  const agent = {
    session: { header: { id: 'sess' }, snapshotEvents: () => events },
    inject: (message: unknown) => injected.push(message),
  }
  const { evaluateTurnStopping } = await import('../src/evaluator.ts')
  const outcome = await evaluateTurnStopping({
    agent,
    turn,
    settings: e.settings,
    workspaceRoot: e.root,
    exec: passExec,
    dshHome: e.home,
    state: e.state,
    debug: (m) => e.debug.push(m),
    deliveryProvider: provider,
  })
  return { outcome, injected }
}

async function v2Rows(home: string): Promise<ReceiptV2[]> {
  try {
    return ((await readJsonl<unknown>(receiptLedgerPath(home, 'sess'))) as unknown[]).filter(
      (row) => (row as { v?: unknown }).v === 2,
    ) as ReceiptV2[]
  } catch {
    return []
  }
}

describe('v2 receipt write path (§16.1, D15)', () => {
  it('writes a v:2 row to the SAME ledger and read-backs (receiptId, receiptHash)', async () => {
    const e = await env()
    await bindProject(e.root)
    const check = makeCheck()
    const { outcome } = await runTurn(e, [userEvent(), assistantEvent(1)], fakeProvider({ check }))
    expect(outcome.action).toBe('receipts')
    const rows = await v2Rows(e.home)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.overall).toBe('pass')
    expect(receiptHashOf(rows[0]!)).toHaveLength(64)
    // The ledger holds exactly one line: the v2 write altered no v1 bytes.
    const raw = await readFile(receiptLedgerPath(e.home, 'sess'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })
  it('a failed write is identified; the OLD row is not mistaken for current (D15)', async () => {
    const e = await env()
    const projectId = await bindProject(e.root)
    const check = makeCheck()
    const { appendJsonl } = await import('@dsh-cc/sidecar-io')
    const ledger = receiptLedgerPath(e.home, 'sess')
    const oldRow = buildReceiptV2({
      sessionId: 'sess',
      ts: 1,
      receiptId: 'rec_' + '1'.repeat(32),
      projectId,
      artifactPath: join(e.root, 'docs/a.md'),
      events: [],
      workspaceRoot: e.root,
      parentHash: '',
      report: { path: '.dsh/vwa/x/reports/a.md', hash: 'r'.repeat(64) },
      check,
      neverRun: false,
    })
    await appendJsonl(ledger, JSON.parse(JSON.stringify(oldRow)))
    // Simulated write failure: the ledger FILE becomes unwritable, so the
    // new append cannot land (appendJsonl swallows the error) and the
    // read-back must not present the OLD row (different receiptId/hash) as
    // the current receipt.
    await chmod(ledger, 0o444)
    try {
      const { outcome } = await runTurn(e, [userEvent(), assistantEvent(1)], fakeProvider({ check }))
      expect(outcome.receipts).toBe(0)
      expect(e.debug.some((line) => line.includes('v2 receipt read-back failed'))).toBe(true)
    } finally {
      await chmod(ledger, 0o644)
    }
    const rows = await v2Rows(e.home)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.receiptId).toBe(oldRow.receiptId)
  })
})

describe('bound turn-end integration (§16.2)', () => {
  it('report rendering failure writes no success receipt', async () => {
    const e = await env()
    await bindProject(e.root)
    const provider = fakeProvider({ check: makeCheck() })
    provider.renderReport = async () => {
      throw new Error('report unavailable')
    }
    const { outcome } = await runTurn(e, [userEvent(), assistantEvent(1)], provider)
    expect(outcome.receipts).toBe(0)
    expect(await v2Rows(e.home)).toHaveLength(0)
  })
  it('a failing bound artifact writes overall fail and nudges with targets + the suggested argument.review payload', async () => {
    const e = await env()
    await bindProject(e.root)
    const check = makeCheck({
      checks: { mechanical: 'fail', evidence: 'pass', argument: 'pass', audit: 'pass' },
      findings: [{ id: 'f_1', targetIds: [], severity: 'major', explanation: 'warrant overreaches' }],
      findingCounts: { blocker: 0, major: 1, minor: 0 },
      eligibleForReviewed: false,
    })
    const { outcome, injected } = await runTurn(e, [userEvent(), assistantEvent(1)], fakeProvider({ check }))
    expect(outcome.action).toBe('nudge')
    expect(outcome.nudged).toContain(check.artifactId)
    const text = JSON.stringify(injected[0])
    expect(text).toContain('argument.review')
    expect(text).toContain('f_1')
    const row = (await v2Rows(e.home))[0]
    expect(row?.overall).toBe('fail')
    expect(row?.nudge.round).toBe(1)
  })
  it('never-run reviews write overall abstained with NO nudge (§16.2)', async () => {
    const e = await env()
    await bindProject(e.root)
    const check = makeCheck({ reviewRunIds: [], eligibleForReviewed: false })
    const { outcome, injected } = await runTurn(e, [userEvent(), assistantEvent(1)], fakeProvider({ check }))
    expect(outcome.action).toBe('receipts')
    expect(injected).toHaveLength(0)
    const row = (await v2Rows(e.home))[0]
    expect(row?.overall).toBe('abstained')
    expect(row?.pendingRunIds).toBeUndefined()
  })
  it('pending runs write pendingRunIds and overall abstained with no nudge', async () => {
    const e = await env()
    await bindProject(e.root)
    const check = makeCheck({ pendingRunIds: ['run_' + '4'.repeat(32)], eligibleForReviewed: false })
    const { outcome, injected } = await runTurn(e, [userEvent(), assistantEvent(1)], fakeProvider({ check }))
    expect(outcome.action).toBe('receipts')
    expect(injected).toHaveLength(0)
    const row = (await v2Rows(e.home))[0]
    expect(row?.overall).toBe('abstained')
    expect(row?.pendingRunIds).toEqual(['run_' + '4'.repeat(32)])
  })
  it('a stale binding (D16: shell-written body) fires the stale nudge and claims no receipt', async () => {
    const e = await env()
    await bindProject(e.root)
    const provider = fakeProvider({
      check: makeCheck(),
      failCheckWith: new Error('artifact bytes changed after binding; re-bind and re-audit are required'),
    })
    const { outcome, injected } = await runTurn(e, [userEvent(), assistantEvent(1)], provider)
    expect(outcome.action).toBe('nudge')
    expect(JSON.stringify(injected[0])).toContain('STALE')
    // No frozen check ⇒ no receipt row claims the artifact.
    expect(await v2Rows(e.home)).toHaveLength(0)
  })
  it('the shared nudge budget counts v1 and v2 rounds together (§16.2)', async () => {
    const e = await env()
    e.settings['nudge-budget'] = 2
    await bindProject(e.root)
    // Two v1 rows with nudges = 2 already spent against a budget of 2: the
    // bound artifact's mechanical fail must NOT consume a third nudge.
    const ledger = receiptLedgerPath(e.home, 'sess')
    const v1 = (i: number) =>
      JSON.stringify({
        v: 1,
        ts: 1,
        sessionId: 'sess',
        artifactId: `a${i}`,
        artifactPath: `/w/a${i}.md`,
        artifactHash: 'h',
        claims: [],
        numbers: [],
        gates: [],
        provenance: { inputs: [], parentHash: '' },
        overall: 'fail',
        nudge: { round: 1 },
      })
    await mkdir(join(e.home, 'vwa-receipts'), { recursive: true })
    await writeFile(ledger, `${v1(1)}\n${v1(2)}\n`, 'utf8')
    const rows = (await readJsonl<unknown>(ledger)) as never[]
    expect(nudgeBudgetConsumed(rows as never)).toBe(2)
    const check = makeCheck({
      checks: { mechanical: 'fail', evidence: 'pass', argument: 'pass', audit: 'pass' },
      eligibleForReviewed: false,
    })
    const { outcome, injected } = await runTurn(e, [userEvent(), assistantEvent(1)], fakeProvider({ check }))
    expect(outcome.action).toBe('receipts')
    expect(injected).toHaveLength(0)
    // The failing row is still WRITTEN (overall fail, round 0).
    const row = (await v2Rows(e.home))[0]
    expect(row?.overall).toBe('fail')
    expect(row?.nudge.round).toBe(0)
  })
})

describe('v1 reader compatibility (§16.1, D17/D20/D22)', () => {
  it('staleAgainst skips v2 rows; nudgeBudgetConsumed counts both versions (D20)', () => {
    const path = '/w/a.md'
    const v1row = {
      v: 1,
      ts: 1,
      sessionId: 's',
      artifactId: 'a',
      artifactPath: path,
      artifactHash: 'old',
      claims: [],
      numbers: [],
      gates: [],
      provenance: { inputs: [], parentHash: '' },
      overall: 'fail',
      nudge: { round: 1 },
    }
    const v2row = buildReceiptV2({
      sessionId: 's',
      ts: 2,
      receiptId: 'rec_' + '5'.repeat(32),
      projectId: 'prj_' + '9'.repeat(32),
      artifactPath: path,
      events: [],
      workspaceRoot: '/w',
      parentHash: '',
      report: { path: '.dsh/x.md', hash: 'r'.repeat(64) },
      check: makeCheck({ artifactHash: 'new' }),
      neverRun: false,
    })
    v2row.nudge.round = 1
    // The v1 staleness face ignores v2 rows entirely (§16.1): the v1 row
    // ('old') still governs staleness against the CURRENT bytes.
    expect(staleAgainst([v1row, v2row], path, 'old')).toBe(false)
    expect(staleAgainst([v1row, v2row], path, 'changed')).toBe(true)
    // The SHARED budget counts both.
    expect(nudgeBudgetConsumed([v1row, v2row])).toBe(2)
  })
  it('D17-full: the mechanical mapping lands in checks.mechanical verbatim (style not-run, exec inapplicable)', () => {
    expect(
      overallOf(
        makeCheck({ checks: { mechanical: 'not-run', evidence: 'pass', argument: 'pass', audit: 'pass' } }),
        false,
      ),
    ).toBe('abstained')
    expect(
      overallOf(
        makeCheck({ checks: { mechanical: 'inapplicable', evidence: 'pass', argument: 'pass', audit: 'pass' } }),
        false,
      ),
    ).toBe('pass')
    const row = buildReceiptV2({
      sessionId: 's',
      ts: 1,
      receiptId: 'rec_' + '6'.repeat(32),
      projectId: 'prj_' + '9'.repeat(32),
      artifactPath: '/w/a.md',
      events: [],
      workspaceRoot: '/w',
      parentHash: '',
      report: { path: '.dsh/x', hash: 'r'.repeat(64) },
      check: makeCheck({ checks: { mechanical: 'inapplicable', evidence: 'pass', argument: 'pass', audit: 'pass' } }),
      neverRun: false,
    })
    expect(row.checks.mechanical).toBe('inapplicable')
  })
  it('D22: runtime output trees are outside the lane-1 whitelist (no self-referential capture)', () => {
    expect(isWhitelistedRel('.dsh/vwa/prj_x/reports/a.md')).toBe(false)
    expect(isWhitelistedRel('.dsh/vwa/current-project.json')).toBe(false)
    expect(isWhitelistedRel('docs/vwa-sources/x/y.md')).toBe(true)
  })
  it('delivery states follow §17.3: only the real presented event advances; otherwise delivery unconfirmed', () => {
    const base = {
      workspaceRoot: '/w',
      events: [] as unknown[],
      artifactPath: '/w/a.md',
      artifactHash: 'h'.repeat(64),
      reportPath: '.dsh/vwa/p/reports/a.md',
      reportHash: 'r'.repeat(64),
    }
    expect(deliveryState({ ...base, eligibleForReviewed: true })).toBe('reviewed')
    expect(deliveryState({ ...base, eligibleForReviewed: false })).toBe('draft')
  })
  it('the provider resolves duck-typed, bound to the caller workspace, and stays absent without the service (§3 cycle-break)', () => {
    expect(resolveDeliveryProvider(undefined, '/w')).toBeUndefined()
    expect(resolveDeliveryProvider({ get: () => ({}) }, '/w')).toBeUndefined()
    const provider = fakeProvider({ check: makeCheck() })
    // A bare provider (no forWorkspace host face) is not the published service.
    expect(resolveDeliveryProvider({ get: () => provider }, '/w')).toBeUndefined()
    const roots: string[] = []
    const host = {
      forWorkspace: (root: string) => {
        roots.push(root)
        return provider
      },
    }
    expect(resolveDeliveryProvider({ get: () => host }, '/w')).toBe(provider)
    expect(roots).toEqual(['/w'])
  })
  it('the pointer is fail-soft: corrupt/missing means no bound lane-2 turn', async () => {
    const e = await env()
    expect(readCurrentProject(e.root)).toBeUndefined()
    await mkdir(join(e.root, '.dsh', 'vwa'), { recursive: true })
    await writeFile(join(e.root, '.dsh/vwa/current-project.json'), 'not json', 'utf8')
    expect(readCurrentProject(e.root)).toBeUndefined()
  })
})
