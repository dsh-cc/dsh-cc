import { describe, expect, it, vi } from 'vitest'
import { createSystemOneLane, systemOneEscalate, type SystemOneStageFaces } from '../src/gauge-stage.ts'
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
