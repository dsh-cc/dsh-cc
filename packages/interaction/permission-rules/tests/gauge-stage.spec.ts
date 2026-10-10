import { describe, expect, it, vi } from 'vitest'
import { createSystemOneLane, systemOneEscalate, type SystemOneClassification, type SystemOneLane, type SystemOneStageFaces } from '../src/gauge-stage.ts'
import { classificationKey } from '../src/llm-classifier.ts'
import { parseRule } from '../src/parser.ts'
import type { PermissionRule } from '../src/types.ts'

const EXEC = { name: 'Bash', arguments: { command: 'python3 -c "print(1)"' } } as never
const SLOTS = { hardDeny: [], softDeny: [], allowExceptions: [], environment: [] }
const BACKEND = { provider: 'p', model: 'm', baseURL: 'http://x' }

const ALLOW_EVENT = (rule: string): unknown => ({
  type: 'permission/session-allow',
  data: { rule, scope: 'session', toolName: 'Bash', timestamp: 1 },
})

const RULE = (raw: string): PermissionRule => parseRule(raw, 'allow', 'userSettings')

function faces(): SystemOneStageFaces {
  return {
    breaker: { isOpen: () => false, record: () => {}, auditOnce: () => {} } as never,
    seed: () => {},
    modeOf: () => 'auto',
    audit: () => {},
    pauseAuto: () => {},
  }
}

function makeFetch(states: string[], questions: string[] = []) {
  return vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: string; questions: Record<string, unknown> }
    states.push(body.state)
    questions.push(JSON.stringify(body.questions))
    return Response.json({
      model: 'laya',
      answers: { verdict: { type: 'choice', choice: 'ask', probabilities: { allow: 0.3, ask: 0.5, deny: 0.2 } } },
      usage: { input_tokens: 83, output_tokens: 0 },
    })
  }) as unknown as typeof fetch
}

describe('systemOneEscalate: grant → cache rotation (Fix B)', () => {
  it('a new session grant changes the evidence, the rendered question, and the cache key', async () => {
    const states: string[] = []
    const questions: string[] = []
    const lane = createSystemOneLane(8, { fetchImpl: makeFetch(states, questions) })
    const events: unknown[] = [ALLOW_EVENT('Bash(python3:*)')]
    const exec = { name: 'Bash', arguments: { command: 'python3 -c "print(1)"' }, agent: { session: { header: { id: 's1' }, snapshotEvents: () => events } } } as never
    const opts = {
      slots: SLOTS,
      gaugeAllowThreshold: 0.5,
      timeoutMs: 1000,
      auditFullText: false,
      gaugeAllowEvidence: true as const,
      allowEvidenceRules: [] as PermissionRule[],
    }
    const first = await systemOneEscalate(exec, BACKEND, lane, faces(), opts)
    expect(first).toEqual({ kind: 'ask', reason: 'gauge judged ask (P(ask)=0.500)' })
    // Evidence rides the allowExceptions slot → the question JSON (the state
    // itself stays the compact tool call), and it feeds classificationKey.
    expect(questions[0]).toContain('Pre-authorized this session: Bash(python3:*)')
    // Second identical call: verdict LRU hit, no new wire call.
    await systemOneEscalate(exec, BACKEND, lane, faces(), opts)
    expect(states.length).toBe(1)
    // A new grant appends an event → evidence changes → key rotates → re-call.
    events.push(ALLOW_EVENT('Bash(uv run:*)'))
    await systemOneEscalate(exec, BACKEND, lane, faces(), opts)
    expect(states.length).toBe(2)
    expect(questions[1]).toContain('Pre-authorized this session: Bash(uv run:*)')
  })

  it('gaugeAllowEvidence:false keeps the state evidence-free', async () => {
    const states: string[] = []
    const questions: string[] = []
    const lane = createSystemOneLane(8, { fetchImpl: makeFetch(states, questions) })
    const opts = {
      slots: SLOTS,
      gaugeAllowThreshold: 0.5,
      timeoutMs: 1000,
      auditFullText: false,
      gaugeAllowEvidence: false as const,
      allowEvidenceRules: [RULE('Bash(python3:*)')],
    }
    await systemOneEscalate(EXEC, BACKEND, lane, faces(), opts)
    expect(questions[0]).not.toContain('Pre-authorized')
  })

  it('no evidence collected (no session, no rules): state matches the bare slots', async () => {
    const states: string[] = []
    const lane = createSystemOneLane(8, { fetchImpl: makeFetch(states) })
    const opts = {
      slots: SLOTS,
      gaugeAllowThreshold: 0.5,
      timeoutMs: 1000,
      auditFullText: false,
      gaugeAllowEvidence: true as const,
      allowEvidenceRules: [] as PermissionRule[],
    }
    await systemOneEscalate(EXEC, BACKEND, lane, faces(), opts)
    expect(states[0]).toBe('{"tool":"Bash","command":"python3 -c \\"print(1)\\""}')
  })
})

// ---------------------------------------------------------------------------
// Underspec→ASK detector (design doc 2026-10-09 §3.2/§3.3/§5)
// ---------------------------------------------------------------------------

const DETECTOR_REASON = 'target/scope under-specified (underspec detector)'

/** A lane stub with a fully-controlled classification (merge-table driver). */
function stubLane(result: Partial<SystemOneClassification> = {}): SystemOneLane {
  return {
    classify: async () => ({
      tool: 'Bash',
      digest: 'd',
      input: 'i',
      verdict: 'allow',
      reason: '',
      routeAlias: 'systemone/m',
      provider: 'p',
      model: 'm',
      latencyMs: 1,
      cacheHit: false,
      ...result,
    }),
  }
}

/** Envelope whose verdict + ambiguity answers are both controlled. */
function envelope(allowProbability: number, ambiguity?: string): unknown {
  return {
    model: 'laya-rl-agent',
    answers: {
      verdict: { type: 'choice', choice: 'allow', probabilities: { allow: allowProbability, ask: 0.3, deny: 0.1 } },
      ...(ambiguity === undefined ? {} : { ambiguity: { type: 'choice', choice: ambiguity } }),
    },
    usage: { input_tokens: 83, output_tokens: 0 },
  }
}

function makeCapturingFetch(envelopes: unknown[], bodies: Array<{ questions: unknown }>): typeof fetch {
  return vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { questions: unknown }
    bodies.push({ questions: body.questions })
    return Response.json(envelopes.length > 0 ? envelopes.shift() : envelopes)
  }) as unknown as typeof fetch
}

describe('underspec→ASK: merge rule (§5.2 truth table)', () => {
  const CELLS: Array<{ verdict: 'allow' | 'ask'; ambiguity: 'specified' | 'underspecified' | undefined; escalated: boolean }> = [
    { verdict: 'allow', ambiguity: 'underspecified', escalated: true },
    { verdict: 'allow', ambiguity: 'specified', escalated: false },
    { verdict: 'allow', ambiguity: undefined, escalated: false },
    { verdict: 'ask', ambiguity: 'underspecified', escalated: false },
    { verdict: 'ask', ambiguity: 'specified', escalated: false },
    { verdict: 'ask', ambiguity: undefined, escalated: false },
  ]
  for (const cell of CELLS) {
    it(`verdict=${cell.verdict} × ambiguity=${String(cell.ambiguity)} ⇒ ${cell.escalated ? 'ask (escalated)' : 'unchanged'}`, async () => {
      const audits: ClassifierAuditEventData[] = []
      const face = faces()
      face.audit = (_session, event) => { audits.push(event) }
      const lane = stubLane({
        verdict: cell.verdict,
        reason: cell.verdict === 'allow' ? '' : 'gauge judged ask',
        ...(cell.ambiguity === undefined ? {} : { ambiguity: cell.ambiguity }),
      })
      const opts = {
        slots: SLOTS,
        gaugeAllowThreshold: 0.5,
        timeoutMs: 1000,
        auditFullText: false,
        gaugeAllowEvidence: false as const,
        ambiguityAsk: true as const,
        task: 'delete the one file',
      }
      const exec = { name: 'Bash', arguments: { command: 'rm -rf .' }, agent: { session: { header: { id: 's' }, snapshotEvents: () => [] } } } as never
      const out = await systemOneEscalate(exec, BACKEND, lane, face, opts)
      const audit = audits.at(-1)!
      if (cell.escalated) {
        expect(out).toEqual({ kind: 'ask', reason: DETECTOR_REASON })
      } else if (cell.verdict === 'allow') {
        expect(out).toBe('allow')
      } else {
        expect(out).toEqual({ kind: 'ask', reason: 'gauge judged ask' })
      }
      // §5.3: the audited event EQUALS the returned stage decision on every path.
      expect(audit.verdict).toBe(cell.escalated ? 'ask' : cell.verdict)
      expect(audit.reason).toBe(cell.escalated ? DETECTOR_REASON : (cell.verdict === 'allow' ? '' : 'gauge judged ask'))
      expect(audit.ambiguity).toBe(cell.ambiguity)
    })
  }
})

describe('underspec→ASK: cache + key plumbing (§5.5)', () => {
  it('flag toggle produces a different classificationKey (dedicated trailing param)', () => {
    const base = ['Bash', '{"tool":"Bash"}', [], [], []] as const
    expect(classificationKey(...base, undefined, [], true)).not.toBe(classificationKey(...base, undefined, [], false))
    expect(classificationKey(...base, undefined, [], false)).toBe(classificationKey(...base, undefined, [], undefined))
  })

  it('cache-hit carries ambiguity via the ...cached spread; escalated cache hits stay escalated', async () => {
    const bodies: Array<{ questions: unknown }> = []
    const envelope = {
      model: 'm',
      answers: {
        verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.9, ask: 0.05, deny: 0.05 } },
        ambiguity: { type: 'choice', choice: 'underspecified' },
      },
      usage: { input_tokens: 83, output_tokens: 0 },
    }
    const lane = createSystemOneLane(8, { fetchImpl: makeCapturingFetch([envelope], bodies) })
    const audits: ClassifierAuditEventData[] = []
    const face = faces()
    face.audit = (_session, event) => { audits.push(event) }
    const opts = {
      slots: SLOTS,
      allowThreshold: 0.5,
      timeoutMs: 1000,
      ambiguityAsk: true as const,
      task: 'delete the one file',
    }
    // Warm the cache with the SAME exec the escalation below uses, so the
    // escalate call exercises the cache-HIT escalation path (§5.3).
    const exec = { name: 'Bash', arguments: { command: 'rm -rf .' }, agent: { session: { header: { id: 's' }, snapshotEvents: () => [] } } } as never
    const first = await lane.classify(exec, BACKEND, opts)
    expect(first.ambiguity).toBe('underspecified')
    const second = await lane.classify(exec, BACKEND, opts)
    expect(second.cacheHit).toBe(true)
    expect(second.ambiguity).toBe('underspecified')
    // §5.3: escalation on the cache-hit path too, event says ask + detector reason.
    const out = await systemOneEscalate(exec, BACKEND, lane, face, { ...opts, gaugeAllowThreshold: 0.5, auditFullText: false, gaugeAllowEvidence: false as const })
    expect(out).toEqual({ kind: 'ask', reason: DETECTOR_REASON })
    const audit = audits.at(-1)!
    expect(audit.verdict).toBe('ask')
    expect(audit.reason).toBe(DETECTOR_REASON)
    expect(audit.cacheHit).toBe(true)
    expect(audit.ambiguity).toBe('underspecified')
    expect(bodies.length).toBe(1) // one wire call, second served from the LRU
  })

  it('flag off ⇒ no ambiguity question on the wire and no escalation, even if the envelope claims underspecified', async () => {
    const bodies: Array<{ questions: unknown }> = []
    const envelope = {
      model: 'm',
      answers: {
        verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.9, ask: 0.05, deny: 0.05 } },
        ambiguity: { type: 'choice', choice: 'underspecified' },
      },
      usage: { input_tokens: 83, output_tokens: 0 },
    }
    const lane = createSystemOneLane(8, { fetchImpl: makeCapturingFetch([envelope], bodies) })
    const audits: ClassifierAuditEventData[] = []
    const face = faces()
    face.audit = (_session, event) => { audits.push(event) }
    const opts = { slots: SLOTS, gaugeAllowThreshold: 0.5, timeoutMs: 1000 }
    const exec = { name: 'Bash', arguments: { command: 'rm -rf .' }, agent: { session: { header: { id: 's' }, snapshotEvents: () => [] } } } as never
    const out = await systemOneEscalate(exec, BACKEND, lane, face, opts)
    expect(out).toBe('allow')
    expect(bodies[0]!.questions).not.toHaveProperty('ambiguity')
    expect(audits.at(-1)!.ambiguity).toBeUndefined()
  })

  it('failure rows omit the ambiguity field', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }) })) as unknown as typeof fetch
    const lane = createSystemOneLane(8, { fetchImpl })
    const audits: ClassifierAuditEventData[] = []
    const face = faces()
    face.audit = (_session, event) => { audits.push(event) }
    const opts = { slots: SLOTS, gaugeAllowThreshold: 0.5, timeoutMs: 1000, ambiguityAsk: true as const, task: 't' }
    const exec = { name: 'Bash', arguments: { command: 'rm -rf .' }, agent: { session: { header: { id: 's' }, snapshotEvents: () => [] } } } as never
    const out = await systemOneEscalate(exec, BACKEND, lane, face, opts)
    expect(out).toMatchObject({ kind: 'ask' })
    const audit = audits.at(-1)!
    expect(audit.failure).toBe('error')
    expect('ambiguity' in audit).toBe(false)
  })
})
