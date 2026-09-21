import { describe, expect, it } from 'vitest'
import type { SessionLogEvent } from '@dsh-cc/cache-trajectory'
import { RedactorDeviationError, renderCanonicalJsonl, sanitizeSessionEvents } from '../src/redactor'

const CCR_MARKER = '[dsh-cc compressed 41230→6180 tokens. Original: ccr://a1b2c3d4e5f60708]'

function toolResult(text: string): SessionLogEvent {
  return {
    type: 'tool/result',
    time: 100,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text }],
      },
    },
  }
}

describe('sanitizeSessionEvents', () => {
  it('strips assistant message bodies incl. multibyte content, keeps usage/turn/step', () => {
    const events: SessionLogEvent[] = [
      {
        type: 'assistant/message',
        time: 10,
        data: {
          turn: 1,
          step: 2,
          message: { role: 'assistant', content: [{ type: 'text', text: '秘密内容 ✨ secrets' }] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 1 },
        },
      },
    ]
    const out = sanitizeSessionEvents(events)
    const json = JSON.stringify(out)
    expect(json).not.toContain('秘密内容')
    expect(json).not.toContain('secrets')
    expect(json).not.toContain('"message"')
    const data = out[0]?.data as Record<string, unknown>
    expect(data['usage']).toEqual(events[0]!.data!.usage)
    expect(data['turn']).toBe(1)
    expect(data['step']).toBe(2)
    expect(out[0]!.time).toBe(10)
  })

  it('preserves CCR marker lines inside tool/result text and redacts the rest', () => {
    const body = `before line\n${CCR_MARKER}\nafter line`
    const out = sanitizeSessionEvents([toolResult(body)])
    const msg = (out[0]!.data as Record<string, unknown>)['message'] as { content: Array<{ text: string }> }
    const text = msg.content[0]!.text
    expect(text).toContain(CCR_MARKER)
    expect(text).toContain('[body redacted ')
    expect(text).not.toContain('before line')
    expect(text).not.toContain('after line')
    // body-redaction length placeholder counts non-marker chars
    expect(text).toMatch(/^\[body redacted 21 chars\]\n\[dsh-cc compressed/)
  })

  it('throws on a usage-bearing event whose type is not in the keep-set', () => {
    const events: SessionLogEvent[] = [
      { type: 'llm/stream', data: { usage: { inputTokens: 1, outputTokens: 2 } } },
    ]
    expect(() => sanitizeSessionEvents(events)).toThrow(RedactorDeviationError)
    expect(() => sanitizeSessionEvents(events)).toThrow(/llm\/stream.*#0/)
  })

  it('throws when a usage-bearing event lacks a well-formed usage object', () => {
    const bad: SessionLogEvent[] = [
      { type: 'assistant/message', time: 1, data: { usage: { inputTokens: 'x', outputTokens: 2 } } },
    ]
    expect(() => sanitizeSessionEvents(bad)).toThrow(RedactorDeviationError)
    // orchestrator ruling (overrides Slice A): usage-absent assistant messages
    // are legal interrupted turns — kept, no throw; only malformed usage throws.
    expect(() => sanitizeSessionEvents(missing)).not.toThrow(RedactorDeviationError)
  })

  it('is byte-stable across a double sanitize+render run with sorted keys', () => {
    const events: SessionLogEvent[] = [
      { type: 'assistant/message', time: 20, data: { step: 1, turn: 2, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, totalTokens: 7 } } },
      { type: 'request/context', data: { model: 'm', provider: 'p', route: 'x' } },
    ]
    const once = renderCanonicalJsonl(sanitizeSessionEvents(events))
    const roundTripped = once.split('\n').filter(Boolean).map(l => JSON.parse(l) as SessionLogEvent)
    const twice = renderCanonicalJsonl(sanitizeSessionEvents(roundTripped))
    expect(once).toBe(twice)
    expect(once.endsWith('\n')).toBe(true)
    expect(once.split('\n')[0]).toBe('{"data":{"step":1,"turn":2,"usage":{"cacheReadTokens":5,"cacheWriteTokens":6,"inputTokens":3,"outputTokens":4,"totalTokens":7}},"time":20,"type":"assistant/message"}')
  })

  it('request/header keeps only header.config.provider and .model', () => {
    const events: SessionLogEvent[] = [
      {
        type: 'request/header',
        data: { header: { config: { provider: 'p', model: 'm', apiKey: 'sk-secret', temperature: 1 }, other: 1 } },
      },
    ]
    const out = sanitizeSessionEvents(events)
    expect(out[0]!.data).toEqual({ header: { config: { provider: 'p', model: 'm' } } })
    expect(JSON.stringify(out)).not.toContain('sk-secret')
  })

  it('request/context keeps only provider/model (what analyzeSessionCache reads)', () => {
    const out = sanitizeSessionEvents([{ type: 'request/context', data: { provider: 'p', model: 'm', sessionKey: 's' } }])
    expect(out[0]!.data).toEqual({ provider: 'p', model: 'm' })
  })

  it('keeps a usage-less assistant/message (interrupted turn) without usage', () => {
    const out = sanitizeSessionEvents([
      {
        type: 'assistant/message',
        time: 7,
        data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
      },
    ])
    expect(out[0]!.data).toEqual({ turn: 2, step: 1, message: { content: [{ type: 'text', text: '[body redacted 7 chars]' }] } })
    expect(Object.keys(out[0]!.data as object)).not.toContain('usage')
  })

  it('still throws on a usage-bearing event of an unexpected type, and on malformed usage', () => {
    expect(() => sanitizeSessionEvents([
      { type: 'session/usage', data: { usage: { inputTokens: 1, outputTokens: 2 } } },
    ])).toThrow(RedactorDeviationError)
    expect(() => sanitizeSessionEvents([
      { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 'x' } } },
    ])).toThrow(RedactorDeviationError)
  })

  it('drops non-usage-bearing tool/result extras and unknown types are metadata-stripped', () => {
    const out = sanitizeSessionEvents([
      { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] }, meta: { x: 1 } } },
      { type: 'weird/thing', time: 5, data: { secret: true } },
    ])
    expect(Object.keys((out[0]!.data as Record<string, unknown>)['message'] as object)).toEqual(['content'])
    expect(out[1]).toEqual({ type: 'weird/thing', time: 5, data: {} })
  })
})

// Regression (dogfood-driven): CCR markers live one nesting level down in real
// tool/result content — [...{ type: 'tool-result', content: [{type:'text',text}] }].
it('preserves CCR markers nested inside tool-result block content', () => {
  const events = [{
    type: 'tool/result',
    time: 1,
    data: {
      turn: 1, step: 2, source: { kind: 'tool', callId: 'c1' },
      message: {
        role: 'tool', id: 'm1',
        content: [{
          type: 'tool-result', toolCallId: 'c1', isError: false,
          content: [{ type: 'text', text: 'grep line one\n[dsh-cc compressed 900→40 tokens. Original: ccr://0123456789abcdef]\ngrep line two' }],
        }],
      },
    },
  }]
  const out = sanitizeSessionEvents(events)
  const msg: any = (out[0]!.data as any).message
  const text = msg.content[0].content[0].text as string
  expect(text).toContain('[dsh-cc compressed 900→40 tokens. Original: ccr://0123456789abcdef]')
  expect(text).toContain('[body redacted')
  expect(text).not.toContain('grep line one')
  expect(msg.content[0].type).toBe('tool-result')
  expect(msg.role).toBeUndefined() // extraneous message metadata stripped
})
