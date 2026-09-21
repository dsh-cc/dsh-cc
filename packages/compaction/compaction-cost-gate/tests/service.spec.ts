/**
 * Unit specs for the CompactionCostGate service (design §3.4/§3.5): the
 * two-seam split, root-session latch and subagent scoping, shadow-aware
 * surface summation, breaker class matrix, cooldown, dry-run, and the
 * absent-compaction inactivation. The PostToolDecision pass-through type is
 * pinned by the composition spec against the real tool runtime.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  CompactionEngine,
  ManualCompactionError,
  compactCheckpointSource,
  CompactionId,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { setCompactHint, takeCompactHint } from '@dsh-cc/compaction-basic'
import CompactionCostGate from '../src/index.ts'
import { CostGateLedger, projectKeyOf } from '../src/ledger.ts'
import type { CostGateSettings } from '../src/types.ts'

/** A fixed-price token meter stub (10 tokens per message). */
class StubTokenMeter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tokenMeter')
  }

  estimateMessage(): number {
    return 10
  }
}

const RESULT: CompactionResult = {
  compactionId: 1 as never,
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'summary' }],
  shadowedRange: { start: 1, end: 3 },
  shadowedSeqs: [1, 2, 3],
  shadowedTokenCount: 30,
} as unknown as CompactionResult

/** Stub engine recording calls, signals, and the hint parked at call entry. */
class StubCompactionEngine extends CompactionEngine {
  calls: { agent: ManualCompactAgentContext; signal: AbortSignal; source?: string }[] = []
  hintsAtCall: (string | undefined)[] = []
  failure: unknown

  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.resolve(RESULT)
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    this.calls.push({ agent, signal, source: sourceCommandId })
    const hint = takeCompactHint(agent)
    this.hintsAtCall.push(hint === undefined ? undefined : hint)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(RESULT)
  }
}

/** An idle agent double with its own session and an inject sink. */
function stubAgent(id: string, injections: UserMessage[] = []): ManualCompactAgentContext & { inject(m: UserMessage): void } {
  return {
    session: Session.create(SessionId(id)),
    options: { provider: 'mock', model: 'mock-model' },
    inject: (message: UserMessage) => {
      injections.push(message)
    },
  } as unknown as ManualCompactAgentContext & { inject(m: UserMessage): void }
}

interface HarnessOptions {
  settings?: Partial<CostGateSettings>
  withCompaction?: boolean
  now?: () => number
}

interface Harness {
  ctx: Context
  svc: InstanceType<typeof CompactionCostGate>
  compact?: StubCompactionEngine
  ledger: CostGateLedger
  home: string
  injections: UserMessage[]
  root: ReturnType<typeof stubAgent>
}

function harness(opts: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'ccg-home-'))
  const ctx = new Context()
  void new StubTokenMeter(ctx)
  const compact = (opts.withCompaction ?? true) ? new StubCompactionEngine(ctx) : undefined
  const injections: UserMessage[] = []
  const root = stubAgent('root-session', injections)
  const ledger = new CostGateLedger(join(home, 'compaction-cost-gate'))
  // A non-trivial current surface: 4 user messages × 10 tokens = 40 tokens.
  for (let i = 0; i < 4; i += 1) {
    root.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `message-${i}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  const svc = new CompactionCostGate(ctx, {
    readSettings: () => ({
      enabled: true,
      mode: 'on',
      margin: 1.0,
      cooldownMs: 600_000,
      ...opts.settings,
    }),
    ledger,
    now: opts.now,
  })
  // dshHomePath seam: point the ledger fallback at the temp home.
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  return { ctx, svc, compact, ledger, home, injections, root }
}

/** Simulate main-loop requests latching the root session (3 → requestsPerStep 3). */
function stream(h: Harness, sessionId = 'root-session', purpose?: string): void {
  for (let i = 0; i < 3; i += 1) {
    h.svc.observeStream({
      provider: 'mock',
      model: 'mock-model',
      messages: [],
      sessionId: SessionId(sessionId),
      ...(purpose === undefined ? {} : { purpose }),
    } as never)
  }
}

/** Simulate a todo_write post-execute execution from `agent`. */
function todos(h: Harness, items: Array<[string, string]>, agent = h.root): void {
  h.svc.observePostExecute({
    name: 'todo_write',
    arguments: { todos: items.map(([content, status]) => ({ content, status })) },
    agent,
  } as never)
}

async function ledgerRows(h: Harness): Promise<Record<string, unknown>[]> {
  const key = projectKeyOf(process.cwd())
  await h.ledger.flush()
  try {
    return readFileSync(join(h.home, 'compaction-cost-gate', `${key}.jsonl`), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

describe('CompactionCostGate service', () => {
  it('dry-run never calls compactNow but still ledgers the gate decision', async () => {
    const h = harness({ settings: { mode: 'dry-run' }, withCompaction: true })
    stream(h)
    todos(h, [['step', 'completed'], ['next', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(0)
    const rows = await ledgerRows(h)
    expect(rows.some((r) => r.kind === 'gate' && r.pass === true)).toBe(true)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('pass path: sets the hint BEFORE the call, fresh signal, and clears it afterwards', async () => {
    const h = harness()
    stream(h)
    todos(h, [['step-a', 'completed'], ['step-b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    expect(h.compact!.hintsAtCall[0]).toContain('plan-step-complete:step-a')
    expect(h.compact!.calls[0]!.source).toBe('compaction-cost-gate')
    expect(h.compact!.calls[0]!.signal.aborted).toBe(false)
    expect(takeCompactHint(h.root)).toBeUndefined()
    rmSync(h.home, { recursive: true, force: true })
  })

  it('cooldown blocks an immediate second completion', async () => {
    let t = 1_000
    const h = harness({ now: () => t })
    stream(h)
    todos(h, [['step-a', 'completed'], ['step-b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    t += 1_000 // well inside the 600s cooldown
    todos(h, [['step-b', 'completed'], ['step-c', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    expect((await ledgerRows(h)).some((r) => r.kind === 'skipped:cooldown')).toBe(true)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('pendingSteps === 0 never fires', async () => {
    const h = harness()
    stream(h)
    todos(h, [['only-step', 'completed']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(0)
    expect((await ledgerRows(h)).some((r) => r.kind === 'gate' && r.pass === false)).toBe(true)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('boundary lifecycle: idle evaluation without a completion does nothing; arming requires a new completion', async () => {
    const h = harness()
    stream(h)
    todos(h, [['a', 'pending'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(0)
    expect(await ledgerRows(h)).toHaveLength(0)
    // Complete then evaluate twice: only the first idle fires.
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('subagent sessions never arm the root gate nor trigger action', async () => {
    const h = harness()
    stream(h, 'root-session')
    const sub = stubAgent('sub-session')
    todos(h, [['sub-step', 'completed'], ['root-step', 'pending']], sub)
    await h.svc.evaluateIdle(sub)
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(0)
    // A subagent stream never latches or counts either.
    stream(h, 'sub-session')
    todos(h, [['root-step', 'completed'], ['root-step-2', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('shadow-aware summation: a compacted session does not double-count shadowed spans', async () => {
    const h = harness()
    stream(h)
    const s = h.root.session
    const first = s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old context' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'new context' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // Compaction replaces the shadowed span with one checkpoint user message
    // (the real engine's replacement shape), so the shadowed node leaves the
    // surface and must not be double-counted.
    s.append('user/message', {
      message: createUserMessage({
        content: [{ type: 'text', text: '<compacted>summary</compacted>' }],
        source: compactCheckpointSource(CompactionId('cg-test'), 'compaction-cost-gate'),
      }),
      source: compactCheckpointSource(CompactionId('cg-test'), 'compaction-cost-gate'),
    } as never, { surfaceOp: { op: 'replace', startSeq: first, endSeq: first }, sourceEventSeqs: [first] })
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    const gate = (await ledgerRows(h)).find((r) => r.kind === 'gate')
    // Surface now: 4 base messages + checkpoint + 'new context' = 6 × 10
    // tokens. (Naive raw-event summation would count the shadowed original
    // too: 70.)
    expect(gate?.contextTokens).toBe(60)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('breaker matrix: busy/cancelled never count; changed does; the fuse pauses with one notice; success resets', async () => {
    const h = harness()
    stream(h)

    // busy: expected class — ledgered as a skip, no failure counted.
    h.compact!.failure = new ManualCompactionError('busy', 'busy')
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.injections).toHaveLength(0)
    expect((await ledgerRows(h)).some((r) => r.kind === 'skipped:busy')).toBe(true)

    // cancelled: same.
    h.compact!.failure = new ManualCompactionError('cancelled', 'cancelled')
    todos(h, [['b', 'completed'], ['c', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.injections).toHaveLength(0)
    expect((await ledgerRows(h)).some((r) => r.kind === 'skipped:cancelled')).toBe(true)

    // changed: real defect — three in a row trips the fuse with ONE notice.
    h.compact!.failure = new ManualCompactionError('changed', 'changed')
    for (const [done, next] of [['c', 'd'], ['d', 'e'], ['e', 'f']] as const) {
      todos(h, [[done, 'completed'], [next, 'pending']])
      await h.svc.evaluateIdle(h.root)
    }
    expect(h.injections).toHaveLength(1)
    expect(String((h.injections[0] as { content: { text: string }[] }).content[0]?.text)).toContain('/compact')
    // Paused: further completions do not call.
    todos(h, [['f', 'completed'], ['g', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.injections).toHaveLength(1)
    const failed = (await ledgerRows(h)).filter((r) => r.kind === 'failed:changed')
    expect(failed).toHaveLength(3)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('a success resets the failure counter', async () => {
    const h = harness()
    stream(h)
    h.compact!.failure = new ManualCompactionError('changed', 'changed')
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    h.compact!.failure = undefined
    todos(h, [['b', 'completed'], ['c', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(2)
    expect(h.injections).toHaveLength(0)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('absent compaction inactivates with one ledger row and a log line', async () => {
    const h = harness({ withCompaction: false })
    stream(h)
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect((await ledgerRows(h)).some((r) => r.kind === 'compaction-unavailable')).toBe(true)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('enabled: false ships dark — no ledger, no calls', async () => {
    const h = harness({ settings: { enabled: false } })
    stream(h)
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(0)
    expect(await ledgerRows(h)).toHaveLength(0)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('window-pressure bypass skips the margin comparison (cooldown still applies)', async () => {
    let t = 1_000
    const h = harness({ settings: { windowPressureTokens: 100 }, now: () => t })
    stream(h)
    todos(h, [['a', 'completed'], ['b', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    t += 1_000
    todos(h, [['b', 'completed'], ['c', 'pending']])
    await h.svc.evaluateIdle(h.root)
    expect(h.compact!.calls).toHaveLength(1)
    rmSync(h.home, { recursive: true, force: true })
  })

  it('agent/status idle events drive evaluation for the latched root only', async () => {
    const h = harness()
    stream(h)
    todos(h, [['a', 'completed'], ['b', 'pending']])
    h.ctx.emit(h.ctx, 'agent/status', { agent: h.root, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.compact!.calls).toHaveLength(1)
    // A subagent idle event never triggers.
    const sub = stubAgent('sub-session')
    h.ctx.emit(h.ctx, 'agent/status', { agent: sub, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.compact!.calls).toHaveLength(1)
    rmSync(h.home, { recursive: true, force: true })
  })
})
