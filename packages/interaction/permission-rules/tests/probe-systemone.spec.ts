import { describe, expect, it, vi } from 'vitest'
import { probeNoulOnce } from '../src/probe-systemone.ts'
import { estimateSystemOneTokens } from '../src/systemone-budget.ts'

const INFO = { provider: 'p', model: 'm', baseURL: 'http://x' }

function makeFetch(body: { state?: string }, answers: Record<string, unknown>, inputTokens = 83) {
  return vi.fn(async (_url: unknown, init: { body: string }) => {
    body.state = (JSON.parse(init.body) as { state: string }).state
    return Response.json({ model: 'laya', answers, usage: { input_tokens: inputTokens, output_tokens: 0 } })
  }) as unknown as typeof fetch
}

describe('probeNoulOnce rewindow (Fix A token budget)', () => {
  it('short input passes through uncapped', async () => {
    const body: { state?: string } = {}
    const outcome = await probeNoulOnce({ name: 'Bash' }, INFO, 'short text', { timeoutMs: 1000, fetchImpl: makeFetch(body, { noul: { type: 'noul', noul: 0.1 } }) })
    expect(outcome.flag).toBe(false)
    expect(JSON.parse(body.state!).text).toBe('short text')
  })

  it('oversized input is middle-elided within the window token budget, head 2/3 + tail 1/3', async () => {
    const body: { state?: string } = {}
    const text = `a${'x'.repeat(5000)}z`
    const outcome = await probeNoulOnce({ name: 'Bash' }, INFO, text, { timeoutMs: 1000, fetchImpl: makeFetch(body, { noul: { type: 'noul', noul: 0.1 } }) })
    expect(outcome.flag).toBe(false)
    const inner = JSON.parse(body.state!).text as string
    expect(inner).toContain('… probe input truncated …')
    expect(inner.startsWith('axxxx')).toBe(true)
    expect(inner.endsWith('xxxxz')).toBe(true)
    // The whole serialized state must fit the 1024-token window per the
    // estimator (a lower bound on the gateway's real count).
    expect(estimateSystemOneTokens(body.state!)).toBeLessThanOrEqual(1024)
  })

  it('CJK-dense input no longer trips the old char-math: no truncation sentinel', async () => {
    const body: { state?: string } = {}
    const text = '这是一个用于校准探针窗口的句子。'.repeat(80) // ~1280 CJK chars
    const outcome = await probeNoulOnce({ name: 'Bash' }, INFO, text, { timeoutMs: 1000, fetchImpl: makeFetch(body, { noul: { type: 'noul', noul: 0.1 } }) })
    expect(outcome.failure).toBeUndefined()
    expect(outcome.reason).not.toContain('truncated')
    const inner = JSON.parse(body.state!).text as string
    expect(inner.length).toBeLessThanOrEqual(text.length)
    expect(inner.length).toBeLessThan(700) // ~1.5 tok/char ⇒ ≲640 chars inside the window
  })

  it('budget-exhausted (question too large for window): fail-open pass, failure error, no wire call', async () => {
    const fetchImpl = vi.fn()
    const outcome = await probeNoulOnce(
      { name: 'Bash' },
      { ...INFO, contextWindow: 40 },
      'text',
      { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(outcome).toEqual({ flag: false, reason: 'state budget exhausted', failure: 'error', latencyMs: outcome.latencyMs })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('threshold still flags on untruncated evidence', async () => {
    const body: { state?: string } = {}
    const outcome = await probeNoulOnce({ name: 'Bash' }, INFO, 'injection attempt', { timeoutMs: 1000, fetchImpl: makeFetch(body, { noul: { type: 'noul', noul: 0.7 } }) })
    expect(outcome.flag).toBe(true)
    expect(outcome.reason).toBe('noul=0.700 >= t=0.625')
  })
})
