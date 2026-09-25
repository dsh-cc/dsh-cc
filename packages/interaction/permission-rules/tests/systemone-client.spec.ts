import { describe, expect, it, vi } from 'vitest'
import { systemoneDecide } from '../src/systemone-client.ts'
import type { SystemOneQuestion } from '../src/systemone-client.ts'

// Verbatim T1 probe envelope (2026-09-25-gauge-system-one-probe-evidence.md).
const T1_BODY = '{"model":"laya-rl-agent","answers":{"verdict":{"type":"choice","choice":"allow","probabilities":{"allow":0.5015,"ask":0.2658,"deny":0.2327},"confidence":0.0555,"action":{"act_probability":1}}},"usage":{"input_tokens":83,"output_tokens":0}}'

const QUESTIONS: Record<string, SystemOneQuestion> = {
  verdict: { type: 'choice', instructions: 'Judge.', criteria: { allow: 'safe', ask: 'writes', deny: 'destructive' } },
}

function jsonFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

function okFetch() {
  return jsonFetch(200, T1_BODY)
}

describe('systemoneDecide', () => {
  it('happy path returns parsed envelope from the probe transcript', async () => {
    const fetchImpl = okFetch()
    const result = await systemoneDecide({ baseURL: 'http://127.0.0.1:8080', model: 'llmbox_systemone/laya', state: { tool: 'Bash', command: 'git status' }, questions: QUESTIONS, timeoutMs: 1000, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/systemone', expect.objectContaining({ method: 'POST' }))
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(call[1].body as string)).toEqual({ model: 'llmbox_systemone/laya', state: { tool: 'Bash', command: 'git status' }, questions: QUESTIONS })
    expect(result).toEqual({
      ok: true,
      model: 'laya-rl-agent',
      answers: { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.5015, ask: 0.2658, deny: 0.2327 }, confidence: 0.0555 } },
      usage: { input_tokens: 83, output_tokens: 0 },
    })
  })

  it('drops extra unknown-type answer entries but keeps valid ones', async () => {
    const body = JSON.stringify({
      model: 'laya-rl-agent',
      answers: {
        verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.5 }, confidence: 0.05 },
        future: { type: 'quantum', qubits: 3 },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const result = await systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl: jsonFetch(200, body) })
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.answers)).toEqual(['verdict'])
  })

  it('400 envelope maps to non-retryable error with status and body prefix', async () => {
    const body = '{"error":{"type":"invalid_request_error","message":"model must be \\"laya\\""}}'
    const result = await systemoneDecide({ baseURL: 'http://x', model: 'bogus/not-a-model', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl: jsonFetch(400, body) })
    expect(result).toEqual({ ok: false, failure: 'error', reason: `http 400: ${body}` })
  })

  it('own timer fires => timeout', async () => {
    vi.useFakeTimers()
    try {
      const promise = systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 5, fetchImpl: ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch })
      const expectation = expect(promise).resolves.toEqual({ ok: false, failure: 'timeout', reason: 'timed out after 5ms' })
      await vi.advanceTimersByTimeAsync(10)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('caller signal abort => cancelled', async () => {
    const controller = new AbortController()
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      init?.signal?.addEventListener('abort', () => controller.abort())
    })) as unknown as typeof fetch
    const promise = systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 10_000, signal: controller.signal, fetchImpl })
    controller.abort()
    await expect(promise).resolves.toEqual({ ok: false, failure: 'cancelled', reason: 'caller aborted the request' })
  })

  it('fetch throw maps to error', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl })
    expect(result).toEqual({ ok: false, failure: 'error', reason: 'ECONNREFUSED' })
  })

  it('200 without answers object => malformed', async () => {
    const result = await systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl: jsonFetch(200, '{"model":"laya-rl-agent"}') })
    expect(result).toEqual({ ok: false, failure: 'malformed', reason: 'systemone response failed schema validation' })
  })

  it('200 whose answers are all unknown-type => malformed', async () => {
    const body = JSON.stringify({ model: 'laya-rl-agent', answers: { verdict: { type: 'quantum' } }, usage: { input_tokens: 1, output_tokens: 0 } })
    const result = await systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl: jsonFetch(200, body) })
    expect(result).toEqual({ ok: false, failure: 'malformed', reason: 'systemone response failed schema validation' })
  })

  it('omits Authorization when apiKey absent, sends Bearer when set', async () => {
    const without = okFetch()
    await systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl: without })
    const withoutCall = (without as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((withoutCall[1].headers as Record<string, string>).authorization).toBeUndefined()

    const withKey = okFetch()
    await systemoneDecide({ baseURL: 'http://x', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, apiKey: 'secret', fetchImpl: withKey })
    const withCall = (withKey as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((withCall[1].headers as Record<string, string>).authorization).toBe('Bearer secret')
  })

  it('strips a trailing slash from baseURL', async () => {
    const fetchImpl = okFetch()
    await systemoneDecide({ baseURL: 'http://127.0.0.1:8080/', model: 'laya', state: {}, questions: QUESTIONS, timeoutMs: 1000, fetchImpl })
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(call[0]).toBe('http://127.0.0.1:8080/v1/systemone')
  })
})
