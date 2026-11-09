import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as commandCost from '@dsh-cc/command-cost'
import {
  dedupeDecisionRows,
  foldDecisionUsage,
  readDecisionCostSection,
  type DecisionCostRow,
} from '@dsh-cc/command-cost'
import { formatCostReport } from '@dsh-cc/command-cost/cost'
import type { ModelPrice } from '@dsh-cc/command-cost/cost'
import { appendDecisionRow, decisionUsageDir, usageFilePath } from '@dsh-cc/decision-usage'
import { projectKeyOf } from '@dsh-cc/sidecar-io'

/** Two priced models: input $1/MTok, output $2/MTok; model-b is 10x model-a. */
const TABLE: readonly ModelPrice[] = [
  { model: 'model-a', provider: 'deepseek', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
  { model: 'model-b', provider: 'deepseek', inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
]

const SCOPE = { projectKey: 'project-key-1', sessionId: 'session-1', agentId: 'agent-1', originSeq: 3 }

interface RowInit {
  readonly eventId: string
  readonly decisionId?: string
  readonly attempt?: number
  readonly phase?: DecisionCostRow['phase']
  readonly outcome?: DecisionCostRow['outcome']
  readonly requestedModel?: string
  readonly actualModel?: string | null
  readonly reserved?: readonly [number, number]
  readonly actual?: readonly [number, number]
  readonly reasonCode?: DecisionCostRow['reasonCode']
}

/** Build one schemaVersion=1 ledger row with only the fields the phase/outcome require. */
function ledgerRow(init: RowInit): DecisionCostRow {
  return {
    schemaVersion: 1,
    eventId: init.eventId,
    decisionId: init.decisionId ?? 'decision-1',
    attempt: init.attempt ?? 0,
    phase: init.phase ?? 'reserve',
    time: 1_700_000_000_000,
    scope: SCOPE,
    feature: 'memory-recall',
    mode: 'active',
    provider: 'deepseek',
    requestedModel: init.requestedModel ?? 'deepseek-chat',
    actualModel: init.actualModel ?? null,
    routeRevision: 'rev-1',
    questionVersion: 'q-1',
    policyVersion: 'p-1',
    inputHash: 'hash-1',
    latencyMs: 5,
    outcome: init.outcome ?? 'reserved',
    ...(init.reserved === undefined
      ? {}
      : { reservedInputTokens: init.reserved[0], reservedOutputTokens: init.reserved[1] }),
    ...(init.actual === undefined
      ? {}
      : { actualInputTokens: init.actual[0], actualOutputTokens: init.actual[1] }),
    ...(init.reasonCode === undefined ? {} : { reasonCode: init.reasonCode }),
  }
}

/** A full reserve → dispatch → settle(actual) attempt for one decision. */
function settledAttempt(
  id: string,
  reserved: readonly [number, number],
  actual: readonly [number, number],
  actualModel: string,
  attempt = 0,
  decisionId = 'decision-1',
): DecisionCostRow[] {
  return [
    ledgerRow({ eventId: `${id}-reserve`, decisionId, attempt, reserved }),
    ledgerRow({ eventId: `${id}-dispatch`, decisionId, attempt, phase: 'dispatch', outcome: 'dispatched' }),
    ledgerRow({
      eventId: `${id}-settle`,
      decisionId,
      attempt,
      phase: 'settle',
      outcome: 'actual',
      reserved,
      actual,
      actualModel,
    }),
  ]
}

/** Fold only, with a healthy ledger. */
function fold(rows: readonly DecisionCostRow[]) {
  return foldDecisionUsage({ rows, tornTail: false, corruptLines: [] }, TABLE)
}

/** Render one report with a decision section on top of an empty generative fold. */
function render(rows: readonly DecisionCostRow[]): string {
  const decisions = fold(rows)
  expect(decisions).toBeDefined()
  return formatCostReport({ perModel: [], totalUsd: 0, decisions })
}

const created: string[] = []

/** A fresh temporary dsh home. */
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'command-cost-decisions-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('/cost SystemOne decisions fold', () => {
  it('deduplicates rows by eventId and keeps the first occurrence', async () => {
    const rows = [
      ...settledAttempt('a', [1000, 100], [400, 40], 'model-a'),
      // A duplicated settle line for the SAME event: crash-retry replay.
      ledgerRow({
        eventId: 'a-settle',
        phase: 'settle',
        outcome: 'actual',
        reserved: [1000, 100],
        actual: [9000, 900],
        actualModel: 'model-a',
      }),
    ]
    expect(dedupeDecisionRows(rows)).toHaveLength(3)
    const decisions = fold(rows)
    expect(decisions).toBeDefined()
    expect(decisions?.attemptsUsed).toBe(1)
    expect(decisions?.perModel).toHaveLength(1)
    // First occurrence wins: the replayed duplicate never re-charges.
    expect(decisions?.perModel[0]).toMatchObject({
      provider: 'deepseek',
      model: 'model-a',
      attempts: 1,
      inputTokens: 400,
      outputTokens: 40,
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      priced: true,
    })
    expect(decisions?.perModel[0]?.costUsd).toBeCloseTo((400 * 1 + 40 * 2) / 1_000_000, 9)
    expect(decisions?.incomplete).toBe(false)

    // The same evidence written as JSONL folds identically (path derivation matches the writer).
    const home = await tempHome()
    const file = usageFilePath(decisionUsageDir(home, SCOPE.projectKey, SCOPE.sessionId))
    for (const row of rows) await appendDecisionRow(file, row)
    const fromDisk = await readDecisionCostSection(
      () => home,
      { projectKey: SCOPE.projectKey, sessionId: SCOPE.sessionId },
      TABLE,
    )
    expect(fromDisk?.attemptsUsed).toBe(1)
    expect(fromDisk?.perModel[0]?.inputTokens).toBe(400)
  })

  it('shows an unpriced model as unpriced, never as $0', () => {
    const rows = settledAttempt('a', [1000, 100], [500, 50], 'model-without-a-row')
    const decisions = fold(rows)
    expect(decisions?.perModel[0]).toMatchObject({ model: 'model-without-a-row', priced: false, costUsd: 0 })
    expect(decisions?.hasUnpriced).toBe(true)
    expect(decisions?.confirmedUsd).toBe(0)
    const text = render(rows)
    expect(text).toContain('Confirmed cost: unpriced (no price column configured)')
    expect(text).not.toContain('Confirmed cost: $0.00')
    expect(text).toContain('Unpriced:')
    // An unpriced bucket keeps the grand total from claiming an exact figure.
    expect(text).toContain('Grand total: incomplete')
    expect(text).not.toContain('Grand total (confirmed)')
  })

  it('reports unknown usage as a reserved upper bound outside the confirmed subtotal', () => {
    const rows = [
      ledgerRow({ eventId: 'a-reserve', reserved: [800, 80] }),
      ledgerRow({ eventId: 'a-dispatch', phase: 'dispatch', outcome: 'dispatched' }),
      ledgerRow({ eventId: 'a-settle', phase: 'settle', outcome: 'unknown', reserved: [800, 80] }),
    ]
    const decisions = fold(rows)
    expect(decisions?.perModel[0]).toMatchObject({
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      reservedInputTokens: 800,
      reservedOutputTokens: 80,
    })
    expect(decisions?.hasUnconfirmed).toBe(true)
    expect(decisions?.confirmedUsd).toBe(0)
    const text = render(rows)
    expect(text).toContain('Reserved upper bound, unconfirmed: 800 input + 80 output')
    expect(text).toContain('Confirmed subtotal (SystemOne decisions): $0.00')
    expect(text).toContain('Grand total: incomplete')
  })

  it('counts a valid 0-token response as confirmed usage', () => {
    const rows = settledAttempt('a', [1000, 100], [0, 0], 'model-a')
    const decisions = fold(rows)
    expect(decisions?.perModel[0]).toMatchObject({
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      reservedInputTokens: 0,
      priced: true,
      costUsd: 0,
    })
    expect(decisions?.hasUnconfirmed).toBe(false)
    const text = render(rows)
    expect(text).toContain('Confirmed: 0 input + 0 output')
    expect(text).toContain('Confirmed cost: $0.00')
    expect(text).toContain('Grand total (confirmed): $0.00')
  })

  it('keeps one bucket per actualModel across rows', () => {
    const rows = [
      ...settledAttempt('a', [1000, 100], [500, 50], 'model-a', 0),
      ...settledAttempt('b', [2000, 200], [300, 30], 'model-b', 1),
    ]
    const decisions = fold(rows)
    expect(decisions?.perModel).toHaveLength(2)
    expect(decisions?.perModel.map(model => model.model)).toEqual(['model-a', 'model-b'])
    expect(decisions?.attemptsUsed).toBe(2)
    const modelA = decisions?.perModel[0]
    const modelB = decisions?.perModel[1]
    expect(modelA?.costUsd).toBeCloseTo((500 * 1 + 50 * 2) / 1_000_000, 9)
    expect(modelB?.costUsd).toBeCloseTo((300 * 10 + 30 * 20) / 1_000_000, 9)
    expect(decisions?.confirmedUsd).toBeCloseTo((modelA?.costUsd ?? 0) + (modelB?.costUsd ?? 0), 12)
    const text = render(rows)
    expect(text).toContain('Grand total (confirmed)')
  })

  it('marks a frozen, torn ledger incomplete and never prints an exact total', () => {
    const rows = [
      ...settledAttempt('a', [1000, 100], [400, 40], 'model-a'),
      ledgerRow({ eventId: 'freeze', phase: 'outcome', outcome: 'answered', reasonCode: 'torn-tail' }),
    ]
    const decisions = foldDecisionUsage({ rows, tornTail: true, corruptLines: [7, 8] }, TABLE)
    expect(decisions?.incomplete).toBe(true)
    expect(decisions?.incompleteReasons).toHaveLength(3)
    expect(decisions?.incompleteReasons.join(' ')).toContain('torn')
    expect(decisions?.incompleteReasons.join(' ')).toContain('2 corrupt ledger line(s)')
    expect(decisions?.incompleteReasons.join(' ')).toContain('frozen (torn-tail)')
    const text = formatCostReport({ perModel: [], totalUsd: 0, decisions })
    expect(text).toContain('SystemOne decisions')
    expect(text).toContain('Incomplete:')
    expect(text).toContain('Grand total: incomplete')
    expect(text).toContain('No exact total cost is available.')
    expect(text).not.toContain('Grand total (confirmed)')
  })

  it('omits the section when the ledger directory is missing and never throws', async () => {
    const home = await tempHome()
    const absent = { projectKey: SCOPE.projectKey, sessionId: 'session-without-ledger' }
    await expect(readDecisionCostSection(() => home, absent, TABLE)).resolves.toBeUndefined()
    // A home root that does not exist at all degrades the same way.
    await expect(readDecisionCostSection(() => join(home, 'nope'), absent, TABLE)).resolves.toBeUndefined()
    // Missing host facts (no home resolver) never throw either.
    await expect(readDecisionCostSection(undefined, absent, TABLE)).resolves.toBeUndefined()
    // Corruption is reported even when no valid row survives (hidden rows would lie).
    const dir = mkdtemp(join(tmpdir(), 'command-cost-corrupt-')).then(async (base) => {
      created.push(base)
      const target = decisionUsageDir(base, 'pk-corrupt', 'session-corrupt')
      await mkdir(target, { recursive: true })
      await writeFile(usageFilePath(target), '{"schemaVersion":1,"eventId":"x"}\n', 'utf8')
      return base
    })
    const corruptHome = await dir
    const corrupt = await readDecisionCostSection(
      () => corruptHome,
      { projectKey: 'pk-corrupt', sessionId: 'session-corrupt' },
      TABLE,
    )
    expect(corrupt?.perModel).toHaveLength(0)
    expect(corrupt?.incomplete).toBe(true)
    expect(corrupt?.incompleteReasons.join(' ')).toContain('corrupt ledger line')
  })
})

describe('/cost command with a decision ledger', () => {
  it('renders the SystemOne decisions section for the invocation session', async () => {
    const home = await tempHome()
    const cwd = '/tmp/command-cost-decision-project'
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
    const plugin = await ctx.plugin(commandCost, { modelTable: TABLE })
    const session = ctx.sessions.create(SessionId(`decision-cost-${Math.random()}`), { meta: { cwd } })
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' { return 'idle' },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)

    const file = usageFilePath(
      decisionUsageDir(home, projectKeyOf(resolve(cwd)), String(session.id)),
    )
    for (const row of settledAttempt('a', [1000, 100], [400, 40], 'model-a')) {
      await appendDecisionRow(file, { ...row, scope: { ...SCOPE, projectKey: projectKeyOf(resolve(cwd)), sessionId: String(session.id) } })
    }

    const execution = await ctx.commands.execute(agent, '/cost', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('SystemOne decisions')
    expect(text).toContain('deepseek/model-a')
    expect(text).toContain('Attempts: 1')
    expect(text).toContain('Confirmed: 400 input + 40 output')
    expect(text).toContain('Confirmed subtotal (SystemOne decisions): $0.00')

    await plugin.dispose()
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandCost)).toBe(commandCost)
  })
})
