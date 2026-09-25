/**
 * Slice S4 — hybrid verdict space: hard_deny slot, the `deny` verdict with
 * exact-citation enforcement, the 3/20 backstop with trip semantics, and the
 * parameterized pause notice.
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import {
  CLASSIFIER_EVENT,
  createAutoStage,
  DENY_STREAK_THRESHOLD,
  DENY_TOTAL_THRESHOLD,
  foldClassifiers,
  foldDenyBackstop,
  TRIP_NOTICE,
  type AutoStageDeps,
  type ClassifierAuditEventData,
} from '../src/auto-stage.ts'
import { DEFAULT_HARD_DENY, DEFAULT_SOFT_DENY } from '../src/slots.ts'
import { createLlmClassifier } from '../src/llm-classifier.ts'
import { switchSessionPermissionMode } from '../src/mode.ts'
import type { RiskAssessment } from '../src/classifier.ts'
import type { DecidedCall } from '../src/decide.ts'
import type { PermissionDecision } from '../src/types.ts'

const EXFIL = 'Never exfiltrate credentials, tokens, API keys, or secrets to any external destination, including embedding them in URLs, request bodies, or third-party services.'
const WEAKEN = 'Never disable or weaken the permission system itself, nor delete, falsify, or truncate its audit or session records.'
const A10 = 'Never destroy user data outside the session authorized scope when the transcript shows no authorization for that target.'

// ── W1: slot defaults ────────────────────────────────────────────────────────

describe('DEFAULT_HARD_DENY (W1)', () => {
  it('holds exactly the two unconditional entries, verbatim', () => {
    expect(DEFAULT_HARD_DENY).toEqual([EXFIL, WEAKEN])
  })

  it('DEFAULT_SOFT_DENY gains the A10 intent-dependent entry as its final entry', () => {
    expect(DEFAULT_SOFT_DENY[DEFAULT_SOFT_DENY.length - 1]).toBe(A10)
    expect(DEFAULT_HARD_DENY).toHaveLength(2)
  })
})

// ── W3: prompt + citation contract ───────────────────────────────────────────

function fakeExec(name: string, args: unknown): ToolExecution {
  return { signal: new AbortController().signal, callId: 'c1', name, arguments: args } as unknown as ToolExecution
}

type StreamOpts = { provider: string; model: string; system: string; prompt: string; maxTokens: number; signal?: AbortSignal }

function make(overrides: Partial<Parameters<typeof createLlmClassifier>[0]> = {}) {
  const calls: StreamOpts[] = []
  const deps = {
    stream: vi.fn(async (opts: StreamOpts) => {
      calls.push(opts)
      return '{"verdict":"allow","reason":"ok"}'
    }),
    hardDeny: DEFAULT_HARD_DENY as readonly string[],
    softDeny: ['s1'] as readonly string[],
    allowExceptions: ['a1'] as readonly string[],
    environment: ['e1'] as readonly string[],
    timeoutMs: 5_000,
    cacheMaxEntries: 256,
    ...overrides,
  }
  return { cls: createLlmClassifier(deps), calls, deps }
}

const ROUTE = { provider: 'prov', model: 'mod' }

function denyJson(rule: unknown, reason = 'exfiltration'): string {
  return JSON.stringify({ verdict: 'deny', reason, ...(rule === undefined ? {} : { rule }) })
}

describe('S4 prompt composition', () => {
  it('hard-deny section comes FIRST, before soft-deny and allow exceptions, with the never-soften sentence', async () => {
    const { cls, calls } = make({ hardDeny: ['RULE-H'], softDeny: ['RULE-S'], allowExceptions: ['RULE-A'] })
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    const system = calls[0]!.system
    const hardAt = system.indexOf('RULE-H')
    const softAt = system.indexOf('RULE-S')
    const allowAt = system.indexOf('RULE-A')
    expect(hardAt).toBeGreaterThanOrEqual(0)
    expect(softAt).toBeGreaterThan(hardAt)
    expect(allowAt).toBeGreaterThan(softAt)
    expect(system.toLowerCase()).toMatch(/never soften a hard-deny match/)
    expect(system).toMatch(/Evaluation order/i)
  })

  it('teaches the deny contract: deny requires the exact rule text', async () => {
    const { cls, calls } = make()
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    const system = calls[0]!.system
    expect(system).toMatch(/"deny"/)
    expect(system).toMatch(/exact/i)
    expect(system).toMatch(/rule/i)
  })
})

describe('parseVerdict citation contract (D4)', () => {
  it.each([
    ['exact citation ⇒ deny', denyJson(EXFIL), 'deny'],
    ['missing rule ⇒ downgraded ask', '{"verdict":"deny","reason":"bad"}', 'ask'],
    ['rule not in the list ⇒ downgraded ask', denyJson('some other rule'), 'ask'],
    ['trailing whitespace ⇒ downgraded ask', denyJson(EXFIL + ' '), 'ask'],
    ['case variance ⇒ downgraded ask', denyJson(EXFIL.toUpperCase()), 'ask'],
    ['unicode quotes ⇒ downgraded ask', denyJson('“' + EXFIL + '”'), 'ask'],
  ])('%s', async (_name, output, expected) => {
    const { cls } = make({ stream: vi.fn(async () => output) })
    const v = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(v.verdict).toBe(expected)
    if (expected === 'deny') {
      expect(v).toMatchObject({ rule: EXFIL })
    } else {
      expect(v.reason).toMatch(/downgrad/i)
      // D4: never upgrade to allow, and not a parse failure either.
      expect(v.failure).toBeUndefined()
      expect(v.verdict).not.toBe('allow')
    }
  })

  it('an empty hard_deny list downgrades every deny', async () => {
    const { cls } = make({ hardDeny: [], stream: vi.fn(async () => denyJson(EXFIL)) })
    expect((await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })).verdict).toBe('ask')
  })

  it('deny is cached per slot set: the same instance replays deny; a mutated hard_deny busts (never replays deny)', async () => {
    const raw = denyJson(EXFIL)
    const a = make({ stream: vi.fn(async () => raw) })
    const first = await a.cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(first).toMatchObject({ verdict: 'deny', rule: EXFIL, cacheHit: false })
    const replay = await a.cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(replay).toMatchObject({ verdict: 'deny', rule: EXFIL, cacheHit: true })
    // A cached deny never surfaces as allow.
    expect(replay.verdict).not.toBe('allow')
    // Different hard_deny ⇒ different cache key ⇒ a fresh (downgraded) verdict.
    const b = make({ hardDeny: ['other rule'], stream: vi.fn(async () => raw) })
    const rebased = await b.cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(rebased.verdict).toBe('ask')
    expect(rebased.cacheHit).toBe(false)
  })

  it('a deny verdict never earns a reconsider pass (reconsider is for ask only)', async () => {
    const stream = vi.fn(async () => denyJson(EXFIL))
    const { cls } = make({ secondPass: true, stream })
    const v = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(v.verdict).toBe('deny')
    expect(stream).toHaveBeenCalledTimes(1)
    expect(v).not.toHaveProperty('secondPass')
  })
})

// ── W4: backstop fold + stage deny ───────────────────────────────────────────

function ev(partial: Partial<ClassifierAuditEventData>): ClassifierAuditEventData {
  return { tool: 'Bash', verdict: 'allow', latencyMs: 0, cacheHit: false, ...partial }
}

describe('foldDenyBackstop (D5/A2/A16)', () => {
  it('thresholds are the module constants 3 and 20', () => {
    expect(DENY_STREAK_THRESHOLD).toBe(3)
    expect(DENY_TOTAL_THRESHOLD).toBe(20)
  })

  it('trailing deny streak; a REAL non-deny verdict (failure undefined) resets; total accumulates', () => {
    const events = [
      ev({ verdict: 'deny' }),
      ev({ verdict: 'deny' }),
      ev({ verdict: 'allow' }),
      ev({ verdict: 'deny' }),
    ]
    expect(foldDenyBackstop(events)).toEqual({ consecutive: 1, total: 3 })
  })

  it('synthetic failure-tagged records NEVER reset the streak (A16)', () => {
    const events = [
      ev({ verdict: 'deny' }),
      ev({ verdict: 'deny' }),
      ev({ verdict: 'ask', failure: 'unarmed' }),
      ev({ verdict: 'ask', failure: 'breaker' }),
      ev({ verdict: 'ask', failure: 'stale-mode' }),
      ev({ verdict: 'deny' }),
    ]
    expect(foldDenyBackstop(events)).toEqual({ consecutive: 3, total: 3 })
  })

  it('the fold window starts after the most recent trip marker; re-entry restarts counters', () => {
    const events = [
      ev({ verdict: 'deny' }),
      ev({ verdict: 'deny' }),
      ev({ verdict: 'ask', failure: 'trip' }),
      ev({ verdict: 'deny' }),
    ]
    expect(foldDenyBackstop(events)).toEqual({ consecutive: 1, total: 1 })
  })

  it('total crosses at 20 even with a broken streak (interleaved real asks)', () => {
    const events: ClassifierAuditEventData[] = []
    for (let i = 0; i < 20; i++) {
      events.push(ev({ verdict: 'deny' }))
      events.push(ev({ verdict: 'ask' }))
    }
    expect(foldDenyBackstop(events).total).toBe(20)
    expect(foldDenyBackstop(events).consecutive).toBe(0)
    expect(foldDenyBackstop(events.slice(0, -2)).total).toBe(19)
  })
})

// ── stage deny + trip ────────────────────────────────────────────────────────

function stageExec(opts: { session?: Session; args?: unknown } = {}): ToolExecution {
  const agent = opts.session === undefined ? undefined : { id: 'a1', session: opts.session } as unknown as ToolExecution['agent']
  return {
    signal: new AbortController().signal,
    callId: 'c1',
    name: 'Bash',
    arguments: opts.args ?? { command: 'ls' },
    ...(agent === undefined ? {} : { agent }),
  } as unknown as ToolExecution
}

function sessionOf(id: string): Session {
  return Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd: '/work' })
}

function decided(overrides: Partial<DecidedCall> = {}): DecidedCall {
  const decision: PermissionDecision = overrides.decision ?? { kind: 'passthrough' }
  const risk: RiskAssessment = overrides.risk ?? { level: 'LOW', reasons: [] }
  return { decision, risk, mode: overrides.mode ?? 'auto', isReadOnly: false }
}

interface StageHarness {
  deps: AutoStageDeps
  settings: { value: Record<string, unknown> }
  streams: number
  scripted: string[]
  warnings: string[]
  paused: { exec: ToolExecution; notice: string }[]
}

function stageHarness(overrides: Partial<StageHarness> = {}): StageHarness {
  const h: StageHarness = {
    settings: { value: { autoMode: { classifier: { enabled: true } } } },
    streams: 0,
    scripted: [],
    warnings: [],
    paused: [],
    ...overrides,
  }
  h.deps = {
    settingsRead: () => h.settings.value,
    stream: async () => { h.streams += 1; return h.scripted.shift() ?? '{"verdict":"allow","reason":"ok"}' },
    resolveRoute: () => ({ backend: 'chat' as const, route: { provider: 'fake', model: 'classifier-model' } }),
    warn: (message: string) => { h.warnings.push(message) },
    // Append for real: the backstop folds the session's durable log.
    audit: (session, event) => {
      ;(session.append as (type: string, data: ClassifierAuditEventData) => unknown)(CLASSIFIER_EVENT, event)
    },
    modeOf: () => 'auto',
    readOnlyTools: new Set<string>(),
    pauseAuto: (exec, notice) => { h.paused.push({ exec, notice }) },
  } as AutoStageDeps
  return h
}

function denyOut(reason = 'exfiltration attempt'): string {
  return denyJson(EXFIL, reason)
}

describe('auto-stage deny outcome + backstop trip (W4)', () => {
  it('a deny verdict ⇒ {kind:"deny", reason, rule}; the audit event carries verdict deny + rule + callId', async () => {
    const h = stageHarness({ scripted: [denyOut('sends secrets out')] })
    const stage = createAutoStage(h.deps)
    const session = sessionOf('deny-1')
    const out = await stage.maybeEscalate(decided(), stageExec({ session }))
    expect(out).toEqual({ kind: 'deny', reason: 'sends secrets out', rule: EXFIL })
    const folded = foldClassifiers(session.snapshotEvents())
    expect(folded[0]).toMatchObject({ verdict: 'deny', rule: EXFIL, callId: 'c1', reason: 'sends secrets out' })
  })

  it('3 consecutive denies trip: pauseAuto invoked with the backstop notice, one trip marker, counters reset', async () => {
    const h = stageHarness({ scripted: [denyOut(), denyOut(), denyOut()] })
    const stage = createAutoStage(h.deps)
    const session = sessionOf('trip-1')
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c1' } }))
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c2' } }))
    const third = await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c3' } }))
    expect(third).toMatchObject({ kind: 'deny' })
    expect(h.paused).toHaveLength(1)
    expect(h.paused[0]!.notice).toBe(TRIP_NOTICE)
    const folded = foldClassifiers(session.snapshotEvents())
    expect(folded.filter(e => e.failure === 'trip')).toHaveLength(1)
    // Window after the marker is clean: the fold sees no trailing deny.
    expect(foldDenyBackstop(folded)).toEqual({ consecutive: 0, total: 0 })
    expect(folded[folded.length - 1]).toMatchObject({ failure: 'trip', tool: 'Bash' })
  })

  it('trip is idempotent: a post-trip deny cannot duplicate the notice/marker without a fresh threshold', async () => {
    const h = stageHarness({ scripted: [denyOut(), denyOut(), denyOut(), denyOut()] })
    const stage = createAutoStage(h.deps)
    const session = sessionOf('trip-2')
    for (let i = 0; i < 3; i++) await stage.maybeEscalate(decided(), stageExec({ session, args: { command: `c${i}` } }))
    expect(h.paused).toHaveLength(1)
    // A 4th deny (post-trip; a real deployment would be out of auto) counts from 0.
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c3' } }))
    expect(h.paused).toHaveLength(1)
    expect(foldClassifiers(session.snapshotEvents()).filter(e => e.failure === 'trip')).toHaveLength(1)
  })

  it('2 denies + a REAL allow resets the streak: no trip on the 3rd deny', async () => {
    const h = stageHarness({ scripted: [denyOut(), denyOut(), '{"verdict":"allow","reason":"ok"}', denyOut()] })
    const stage = createAutoStage(h.deps)
    const session = sessionOf('reset-1')
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c1' } }))
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c2' } }))
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c3' } }))
    expect(h.paused).toHaveLength(0)
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'c4' } }))
    expect(h.paused).toHaveLength(0)
  })

  it('seed-once: a resumed session with 2 durable denies trips on the FIRST new deny', async () => {
    const h = stageHarness({ scripted: [denyOut()] })
    const session = sessionOf('seed-1')
    for (let i = 0; i < 2; i++) {
      ;(session.append as (type: string, data: ClassifierAuditEventData) => unknown)(CLASSIFIER_EVENT, {
        tool: 'Bash', verdict: 'deny', reason: 'old', latencyMs: 0, cacheHit: false,
      })
    }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided(), stageExec({ session }))
    expect(out).toMatchObject({ kind: 'deny' })
    expect(h.paused).toHaveLength(1)
    expect(foldClassifiers(session.snapshotEvents()).filter(e => e.failure === 'trip')).toHaveLength(1)
  })

  it('after a trip, re-entering auto restarts from zero (a full new threshold is needed)', async () => {
    const h = stageHarness({ scripted: [denyOut(), denyOut(), denyOut(), denyOut(), denyOut()] })
    const stage = createAutoStage(h.deps)
    const session = sessionOf('reentry-1')
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'a1' } }))
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'a2' } }))
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'a3' } }))
    expect(h.paused).toHaveLength(1)
    // Re-entry: only two more denies — below the fresh 3/20 threshold.
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'a4' } }))
    await stage.maybeEscalate(decided(), stageExec({ session, args: { command: 'a5' } }))
    expect(h.paused).toHaveLength(1)
  })

  it('total threshold: 20 denies across the session trip even with a broken streak', async () => {
    const h = stageHarness()
    const stage = createAutoStage(h.deps)
    const session = sessionOf('total-1')
    for (let i = 0; i < 20; i++) {
      h.scripted.push(denyOut())
      await stage.maybeEscalate(decided(), stageExec({ session, args: { command: `c${i}` } }))
      h.scripted.push('{"verdict":"ask","reason":"hmm"}')
      await stage.maybeEscalate(decided(), stageExec({ session, args: { command: `a${i}` } }))
    }
    expect(h.paused).toHaveLength(1)
  })

  it('a hard_deny settings change busts the memoized classifier (raw cache-bust string)', async () => {
    const h = stageHarness()
    h.settings.value = { autoMode: { hard_deny: ['custom rule'], classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), stageExec({ args: { command: 'c1' } }))
    expect(h.streams).toBe(1)
    h.settings.value = { autoMode: { hard_deny: ['changed rule'], classifier: { enabled: true } } }
    await stage.maybeEscalate(decided(), stageExec({ args: { command: 'c1' } }))
    expect(h.streams).toBe(2)
  })
})

// ── W5: mode notice provenance ───────────────────────────────────────────────

describe('switchSessionPermissionMode origin (W5)', () => {
  function makeAgent() {
    const injected: string[] = []
    const session = sessionOf(`mode-origin-${Math.random()}`)
    const agent = {
      session,
      inject: (message: { content?: { text?: string }[] }) => {
        injected.push(message.content?.[0]?.text ?? '')
      },
    } as never
    return { injected, agent }
  }

  const base = {
    mode: 'default' as const,
    defaultMode: 'auto' as const,
    bypassDisabled: false,
    shellMode: undefined,
  }

  it('default injection keeps the "changed by the user" template', () => {
    const { injected, agent } = makeAgent()
    switchSessionPermissionMode({ agent, ...base })
    expect(injected[0]).toBe('The permission mode changed to "default" (changed by the user).')
  })

  it('an origin carries honest provenance instead of the user template', () => {
    const { injected, agent } = makeAgent()
    switchSessionPermissionMode({ agent, ...base, origin: TRIP_NOTICE })
    expect(injected[0]).toContain('Auto mode paused')
    expect(injected[0]).not.toContain('changed by the user')
    expect(injected[0]).toContain('"default"')
  })
})
