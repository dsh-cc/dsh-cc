import { describe, expect, it } from 'vitest'
import { normalizeToolResult } from '../src/tool-result-payload.ts'
import readPair from './fixtures/tool-result-read-pair.json' with { type: 'json' }
import errorPair from './fixtures/tool-result-error-pair.json' with { type: 'json' }
import errorInfoPair from './fixtures/tool-result-error-info-pair.json' with { type: 'json' }

describe('normalizeToolResult', () => {
  it('extracts the wrapped shape via message.source.callId', () => {
    const payload = normalizeToolResult(readPair[1].data)
    expect(payload.callId).toBe('chatcmpl-tool-957d46bdc1f3c1e7')
    expect(payload.isError).toBe(false)
    expect(payload.content?.[0]).toMatchObject({ type: 'text' })
    expect(payload.text.length).toBeGreaterThan(0)
    expect(payload.meta).toEqual((readPair[1].data as { meta?: unknown }).meta)
  })

  it('falls back to the tool-result block toolCallId when source is absent', () => {
    const data = {
      message: {
        content: [{ type: 'tool-result', toolCallId: 'call-42', content: [{ type: 'text', text: 'done' }] }],
      },
 meta: { offset: 3 },
    }
    const payload = normalizeToolResult(data)
    expect(payload.callId).toBe('call-42')
    expect(payload.text).toBe('done')
    expect(payload.isError).toBe(false)
    expect(payload.meta).toEqual({ offset: 3 })
  })

  it('joins text blocks with no separator', () => {
    const payload = normalizeToolResult({
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
      },
    })
    expect(payload.text).toBe('ab')
  })

  it('flags isError on the tool-reported error fixture', () => {
    const payload = normalizeToolResult(errorPair[1].data)
    expect(payload.callId).toBe('chatcmpl-tool-919b46170cda13a4')
    expect(payload.isError).toBe(true)
  })

  it('flags isError on the error-info fixture (isError + top-level data.error)', () => {
    const payload = normalizeToolResult(errorInfoPair[1].data)
    expect(payload.callId).toBe('chatcmpl-tool-9c902fe4dcbe66a2')
    expect(payload.isError).toBe(true)
  })

  it('keeps the legacy top-level shape', () => {
    const payload = normalizeToolResult({
      callId: 'abc', id: 'unused', name: 'bash', toolName: 'unused-tool',
      content: [{ type: 'text', text: 'ok' }], meta: { lang: 'sh' },
    })
    expect(payload.callId).toBe('abc')
    expect(payload.name).toBe('bash')
    expect(payload.text).toBe('ok')
    expect(payload.isError).toBe(false)
    expect(payload.meta).toEqual({ lang: 'sh' })
  })

  it('maps legacy error to isError via data.error', () => {
    const payload = normalizeToolResult({ callId: 'abc', content: 'boom', error: { message: 'x' } })
    expect(payload.callId).toBe('abc')
    expect(payload.isError).toBe(true)
    expect(payload.text).toBe('boom')
  })

  it('returns an unresolvable payload for content without a tool-result block', () => {
    const payload = normalizeToolResult({ message: { content: [{ type: 'text', text: 'hi' }] } })
    expect(payload.callId).toBe('')
  })

  it('never throws on null or garbage', () => {
    expect(() => normalizeToolResult(null)).not.toThrow()
    expect(() => normalizeToolResult(42)).not.toThrow()
    expect(() => normalizeToolResult('nope')).not.toThrow()
    for (const input of [null, 42, 'nope']) {
      const payload = normalizeToolResult(input)
      expect(payload.callId).toBe('')
    }
    expect(normalizeToolResult({ callId: 'x' }).text).toBe('')
  })
})
