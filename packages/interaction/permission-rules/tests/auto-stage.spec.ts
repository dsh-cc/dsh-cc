import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import type { RiskAssessment } from '../src/classifier.ts'
import type { DecidedCall } from '../src/decide.ts'
import type { PermissionDecision, PermissionMode } from '../src/types.ts'
import {
  CLASSIFIER_EVENT,
  createAutoStage,
  foldClassifiers,
  appendSessionClassifier,
  trailingRouteFailureStreak,
  type AutoStageDeps,
  type ClassifierAuditEventData,
} from '../src/auto-stage.ts'

function exec(opts: { name?: string; args?: unknown; session?: Session; signal?: AbortSignal } = {}): ToolExecution {
  const signal = opts.signal ?? new AbortController().signal
  const agent = opts.session === undefined ? undefined : { id: 'a1', session: opts.session } as unknown as ToolExecution['agent']
  return {
    signal,
    callId: 'c1',
    name: opts.name ?? 'Bash',
    arguments: opts.args ?? { command: 'ls' },
    ...(agent === undefined ? {} : { agent }),
  } as unknown as ToolExecution
}

function sessionOf(id: string, cwd = '/work'): Session {
  return Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd })
}

function decided(overrides: Partial<DecidedCall> = {}): DecidedCall {
  // D3: stage eligibility is passthrough-only at LOW, so the default decided
  // shape is a passthrough (a rule-derived ask never reaches the stage).
  const decision: PermissionDecision = overrides.decision ?? { kind: 'passthrough' }
  const risk: RiskAssessment = overrides.risk ?? { level: 'LOW', reasons: [] }
  const mode: PermissionMode = overrides.mode ?? 'auto'
  const isReadOnly: boolean = overrides.isReadOnly ?? false
  return { decision, risk, mode, isReadOnly }
}

interface Harness {
  deps: AutoStageDeps
  settings: { value: Record<string, unknown> }
  streams: number
  scripted: string[]
  warnings: string[]
  route: { provider: string; model: string } | undefined
  settingsWrites: number
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    settings: { value: {} },
    streams: 0,
    scripted: [],
    warnings: [],
    route: { provider: 'fake', model: 'classifier-model' },
    settingsWrites: 0,
    ...overrides,
  }
  h.deps = {
    settingsRead: () => h.settings.value,
    stream: async () => { h.streams += 1; return h.scripted.shift() ?? '{"verdict":"allow","reason":"ok"}' },
    // PR-B: the resolved backend is now a discriminated union; the chat lane keeps the plain route shape.
    resolveRoute: () => (h.route === undefined ? undefined : { backend: 'chat' as const, route: h.route }),
    warn: (message: string) => { h.warnings.push(message) },
    audit: vi.fn(),
    // A16 stale-mode: the harness pins mode at `auto` unless a test overrides modeOf.
    modeOf: () => 'auto',
    readOnlyTools: new Set<string>(),
    pauseAuto: () => {},
  } as AutoStageDeps
  return h
}

describe('auto-stage arming (per call)', () => {
  it('disarmed (classifier disabled): never consults the LLM, never warns', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: false } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided(), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.warnings).toHaveLength(0)
    expect(h.deps.audit).not.toHaveBeenCalled()
  })

  it('no autoMode section at all: disarmed, silent', async () => {
    const h = harness()
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.warnings).toHaveLength(0)
  })

  it('armed: consults the classifier only for auto + LOW + passthrough (verdict allow ⇒ allow; D3 eligibility)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBe('allow')
    expect(h.streams).toBe(1)
  })

  it('armed: ask verdict ⇒ ask with the classifier reason (escalate-only)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.scripted = ['{"verdict":"ask","reason":"terraform apply"}']
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toEqual({ kind: 'ask', reason: 'terraform apply' })
  })

  it('malformed model output ⇒ ask (I4; failure parsing lives in the classifier core)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.scripted = ['not json at all']
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided(), exec())
    expect(out).toMatchObject({ kind: 'ask' })
    expect(String((out as { reason: string }).reason)).toMatch(/unparseable/)
  })
})

describe('auto-stage eligibility gates (invariants I1–I3, I5)', () => {
  it('I1: classifier-HIGH ⇒ no escalation — the LLM is never invoked', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ risk: { level: 'HIGH', reasons: ['x'] }, decision: { kind: 'deny', reason: 'blocked' } }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('I2: rule deny ⇒ no escalation, LLM never invoked', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ decision: { kind: 'deny', reason: 'deny rule' } }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('I3: plan mode ⇒ no escalation, LLM never invoked', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ mode: 'plan' }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('I5 (S3 flip): MEDIUM + passthrough + armed ⇒ the LLM arbitrates', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ risk: { level: 'MEDIUM', reasons: ['outside cwd'] } }), exec())).toBe('allow')
    expect(h.streams).toBe(1)
  })

  it('armed but mode=default ⇒ no escalation (N1: only auto is vetted)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ mode: 'default' }), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('armed but decision already allow/deny ⇒ no escalation', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ decision: { kind: 'allow' } }), exec())).toBeUndefined()
    expect(await stage.maybeEscalate(decided({ decision: { kind: 'deny', reason: 'x' } }), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
  })
})

describe('enabled-but-unarmable ⇒ disarm + warn ONCE + unarmed audit', () => {
  it('no resolvable route: warns once per process, appends one unarmed audit event, and D11-fails to PROMPT (ask with availability reason)', async () => {
    const h = harness()
    h.route = undefined
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const session = sessionOf('unarmed-1')
    const stage = createAutoStage(h.deps)
    const execWithSession = exec({ session })
    const unavailable = { kind: 'ask', reason: expect.stringMatching(/unavailable/i) }
    expect(await stage.maybeEscalate(decided(), execWithSession)).toEqual(unavailable)
    expect(await stage.maybeEscalate(decided(), execWithSession)).toEqual(unavailable)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/classifier|route|unarm/i)
    // The unarmed audit event is per call; the warning is the once-per-process half.
    expect(h.deps.audit).toHaveBeenCalledTimes(2)
    expect(h.deps.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failure: 'unarmed' }))
  })

  it('no llm stream capability mounted: D11 fail-to-prompt (ask with availability reason) + one warning', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.deps.stream = undefined
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/classifier|route|unarm/i)
  })

  it('enabled===false ⇒ undefined even for an eligible call (D11 disabled row: strict-rule auto)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: false } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBeUndefined()
    expect(h.deps.audit).not.toHaveBeenCalled()
  })
})

describe('classifier memoization (settings-slice rebuild)', () => {
  it('reuses the classifier across calls with an unchanged autoMode slice (cache holds)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const e = exec()
    await stage.maybeEscalate(decided(), e)
    await stage.maybeEscalate(decided(), e)
    // Same tool + input + soft-deny list ⇒ cache hit ⇒ only one stream call.
    expect(h.streams).toBe(1)
  })

  it('rebuilds when the autoMode slice changes (changed soft_deny busts the cache)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const e = exec()
    await stage.maybeEscalate(decided(), e)
    h.settingsWrites += 1
    h.settings.value = { autoMode: { classifier: { enabled: true }, soft_deny: ['never touch prod'] } }
    stage.rebuild()
    await stage.maybeEscalate(decided(), e)
    expect(h.streams).toBe(2)
  })

  it('rebuild() with an unchanged slice keeps the memoized classifier', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const e = exec()
    await stage.maybeEscalate(decided(), e)
    stage.rebuild()
    await stage.maybeEscalate(decided(), e)
    expect(h.streams).toBe(1)
  })
})

describe('concurrent maybeEscalate audit attribution', () => {
  it('two in-flight calls on different sessions land each verdict audit on its own session', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    // Deferred streams: each call's in-flight promise resolves only when we release it.
    const gates: Array<(value: string) => void> = []
    h.deps.stream = () => new Promise<string>(resolve => { gates.push(resolve) })
    const sessionA = sessionOf('conc-a')
    const sessionB = sessionOf('conc-b')
    const eA = exec({ session: sessionA, args: { command: 'cmd-a' } })
    const eB = exec({ session: sessionB, args: { command: 'cmd-b' } })
    const stage = createAutoStage(h.deps)
    const pA = stage.maybeEscalate(decided(), eA)
    const pB = stage.maybeEscalate(decided(), eB)
    // S3: the context bundle (enrichment) adds a microtask before the stream
    // call — flush it so both in-flight gates are registered.
    await new Promise(resolve => setImmediate(resolve))
    // B's stream settles first, then A's — the interleaving that scrambled the old ambient fields.
    gates[1]!('{"verdict":"ask","reason":"from-b"}')
    gates[0]!('{"verdict":"allow","reason":"from-a"}')
    expect(await pA).toBe('allow')
    expect(await pB).toEqual({ kind: 'ask', reason: 'from-b' })
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { verdict: string; failure?: string }]>
    expect(calls).toHaveLength(2)
    const verdictFor = (session: Session): string | undefined =>
      calls.filter(([s]) => s === session).map(([, e]) => e.verdict)[0]
    expect(verdictFor(sessionA)).toBe('allow')
    expect(verdictFor(sessionB)).toBe('ask')
  })
})

describe('permission/classifier audit event (fold/replay round-trip)', () => {
  it('registers the event type and round-trips appended events through the fold', () => {
    const session = sessionOf('audit-1')
    appendSessionClassifier(session, {
      tool: 'Bash',
      digest: 'a'.repeat(64),
      verdict: 'allow',
      route: 'fake/classifier-model',
      provider: 'fake',
      model: 'classifier-model',
      latencyMs: 12,
      cacheHit: false,
    })
    appendSessionClassifier(session, {
      tool: 'Bash',
      digest: 'b'.repeat(64),
      verdict: 'ask',
      failure: 'timeout',
      latencyMs: 5001,
      cacheHit: false,
    })
    const folded = foldClassifiers(session.snapshotEvents())
    expect(folded).toHaveLength(2)
    expect(folded[0]).toMatchObject({ tool: 'Bash', verdict: 'allow', cacheHit: false })
    expect(folded[0]?.digest).toBe('a'.repeat(64))
    expect(folded[1]).toMatchObject({ tool: 'Bash', verdict: 'ask', failure: 'timeout' })
    // The session log never carries raw input — only the digest.
    const raw = JSON.stringify(session.snapshotEvents())
    expect(raw).not.toContain('command')
    expect(folded.every(record => record.digest === undefined || /^[0-9a-f]{64}$/.test(record.digest))).toBe(true)
  })

  it('skips foreign event types', () => {
    const session = sessionOf('audit-2')
    session.append('permission/mode', { mode: 'auto' })
    appendSessionClassifier(session, { tool: 'Bash', digest: 'c'.repeat(64), verdict: 'ask', latencyMs: 1, cacheHit: false })
    expect(foldClassifiers(session.snapshotEvents())).toHaveLength(1)
  })
})

describe('F2 read-only exemption', () => {
  it('armed + auto + LOW + read-only ⇒ stream never called, legacy mapping (undefined) applies', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(
      decided({ isReadOnly: true, decision: { kind: 'passthrough' } }),
      exec({ name: 'Glob', args: { pattern: '*.ts' } }),
    )
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.deps.audit).not.toHaveBeenCalled()
  })

  it('mutating control (same shape) still consults the classifier', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ isReadOnly: false }), exec({ name: 'Glob', args: { pattern: '*.ts' } }))).toBe('allow')
    expect(h.streams).toBe(1)
  })

  it('ordering: the risk!=="LOW" gate precedes — a MEDIUM read-only path never reaches the classifier', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(
      decided({ isReadOnly: true, risk: { level: 'MEDIUM', reasons: ['x'] } }),
      exec({ name: 'Glob', args: { pattern: '*.ts' } }),
    )
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.deps.audit).not.toHaveBeenCalled()
  })

  it('F3 audit-shape pin: the audit record carries no raw input/output fields', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const session = sessionOf('audit-shape')
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), exec({ session, args: { command: 'secret-echo-token' } }))
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, Record<string, unknown>]>
    expect(calls).toHaveLength(1)
    // S4/D5: `callId` (and `rule` on deny) join the digest-only shape.
    expect(Object.keys(calls[0]![1]).sort()).toEqual(['cacheHit', 'callId', 'digest', 'latencyMs', 'model', 'provider', 'reason', 'route', 'tool', 'verdict'])
    expect(JSON.stringify(calls[0]![1])).not.toContain('secret-echo-token')
  })
})

describe('F4 per-route failure breaker', () => {
  /** Stream fns consumed one per stream call; a fn may throw or hang. */
  function scriptHarness(
    script: Array<(opts: { signal?: AbortSignal }) => Promise<string>>,
    routes: { [tool: string]: { provider: string; model: string } },
  ): Harness {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, timeoutMs: 30 } } }
    let i = 0
    h.deps.stream = async (opts: { signal?: AbortSignal }) => {
      h.streams += 1
      const next = script[i]
      i += 1
      if (next === undefined) throw new Error('script exhausted')
      return await next(opts)
    }
    h.deps.resolveRoute = (e: ToolExecution) => (routes[e.name] ?? h.route) === undefined ? undefined : { backend: 'chat' as const, route: routes[e.name] ?? h.route }
    return h
  }

  const malformed = async () => 'not json at all'
  const error = async () => { throw new Error('boom') }
  const ok = async () => '{"verdict":"allow","reason":"ok"}'
  const hang = (opts: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    setTimeout(() => reject(new Error('hung')), 4_000)
  })

  it('3 consecutive mixed failures trip; 4th call: no stream, warn×1, one breaker audit per session', async () => {
    const h = scriptHarness([malformed, error, hang], { Bash: { provider: 'p1', model: 'm1' } })
    const sessionA = sessionOf('brk-a')
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c1' } }))).toMatchObject({ kind: 'ask' })
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c2' } }))).toMatchObject({ kind: 'ask' })
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c3' } }))).toMatchObject({ kind: 'ask' })
    expect(h.streams).toBe(3)
    // 4th call on the same session: open breaker, legacy path, exactly one warn, one breaker audit.
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c4' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.streams).toBe(3)
    expect(h.warnings).toHaveLength(1)
    // 5th call in a NEW session: still no stream, still one warn, its own breaker audit.
    const sessionB = sessionOf('brk-b')
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionB, args: { command: 'c5' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.streams).toBe(3)
    expect(h.warnings).toHaveLength(1)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string; tool: string; route?: string }]>
    const breakerFor = (s: Session): unknown[] => calls.filter(([se, e]) => se === s && e.failure === 'breaker')
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(2)
    expect(breakerFor(sessionA)).toHaveLength(1)
    expect(breakerFor(sessionB)).toHaveLength(1)
  })

  it('a success between failures resets the streak', async () => {
    const h = scriptHarness([malformed, malformed, ok, malformed, malformed, ok], { Bash: { provider: 'p1', model: 'm1' } })
    const stage = createAutoStage(h.deps)
    for (let i = 0; i < 6; i += 1) {
      await stage.maybeEscalate(decided(), exec({ args: { command: `c${i}` } }))
    }
    expect(h.streams).toBe(6)
    expect(h.warnings).toHaveLength(0)
  })

  it('route isolation: interleaved concurrent failures on X never open Y', async () => {
    const h = scriptHarness([malformed, malformed, malformed, malformed, malformed, ok], {
      X: { provider: 'px', model: 'mx' },
      Y: { provider: 'py', model: 'my' },
    })
    const stage = createAutoStage(h.deps)
    // Interleaved concurrent classifies on X and Y.
    const pX = stage.maybeEscalate(decided(), exec({ name: 'X', args: { command: 'x1' } }))
    const pY = stage.maybeEscalate(decided(), exec({ name: 'Y', args: { command: 'y1' } }))
    await Promise.all([pX, pY])
    await stage.maybeEscalate(decided(), exec({ name: 'X', args: { command: 'x2' } }))
    await stage.maybeEscalate(decided(), exec({ name: 'Y', args: { command: 'y2' } }))
    await stage.maybeEscalate(decided(), exec({ name: 'Y', args: { command: 'y3' } }))
    // Y is now open (3 consecutive Y failures): no more Y stream calls…
    const streamsAtTrip = h.streams
    expect(await stage.maybeEscalate(decided(), exec({ name: 'Y', args: { command: 'y4' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.streams).toBe(streamsAtTrip)
    expect(h.warnings).toHaveLength(1)
    // …but X has only 2 failures and still consults the classifier.
    expect(await stage.maybeEscalate(decided(), exec({ name: 'X', args: { command: 'x3' } }))).toBe('allow')
    expect(h.streams).toBe(streamsAtTrip + 1)
  })

  it('unarmed classifications never count toward the breaker', async () => {
    const h = scriptHarness([malformed, ok], {})
    h.route = undefined
    const stage = createAutoStage(h.deps)
    for (let i = 0; i < 3; i += 1) {
      // Unarmed disarm path: stream never consulted, undefined (legacy).
      expect(await stage.maybeEscalate(decided(), exec({ args: { command: `u${i}` } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    }
    expect(h.streams).toBe(0)
    h.route = { provider: 'p1', model: 'm1' }
    // The route was never "failed" by the unarmed calls: the breaker stays
    // closed, so a malformed call + a success run normally (one failure ≠ trip).
    expect(await stage.maybeEscalate(decided(), exec({ args: { command: 'armed-1' } }))).toMatchObject({ kind: 'ask' })
    expect(await stage.maybeEscalate(decided(), exec({ args: { command: 'armed-2' } }))).toBe('allow')
    expect(h.streams).toBe(2)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/unarmable/)
  })
  it('rebuild() re-arms: counters, breaker session set, and the warn-once flag all reset', async () => {
    const h = scriptHarness([malformed, malformed, malformed, ok, malformed, malformed, malformed], { Bash: { provider: 'p1', model: 'm1' } })
    const sessionA = sessionOf('brk-rebuild')
    const stage = createAutoStage(h.deps)
    for (const c of ['c1', 'c2', 'c3']) await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: c } }))
    expect(h.warnings).toHaveLength(1)
    // Operator "fixes the lane" via a settings change + rebuild.
    h.settings.value = { autoMode: { classifier: { enabled: true, timeoutMs: 30, route: 'other' } } }
    stage.rebuild()
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'fixed' } }))).toBe('allow')
    // Re-trips with a fresh warn and a fresh breaker audit for the same session.
    for (const c of ['c4', 'c5', 'c6']) await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: c } }))
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c7' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.warnings).toHaveLength(2)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([s, e]) => s === sessionA && e.failure === 'breaker')).toHaveLength(2)
  })
})

describe('R2 cancelled classifications are breaker-neutral', () => {

  function scriptHarness(
    script: Array<(opts: { signal?: AbortSignal }) => Promise<string>>,
    routes: { [tool: string]: { provider: string; model: string } },
  ): Harness {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, timeoutMs: 30 } } }
    let i = 0
    h.deps.stream = async (opts: { signal?: AbortSignal }) => {
      h.streams += 1
      const next = script[i]
      i += 1
      if (next === undefined) throw new Error('script exhausted')
      return await next(opts)
    }
    h.deps.resolveRoute = (e: ToolExecution) => (routes[e.name] ?? h.route) === undefined ? undefined : { backend: 'chat' as const, route: routes[e.name] ?? h.route }
    return h
  }

  const malformed = async () => 'not json at all'
  it('caller aborts mid-flight never count toward the breaker (ESC-spam safe)', async () => {
    const a1 = new AbortController(); const a2 = new AbortController(); const a3 = new AbortController()
    const h = scriptHarness([
      async () => { a1.abort(); return '{"verdict":"allow","reason":"late"}' },
      async () => { a2.abort(); return '{"verdict":"allow","reason":"late"}' },
      async () => { a3.abort(); return '{"verdict":"allow","reason":"late"}' },
      async () => '{"verdict":"allow","reason":"ok"}',
    ], { Bash: { provider: 'p1', model: 'm1' } })
    const stage = createAutoStage(h.deps)
    const mk = (ctrl: AbortController, id: string) => exec({ signal: ctrl.signal, args: { command: id } })
    // Three caller-cancelled classifications: each resolves cleanly but with
    // the caller's signal already aborted ⇒ 'cancelled' (fail-to-ask, benign
    // reason), and never counted toward the breaker.
    for (const [ctrl, id] of [[a1, 'c1'], [a2, 'c2'], [a3, 'c3']] as const) {
      expect(await stage.maybeEscalate(decided(), mk(ctrl, id))).toEqual({ kind: 'ask', reason: 'classification cancelled by caller' })
    }
    // The breaker never opened: the 4th call still reaches the stream.
    expect(await stage.maybeEscalate(decided(), exec({ args: { command: 'c4' } }))).toBe('allow')
    expect(h.streams).toBe(4)
    expect(h.warnings).toHaveLength(0)
  })
})

describe('R3 restart-durable breaker seeding (session-log)', () => {

  function scriptHarness(
    script: Array<(opts: { signal?: AbortSignal }) => Promise<string>>,
    routes: { [tool: string]: { provider: string; model: string } },
  ): Harness {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, timeoutMs: 30 } } }
    let i = 0
    h.deps.stream = async (opts: { signal?: AbortSignal }) => {
      h.streams += 1
      const next = script[i]
      i += 1
      if (next === undefined) throw new Error('script exhausted')
      return await next(opts)
    }
    h.deps.resolveRoute = (e: ToolExecution) => (routes[e.name] ?? h.route) === undefined ? undefined : { backend: 'chat' as const, route: routes[e.name] ?? h.route }
    return h
  }

  const malformed = async () => 'not json at all'
  function seedLog(session: Session, events: Array<Partial<ClassifierAuditEventData>>): void {
    for (const event of events) {
      appendSessionClassifier(session, {
        tool: 'Bash',
        verdict: 'ask',
        latencyMs: 10,
        cacheHit: false,
        ...event,
      } as ClassifierAuditEventData)
    }
  }
  const fail = (route?: { provider: string; model: string }) => ({
    ...(route === undefined ? {} : { route: `${route.provider}/${route.model}`, provider: route.provider, model: route.model }),
    failure: 'malformed' as const,
  })

  it('pure fold: trailing streak counts attributed failures, resets on success, caps at threshold', () => {
    const route = { provider: 'p1', model: 'm1' }
    const attributed = (failure?: ClassifierAuditEventData['failure']) => ({
      provider: 'p1', model: 'm1', ...(failure === undefined ? {} : { failure }),
    })
    const threshold = 3
    expect(trailingRouteFailureStreak([attributed('malformed'), attributed('malformed')], 'p1/m1', threshold)).toBe(2)
    expect(trailingRouteFailureStreak([attributed('malformed'), attributed('malformed'), attributed()], 'p1/m1', threshold)).toBe(0)
    expect(trailingRouteFailureStreak([attributed('malformed'), attributed('cancelled'), attributed('malformed')], 'p1/m1', threshold)).toBe(2)
    expect(trailingRouteFailureStreak(
      [attributed('malformed'), attributed('malformed'), attributed('malformed'), attributed('malformed')],
      'p1/m1',
      threshold,
    )).toBe(3)
    // Unattributed legacy events and other routes never count.
    expect(trailingRouteFailureStreak([{ failure: 'malformed' }, { provider: 'x', model: 'y', failure: 'malformed' }], 'p1/m1', threshold)).toBe(0)
  })

  it('fresh process + log with 2 attributed trailing failures ⇒ one more failure trips immediately', async () => {
    const h = scriptHarness([malformed], { Bash: { provider: 'p1', model: 'm1' } })
    const session = sessionOf('seed-trip')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' })])
    const stage = createAutoStage(h.deps)
    // The third (live) failure itself still returns its verdict; the breaker
    // opens for every call after it.
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toMatchObject({ kind: 'ask' })
    expect(h.streams).toBe(1)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/breaker|restored|consecutive/i)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'two' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.streams).toBe(1)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(1)
  })

  it('log with fail,fail,success ⇒ streak 0: no seeding effect', async () => {
    const h = scriptHarness([malformed], { Bash: { provider: 'p1', model: 'm1' } })
    const session = sessionOf('seed-reset')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' }), { provider: 'p1', model: 'm1', verdict: 'allow' }])
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toMatchObject({ kind: 'ask' })
    expect(h.streams).toBe(1)
    expect(h.warnings).toHaveLength(0)
  })

  it('unattributed legacy events never seed anything', async () => {
    const h = scriptHarness([malformed], { Bash: { provider: 'p1', model: 'm1' } })
    const session = sessionOf('seed-legacy')
    seedLog(session, [fail(), fail(), fail()])
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toMatchObject({ kind: 'ask' })
    expect(h.streams).toBe(1)
    expect(h.warnings).toHaveLength(0)
  })

  it('concurrent first-calls seed once (synchronous guard) and trip exactly once', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, timeoutMs: 30 } } }
    h.deps.resolveRoute = () => ({ backend: 'chat' as const, route: { provider: 'p1', model: 'm1' } })
    const gates: Array<(value: string) => void> = []
    h.deps.stream = () => new Promise<string>(resolve => { gates.push(resolve) })
    const session = sessionOf('seed-conc')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' })])
    const stage = createAutoStage(h.deps)
    const pA = stage.maybeEscalate(decided(), exec({ session, args: { command: 'a' } }))
    const pB = stage.maybeEscalate(decided(), exec({ session, args: { command: 'b' } }))
    // S3 context-bundle microtask flush before the stream calls register.
    await new Promise(resolve => setImmediate(resolve))
    gates[1]!('not json at all')
    gates[0]!('not json at all')
    // Both calls classify (seeded streak 2 + one live failure each ⇒ trip);
    // the breakers open with exactly ONE warn and ONE breaker audit event.
    expect(await pA).toMatchObject({ kind: 'ask' })
    expect(await pB).toMatchObject({ kind: 'ask' })
    expect(h.warnings).toHaveLength(1)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(1)
  })

  it("log already holding a 'breaker' event ⇒ open at first call, no second audit", async () => {
    const h = scriptHarness([], { Bash: { provider: 'p1', model: 'm1' } })
    const session = sessionOf('seed-prejoin')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' }), { provider: 'p1', model: 'm1', failure: 'breaker' }])
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.streams).toBe(0)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(0)
  })

  it("seeded-open (log failures, no breaker event) first call audits + notices exactly once", async () => {
    const h = scriptHarness([], { Bash: { provider: 'p1', model: 'm1' } })
    const session = sessionOf('seed-open')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' })])
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toEqual({ kind: 'ask', reason: expect.stringMatching(/unavailable/i) })
    expect(h.streams).toBe(0)
    expect(h.warnings).toHaveLength(1)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(1)
  })
})

describe('S3 transcript-aware stage (context bundle, stale-mode, secondPass)', () => {
  /** Stream fake that captures the full stream opts per call. */
  function capturingHarness(outputs: string[], modes: PermissionMode[] = []) {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const opts: Array<{ system: string; prompt: string }> = []
    let i = 0
    h.deps.stream = async (o: { system: string; prompt: string }) => {
      h.streams += 1
      opts.push(o)
      return outputs[i++] ?? '{"verdict":"allow","reason":"ok"}'
    }
    let m = 0
    h.deps.modeOf = () => modes.shift() ?? 'auto'
    return { h, opts }
  }

  it('LOW rule-ask NEVER reaches the LLM (pinned; the stage never arbitrates rule-derived asks)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ decision: { kind: 'ask', reason: 'by rule' } }), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.deps.audit).not.toHaveBeenCalled()
  })

  it('LOW + MEDIUM passthrough reach the LLM; read-only never does (eligibility matrix)', async () => {
    for (const level of ['LOW', 'MEDIUM'] as const) {
      const h = harness()
      h.settings.value = { autoMode: { classifier: { enabled: true } } }
      const stage = createAutoStage(h.deps)
      expect(await stage.maybeEscalate(decided({ risk: { level, reasons: [] } }), exec())).toBe('allow')
      expect(h.streams).toBe(1)
    }
  })

  it('the context bundle rides the classify call: user_intent/tool_history/project_instructions sections', async () => {
    const { h, opts } = capturingHarness(['{"verdict":"ask","reason":"no"}'])
    // Session cwd = a temp dir carrying an AGENTS.md (instructions loader target).
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const cwd = mkdtempSync(join(tmpdir(), 's3-stage-'))
    writeFileSync(join(cwd, 'AGENTS.md'), 'Keep the workspace tidy.')
    const session = sessionOf('ctx-bundle', cwd)
    // Human intent message + a read-only tool call (filtered) + a mutating one.
    session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'please clean up the build dir' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1' as never, name: 'Read', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 2, callId: 'c2' as never, name: 'Bash', arguments: '{"command":"rm -rf build"}' })
    h.deps.readOnlyTools = new Set(['Read'])
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), exec({ session, args: { command: 'rm -rf build' } }))
    expect(opts[0]!.prompt).toContain('<user_intent>\nplease clean up the build dir\n</user_intent>')
    expect(opts[0]!.prompt).toContain('Bash: rm -rf build')
    expect(opts[0]!.prompt).not.toContain('Read: /w/a.ts')
    expect(opts[0]!.prompt).toContain('<project_instructions>')
  })

  it('enrichment: a work-discarding command with runCommand injects <context>; no runner ⇒ omitted', async () => {
    const runner = vi.fn(async () => ' M build/out.txt\n')
    const { h, opts } = capturingHarness(['{"verdict":"allow","reason":"ok"}'])
    const session = sessionOf('ctx-enrich')
    h.deps.runCommand = runner
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), exec({ session, args: { command: 'git reset --hard' } }))
    expect(opts[0]!.prompt).toContain('<context>')
    expect(opts[0]!.prompt).toContain('M build/out.txt')
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('git'), expect.objectContaining({ timeoutMs: 1000, cwd: '/work' }))
    // Non-matching command ⇒ no runner call, no section.
    const { h: h2, opts: opts2 } = capturingHarness(['{"verdict":"allow","reason":"ok"}'])
    h2.deps.runCommand = vi.fn(async () => '')
    const stage2 = createAutoStage(h2.deps)
    await stage2.maybeEscalate(decided(), exec({ session, args: { command: 'ls' } }))
    expect(opts2[0]!.prompt).not.toContain('<context>')
  })

  it('A8 stale-mode: mode left auto mid-flight ⇒ discarded + audit failure stale-mode, NOT breaker-counted', async () => {
    const { h, opts } = capturingHarness(['{"verdict":"allow","reason":"ok"}'], ['auto', 'default'])
    const session = sessionOf('stale-1')
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'c1' } }))).toBeUndefined()
    expect(opts).toHaveLength(1) // the classify ran…
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string; verdict?: string }]>
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toMatchObject({ failure: 'stale-mode', verdict: 'ask' })
    expect(h.warnings).toHaveLength(0) // not a breaker event
    // …and the failure did NOT accrue: one malformed call later cannot trip (streak starts at 0).
    h.deps.stream = async () => 'garbage }}'
    const out = await stage.maybeEscalate(decided(), exec({ session, args: { command: 'c2' } }))
    expect(out).toMatchObject({ kind: 'ask' })
    expect(h.warnings).toHaveLength(0)
  })

  it('A8: same mode re-folded (deployment-default auto, no mode events) ⇒ the verdict applies', async () => {
    const { h, opts } = capturingHarness(['{"verdict":"allow","reason":"ok"}'], ['auto', 'auto'])
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionOf('stale-ok') }))).toBe('allow')
    expect(opts).toHaveLength(1)
  })

  it('D13 secondPass at the stage: settings flag ⇒ one reconsider call, ask→allow flip, audit secondPass:true', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, secondPass: true } } }
    const session = sessionOf('sp-flip')
    const opts: Array<{ system: string; prompt: string }> = []
    h.deps.stream = async (o: { system: string; prompt: string }) => {
      h.streams += 1
      opts.push(o)
      return h.streams === 1 ? '{"verdict":"ask","reason":"unsure"}' : '{"verdict":"allow","reason":"authorized"}'
    }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided(), exec({ session, args: { command: 'c1' } }))
    expect(out).toBe('allow')
    expect(h.streams).toBe(2)
    expect(opts[1]!.system).toMatch(/RECONSIDER/)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { secondPass?: boolean; verdict: string }]>
    expect(calls[0]![1]).toMatchObject({ verdict: 'allow', secondPass: true })
    // The memoization raw string includes secondPass: flipping the flag and
    // rebuilding drops the memoized classifier (a fresh ask is reconsidered again).
    h.deps.stream = async (o: { system: string; prompt: string }) => {
      h.streams += 1
      return '{"verdict":"ask","reason":"still unsure"}'
    }
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    stage.rebuild()
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'c1' } }))).toEqual({ kind: 'ask', reason: 'still unsure' })
    expect(h.streams).toBe(3) // rebuilt classifier consulted (raw-string change), no second pass
  })

  it('D13 secondPass default OFF: an ask verdict stays ask with ONE stream call', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.scripted = ['{"verdict":"ask","reason":"unsure"}']
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionOf('sp-off') }))).toEqual({ kind: 'ask', reason: 'unsure' })
    expect(h.streams).toBe(1)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { secondPass?: boolean }]>
    expect(calls[0]![1].secondPass).toBeUndefined()
  })

  it('D10: the audit reason is control-char-stripped and capped at 120 chars', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const dirty = `x\x00y\x1f${'q'.repeat(200)}`
    h.scripted = [JSON.stringify({ verdict: 'ask', reason: dirty })]
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), exec({ session: sessionOf('reason-cap') }))
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { reason?: string }]>
    const reason = calls[0]![1].reason ?? ''
    expect(reason.length).toBeLessThanOrEqual(120)
    expect(reason).not.toMatch(/[\x00-\x1f\x7f]/)
  })

})

describe('S5 full-text audit (classifier.auditFullText)', () => {
  function lastAudit(h: Harness): ClassifierAuditEventData {
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, ClassifierAuditEventData]>
    expect(calls.length).toBeGreaterThan(0)
    return calls.at(-1)![1]
  }

  it('default (flag off): audit events stay digest-only — no `input` key', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), exec({ session: sessionOf('s5-off') }))
    const audit = lastAudit(h)
    expect(audit.digest).toMatch(/^[0-9a-f]{64}$/)
    expect('input' in audit).toBe(false)
  })

  it('flag on: the audit event gains the full rendered input; digest = sha256(input)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, auditFullText: true } } }
    const stage = createAutoStage(h.deps)
    await stage.maybeEscalate(decided(), exec({ session: sessionOf('s5-on'), args: { command: 'ls -la /work' } }))
    const audit = lastAudit(h)
    expect(typeof audit.input).toBe('string')
    expect(audit.input).toContain('ls -la /work')
    const expectedDigest = createHash('sha256').update(audit.input!).digest('hex')
    expect(audit.digest).toBe(expectedDigest)
  })

  it('hot reload: toggling the setting takes effect on the NEXT event without a restart', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true, auditFullText: true } } }
    const stage = createAutoStage(h.deps)
    const session = sessionOf('s5-toggle')
    await stage.maybeEscalate(decided(), exec({ session }))
    expect(typeof lastAudit(h).input).toBe('string')
    // Flip OFF: next event loses the input — same stage instance, no rebuild() needed.
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    await stage.maybeEscalate(decided(), exec({ session, args: { command: 'pwd' } }))
    expect('input' in lastAudit(h)).toBe(false)
    // Flip back ON.
    h.settings.value = { autoMode: { classifier: { enabled: true, auditFullText: true } } }
    await stage.maybeEscalate(decided(), exec({ session, args: { command: 'pwd' } }))
    expect(typeof lastAudit(h).input).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// PR-B unit B2b: System One gauge branch (wire stubbed via `fetchImpl`).
// ---------------------------------------------------------------------------

/** T1 probe envelope (.impl/2026-09-25-gauge-system-one-probe-evidence.md): allow on `git status`. */
const T1_ENVELOPE = {
  model: 'laya-rl-agent',
  answers: {
    verdict: {
      type: 'choice',
      choice: 'allow',
      probabilities: { allow: 0.5015, ask: 0.2658, deny: 0.2327 },
      confidence: 0.0555,
    },
  },
  usage: { input_tokens: 83, output_tokens: 0 },
}

function gaugeHarness(envelopes: unknown[], backend?: Partial<{ baseURL: string; model: string }>) {
  const h = harness()
  h.settings.value = { autoMode: { classifier: { enabled: true } } }
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(envelopes.length > 0 ? envelopes.shift() : T1_ENVELOPE),
  })) as unknown as typeof fetch
  h.deps.fetchImpl = fetchImpl
  h.deps.resolveRoute = () => ({
    backend: 'systemone' as const,
    provider: 'deepseek',
    model: backend?.model ?? 'llmbox_systemone/laya',
    baseURL: backend?.baseURL ?? 'http://127.0.0.1:8080',
  })
  return { h, fetchImpl }
}

function envelopeWith(choice: string, probabilities: Record<string, number>, inputTokens = 83): unknown {
  return { ...T1_ENVELOPE, answers: { verdict: { type: 'choice', choice, probabilities, confidence: 0.05 } }, usage: { input_tokens: inputTokens, output_tokens: 0 } }
}

describe('auto-stage × System One gauge lane (B2b)', () => {
  function lastAudit(h: Harness): ClassifierAuditEventData {
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, ClassifierAuditEventData]>
    expect(calls.length).toBeGreaterThan(0)
    return calls.at(-1)![1]
  }

  it('armed systemone + T1 allow envelope ⇒ allow, no chat stream call, ONE audit event with provider/model + probabilities/confidence', async () => {
    const { h, fetchImpl } = gaugeHarness([structuredClone(T1_ENVELOPE)])
    const stage = createAutoStage(h.deps)
    const session = sessionOf('g1-allow')
    expect(await stage.maybeEscalate(decided(), exec({ session }))).toBe('allow')
    expect(h.streams).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const audit = lastAudit(h)
    expect(audit).toMatchObject({
      tool: 'Bash',
      verdict: 'allow',
      provider: 'deepseek',
      model: 'llmbox_systemone/laya',
      route: 'systemone/llmbox_systemone/laya',
      probabilities: T1_ENVELOPE.answers.verdict.probabilities,
      confidence: 0.0555,
      cacheHit: false,
    })
  })

  it('deny answer collapses to ask with the pinned deny-downgrade reason; audit verdict is ask (post-gating)', async () => {
    const { h } = gaugeHarness([envelopeWith('deny', { allow: 0.2, ask: 0.3, deny: 0.5 })])
    const stage = createAutoStage(h.deps)
    const session = sessionOf('g2-deny')
    const out = await stage.maybeEscalate(decided(), exec({ session }))
    expect(out).toMatchObject({ kind: 'ask' })
    expect((out as { kind: 'ask'; reason: string }).reason).toContain('deny downgraded: gauge cannot cite an exact hard-deny rule')
    expect(lastAudit(h).verdict).toBe('ask')
  })

  it('truncated usage (input_tokens = window) ⇒ ask with the truncation reason', async () => {
    const { h } = gaugeHarness([envelopeWith('allow', { allow: 0.9, ask: 0.05, deny: 0.05 }, 1024)])
    const stage = createAutoStage(h.deps)
    const session = sessionOf('g3-truncated')
    expect(await stage.maybeEscalate(decided(), exec({ session }))).toEqual({ kind: 'ask', reason: 'state truncated by gateway' })
    expect(lastAudit(h).verdict).toBe('ask')
  })

  it('failure path (fetch 400 envelope) ⇒ failure error counted by the breaker and audited; breaker opens after the threshold', async () => {
    const { h, fetchImpl } = gaugeHarness()
    fetchImpl.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }),
    }))
    const stage = createAutoStage(h.deps)
    const session = sessionOf('g4-error')
    for (let i = 0; i < 3; i += 1) {
      expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: `cmd-${i}` } }))).toMatchObject({ kind: 'ask' })
      expect(lastAudit(h).failure).toBe('error')
    }
    // 4th call: the breaker for `systemone/<model>` is open.
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'cmd-3' } })))
      .toEqual({ kind: 'ask', reason: 'auto-mode classifier unavailable: route systemone/llmbox_systemone/laya breaker open' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('verdict LRU: an identical call is served from the cache (cacheHit, one wire call)', async () => {
    const { h, fetchImpl } = gaugeHarness([structuredClone(T1_ENVELOPE)])
    const stage = createAutoStage(h.deps)
    const session = sessionOf('g5-cache')
    expect(await stage.maybeEscalate(decided(), exec({ session }))).toBe('allow')
    expect(await stage.maybeEscalate(decided(), exec({ session }))).toBe('allow')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(lastAudit(h).cacheHit).toBe(true)
  })
})
