/**
 * Acceptance judge + escalation tests — UNIT layer (design §3.3/§3.4/§3.5,
 * §8 rows): eligibility gate (both turn kinds, ceiling, masterplan), act vs
 * shadow, accept path, in-flight reservation, stale-result guard (genuine
 * user message, /model change with switch-back, fork), followup provenance.
 *
 * Driven through the production judge listener with a fake agent/session
 * (scripted session events) and a canned System One `fetchImpl`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createOpeningCapture } from '../src/capture.ts'
import { createAcceptanceJudge, type JudgeDeps } from '../src/judge.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore, type MoaSettings } from '../src/index.ts'
import { GAUGE_ROUTE, routes as tierRoutes, userOpening } from './rig.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moa-judge-'))
  dirs.push(dir)
  return dir
}

/** Scriptable session-log view (id mutable for the fork guard). */
interface FakeSession {
  events: { seq: number; type: string; data: Record<string, unknown> }[]
  id: string
  seq: number
}

interface UnitRig {
  judge: ReturnType<typeof createAcceptanceJudge>
  session: FakeSession
  followed: { text: string; source: unknown }[]
  acceptStates: string[]
  deferred: { resolve: () => void } | undefined
  routingLedger: string
  acceptanceLedger: string
  bookkeeping: EscalationBookkeeping
  /** Seed the pre-step capture for a turn. */
  seed: (turn: number, messages: unknown[]) => Promise<void>
  /** Fire the turn-stopping listener for a turn. */
  stop: (turn: number) => void
}

interface UnitOptions {
  acceptanceEnabled?: boolean
  shadow?: boolean
  tau?: number
  maxEscalations?: number
  /** P(acceptable) the canned judge returns (default 0.2 = reject). */
  pAccept?: number
  /** The tier the judged turn ran on (router's tierFor). */
  tier?: number
  /** Hold the first judge call until `deferred.resolve()` (stale-guard tests). */
  holdJudge?: boolean
}

function makeUnitRig(options: UnitOptions = {}): UnitRig {
  const settings: MoaSettings = {
    ...DEFAULT_MOA_SETTINGS,
    enabled: true,
    acceptance: {
      enabled: options.acceptanceEnabled ?? true,
      shadow: options.shadow ?? false,
      tau: options.tau ?? 0.7,
    },
    maxEscalations: options.maxEscalations ?? 1,
  }
  const arming = new ArmingMachine(() => settings.enabled)
  arming.arm()
  const bookkeeping = new EscalationBookkeeping()
  const core: MoaCore = { readSettings: () => settings, arming, bookkeeping }
  const capture = createOpeningCapture()
  const session: FakeSession = { events: [], id: 'session-1', seq: 0 }
  const followed: { text: string; source: unknown }[] = []
  const acceptStates: string[] = []
  let deferred: UnitRig['deferred']
  let held: Promise<void> | undefined
  const routingLedger = join(tempDir(), 'routing.jsonl')
  const acceptanceLedger = join(tempDir(), 'acceptance.jsonl')

  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: string }
    if (!('accept' in body.questions)) {
      return new Response(JSON.stringify({ model: 'x', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
    }
    acceptStates.push((body as { state: string }).state)
    if (options.holdJudge === true) {
      if (held === undefined) {
        let resolve!: () => void
        held = new Promise<void>((r) => (resolve = r))
        deferred = { resolve }
      }
      await held
    }
    const p = options.pAccept ?? 0.2
    return new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { accept: { type: 'choice', choice: 'acceptable', probabilities: { acceptable: p, unacceptable: 1 - p } } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      { status: 200 },
    )
  }
  const deps: JudgeDeps = {
    getCapturedOpening: (turnId) => capture.getCapturedOpening(turnId),
    tierFor: () => options.tier ?? 1,
    routes: () => tierRoutes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
    routingLedgerPath: () => routingLedger,
    acceptanceLedgerPath: () => acceptanceLedger,
  }
  const judge = createAcceptanceJudge(core, { validation: { ok: true }, deps })
  const fakeAgent = {
    session: {
      snapshotEvents: () => session.events,
      get seq() {
        return session.seq
      },
      get id() {
        return session.id
      },
    },
    followup: (message: { content: { type: string; text?: string }[]; source?: unknown }) => {
      followed.push({ text: (message.content ?? []).map((b) => b.text ?? '').join(''), source: message.source })
    },
  }
  return {
    judge,
    session,
    followed,
    acceptStates,
    get deferred() {
      return deferred
    },
    routingLedger,
    acceptanceLedger,
    bookkeeping,
    seed: async (turn, messages) => {
      await capture.listener({ messages, turn } as never, async () => ({}))
    },
    stop: (turn) => {
      judge.listener({ agent: fakeAgent, turn, signal: new AbortController().signal } as never)
    },
  }
}

/** Seed a completed turn's events: genuine user message + final answer. */
function seedTurn(rig: UnitRig, turn: number, text = 'go', answer = 'const d = 1') {
  const base = rig.session.events.length
  rig.session.events.push(
    { seq: base, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } },
    { seq: base + 1, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: answer }] } } },
  )
  rig.session.seq = rig.session.events.length
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Poll a JSONL ledger until it has `count` rows (async fs write race). */
async function readRows<T>(path: string, count: number): Promise<T[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await readJsonl<T>(path)
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readJsonl<T>(path)
}

describe('moa acceptance judge — unit', () => {
  it('act reject: below tau → typed followup (originSeq/fromTier/toTier, form notice) + bookkeeping + ledger rows', async () => {
    const rig = makeUnitRig()
    await rig.seed(1, [userOpening('write a debounce function')])
    seedTurn(rig, 1, 'write a debounce function')
    rig.stop(1)
    await flush()
    expect(rig.followed).toHaveLength(1)
    expect(rig.followed[0].source).toMatchObject({
      kind: 'moa-escalation',
      originSeq: 0,
      fromTier: 1,
      toTier: 2,
      form: 'notice',
    })
    expect(rig.followed[0].text).toBe('moa: draft → blueprint, first answer rejected by judge')
    expect(rig.bookkeeping.stateFor(0)).toEqual({ tierFloor: 2, retriesUsed: 1 })
    const judgeRows = await readRows<{ type: string; acted: boolean; pAcceptable: number; eligible: boolean; shadow: boolean; originSeq: number }>(rig.acceptanceLedger, 1)
    expect(judgeRows).toEqual([
      expect.objectContaining({ type: 'judge', acted: true, pAcceptable: 0.2, eligible: true, shadow: false, originSeq: 0 }),
    ])
    const escalateRows = await readRows<{ type: string; originSeq: number; fromTier: number; toTier: number }>(rig.routingLedger, 1)
    expect(escalateRows).toEqual([expect.objectContaining({ type: 'escalate', originSeq: 0, fromTier: 1, toTier: 2 })])
  }, 30_000)

  it('accept: P(acceptable) >= tau → no followup, judge row acted:false, NO escalate row', async () => {
    const rig = makeUnitRig({ pAccept: 0.9 })
    await rig.seed(1, [userOpening('go')])
    seedTurn(rig, 1)
    rig.stop(1)
    await flush()
    expect(rig.followed).toHaveLength(0)
    const judgeRows = await readRows<{ acted: boolean }>(rig.acceptanceLedger, 1)
    expect(judgeRows[0].acted).toBe(false)
    const escalateRows = await readRows<unknown>(rig.routingLedger, 0)
    expect(escalateRows).toHaveLength(0)
  }, 30_000)

  it('eligibility (act): tool turn → judge never called; retries exhausted → no call; masterplan tier → no call', async () => {
    const toolTurn = makeUnitRig()
    await toolTurn.seed(1, [userOpening('edit files')])
    seedTurn(toolTurn, 1, 'edit files')
    toolTurn.session.events.push({ seq: toolTurn.session.events.length, type: 'tool/call', data: { turn: 1, name: 'edit', arguments: '{}' } })
    toolTurn.session.seq = toolTurn.session.events.length
    toolTurn.stop(1)
    await flush()
    expect(toolTurn.acceptStates).toHaveLength(0) // §3.3 wasted-spend gate

    const exhausted = makeUnitRig()
    await exhausted.seed(1, [userOpening('go')])
    seedTurn(exhausted, 1)
    exhausted.bookkeeping.recordRetryUsed(0, 1, 2)
    exhausted.stop(1)
    await flush()
    expect(exhausted.acceptStates).toHaveLength(0)

    const ceiling = makeUnitRig({ tier: 3 })
    await ceiling.seed(1, [userOpening('plan it')])
    seedTurn(ceiling, 1, 'plan it')
    ceiling.stop(1)
    await flush()
    expect(ceiling.acceptStates).toHaveLength(0) // hard ceiling: masterplan
  }, 30_000)

  it('shadow: judge called on TOOL turns too (eligible:false) and on effect-free turns (eligible:true); never acts', async () => {
    const toolTurn = makeUnitRig({ acceptanceEnabled: false, shadow: true })
    await toolTurn.seed(1, [userOpening('edit files')])
    seedTurn(toolTurn, 1, 'edit files')
    toolTurn.session.events.push({ seq: toolTurn.session.events.length, type: 'tool/call', data: { turn: 1, name: 'edit', arguments: '{}' } })
    toolTurn.session.seq = toolTurn.session.events.length
    toolTurn.stop(1)
    await flush()
    expect(toolTurn.acceptStates).toHaveLength(1)
    expect(toolTurn.followed).toHaveLength(0)

    const free = makeUnitRig({ acceptanceEnabled: false, shadow: true })
    await free.seed(1, [userOpening('go')])
    seedTurn(free, 1)
    free.stop(1)
    await flush()
    expect(free.acceptStates).toHaveLength(1)
    const rows = await readRows<{ eligible: boolean; acted: boolean; shadow: boolean }>(free.acceptanceLedger, 1)
    expect(rows[0]).toMatchObject({ eligible: true, acted: false, shadow: true })
  }, 30_000)

  it('in-flight reservation: a second turn-end while the judge is pending dispatches no second call', async () => {
    const rig = makeUnitRig({ holdJudge: true })
    await rig.seed(1, [userOpening('go')])
    seedTurn(rig, 1)
    rig.stop(1)
    rig.stop(2) // second turn ends while the verdict is in flight
    await flush()
    expect(rig.acceptStates).toHaveLength(1)
    rig.deferred?.resolve()
  }, 30_000)

  it('stale guard (a): a new GENUINE user message during the judge call discards the verdict', async () => {
    const rig = makeUnitRig({ holdJudge: true })
    await rig.seed(1, [userOpening('go')])
    seedTurn(rig, 1)
    rig.stop(1)
    rig.session.events.push({ seq: rig.session.events.length, type: 'user/message', data: { content: [{ type: 'text', text: 'actually stop' }], source: { kind: 'user' } } })
    rig.session.seq = rig.session.events.length
    rig.deferred?.resolve()
    await flush()
    expect(rig.followed).toHaveLength(0)
  }, 30_000)

  it('stale guard (b): a /model change discards the verdict even after switching back to boot default (critic r2)', async () => {
    const rig = makeUnitRig({ holdJudge: true })
    await rig.seed(1, [userOpening('go')])
    seedTurn(rig, 1)
    rig.stop(1)
    // /model away…
    rig.session.events.push({ seq: rig.session.events.length, type: 'request/header', data: { reason: 'change', header: { config: { provider: 'mock', model: 'custom' } } } })
    // …and back to the boot default: the 'change' events STAY in the log.
    rig.session.events.push({ seq: rig.session.events.length, type: 'request/header', data: { reason: 'change', header: { config: { provider: 'mock', model: 'mock' } } } })
    rig.session.seq = rig.session.events.length
    rig.deferred?.resolve()
    await flush()
    expect(rig.followed).toHaveLength(0)
  }, 30_000)

  it('stale guard (c): a session fork (session identity change) discards the verdict', async () => {
    const rig = makeUnitRig({ holdJudge: true })
    await rig.seed(1, [userOpening('go')])
    seedTurn(rig, 1)
    rig.stop(1)
    rig.session.id = 'session-2-forked'
    rig.deferred?.resolve()
    await flush()
    expect(rig.followed).toHaveLength(0)
  }, 30_000)
})
