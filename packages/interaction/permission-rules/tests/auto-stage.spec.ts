import { describe, expect, it, vi } from 'vitest'
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

function sessionOf(id: string): Session {
  return Session.create(SessionId(id), undefined, { version: 2, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd: '/work' })
}

function decided(overrides: Partial<DecidedCall> = {}): DecidedCall {
  const decision: PermissionDecision = overrides.decision ?? { kind: 'ask', reason: 'rule ask' }
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
    resolveRoute: () => h.route,
    warn: (message: string) => { h.warnings.push(message) },
    audit: vi.fn(),
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

  it('armed: consults the classifier only for auto + LOW + ask/passthrough (verdict allow ⇒ allow)', async () => {
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

  it('I5: MEDIUM risk ⇒ no escalation regardless of stage state', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ risk: { level: 'MEDIUM', reasons: ['outside cwd'] } }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
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
  it('no resolvable route: warns once per process, appends one unarmed audit event, falls back to legacy', async () => {
    const h = harness()
    h.route = undefined
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const session = sessionOf('unarmed-1')
    const stage = createAutoStage(h.deps)
    const execWithSession = exec({ session })
    expect(await stage.maybeEscalate(decided(), execWithSession)).toBeUndefined()
    expect(await stage.maybeEscalate(decided(), execWithSession)).toBeUndefined()
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/classifier|route|unarm/i)
    // The unarmed audit event is per call (each fell back to the legacy path);
    // the warning is the once-per-process half.
    expect(h.deps.audit).toHaveBeenCalledTimes(2)
    expect(h.deps.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failure: 'unarmed' }))
  })

  it('no llm stream capability mounted: disarmed with one warning', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.deps.stream = undefined
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBeUndefined()
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/classifier|route|unarm/i)
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
    expect(Object.keys(calls[0]![1]).sort()).toEqual(['cacheHit', 'digest', 'latencyMs', 'model', 'provider', 'route', 'tool', 'verdict'])
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
    h.deps.resolveRoute = (e: ToolExecution) => routes[e.name] ?? h.route
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
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c4' } }))).toBeUndefined()
    expect(h.streams).toBe(3)
    expect(h.warnings).toHaveLength(1)
    // 5th call in a NEW session: still no stream, still one warn, its own breaker audit.
    const sessionB = sessionOf('brk-b')
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionB, args: { command: 'c5' } }))).toBeUndefined()
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
    expect(await stage.maybeEscalate(decided(), exec({ name: 'Y', args: { command: 'y4' } }))).toBeUndefined()
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
      expect(await stage.maybeEscalate(decided(), exec({ args: { command: `u${i}` } }))).toBeUndefined()
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
    expect(await stage.maybeEscalate(decided(), exec({ session: sessionA, args: { command: 'c7' } }))).toBeUndefined()
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
    h.deps.resolveRoute = (e: ToolExecution) => routes[e.name] ?? h.route
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
    h.deps.resolveRoute = (e: ToolExecution) => routes[e.name] ?? h.route
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
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'two' } }))).toBeUndefined()
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
    h.deps.resolveRoute = () => ({ provider: 'p1', model: 'm1' })
    const gates: Array<(value: string) => void> = []
    h.deps.stream = () => new Promise<string>(resolve => { gates.push(resolve) })
    const session = sessionOf('seed-conc')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' })])
    const stage = createAutoStage(h.deps)
    const pA = stage.maybeEscalate(decided(), exec({ session, args: { command: 'a' } }))
    const pB = stage.maybeEscalate(decided(), exec({ session, args: { command: 'b' } }))
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
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toBeUndefined()
    expect(h.streams).toBe(0)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(0)
  })

  it("seeded-open (log failures, no breaker event) first call audits + notices exactly once", async () => {
    const h = scriptHarness([], { Bash: { provider: 'p1', model: 'm1' } })
    const session = sessionOf('seed-open')
    seedLog(session, [fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' }), fail({ provider: 'p1', model: 'm1' })])
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec({ session, args: { command: 'one' } }))).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.warnings).toHaveLength(1)
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { failure?: string }]>
    expect(calls.filter(([, e]) => e.failure === 'breaker')).toHaveLength(1)
  })
})
