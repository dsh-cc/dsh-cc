import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldCounters, type FoldCounterMaterials } from '../src/fold-counters.ts'

function markerLine(before: number, after: number, hash: string): string {
  return `[dsh-cc compressed ${before}→${after} tokens. Original: ccr://${hash}]`
}

/** Mock-tier: programmatically built typed tool/result event (real dsh-llm block shape). */
function typedResult(text: string): FoldCounterMaterials['events'][number] {
  return {
    type: 'tool/result',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text }] }],
      },
    },
  }
}

/** Replay-tier: a serialized JSONL log row parsed back (proves round-trip survival). */
function replayResult(text: string): FoldCounterMaterials['events'][number] {
  const row = JSON.stringify({
    type: 'tool/result',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text }] }],
      },
    },
  })
  return JSON.parse(row) as FoldCounterMaterials['events'][number]
}

describe('foldCounters (ccr evidence)', () => {
  it('fires: two markers → exact counts and sums', () => {
    const out = foldCounters({
      events: [
        typedResult(`rows...\n${markerLine(41230, 6180, 'a1b2c3d4e5f60708')}`),
        replayResult(`x\n${markerLine(100, 20, '0123456789abcdef')}`),
      ],
      dshHome: '',
    })
    expect(out).toEqual({ 'ccr.applied': 2, 'ccr.tokensBefore': 41330, 'ccr.tokensAfter': 6200 })
  })

  it('control: plain results → all zeros', () => {
    const out = foldCounters({ events: [typedResult('plain output, no marker')], dshHome: '' })
    expect(out).toEqual({ 'ccr.applied': 0, 'ccr.tokensBefore': 0, 'ccr.tokensAfter': 0 })
  })

  it('empty events → all zeros', () => {
    expect(foldCounters({ events: [], dshHome: '' })).toEqual({ 'ccr.applied': 0, 'ccr.tokensBefore': 0, 'ccr.tokensAfter': 0 })
  })

  it('ignores non-tool/result events', () => {
    const out = foldCounters({
      events: [
        { type: 'user/message', data: { content: [{ type: 'text', text: markerLine(1, 1, 'a'.repeat(16)) }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: markerLine(2, 1, 'b'.repeat(16)) }] } } },
      ],
      dshHome: '',
    })
    expect(out['ccr.applied']).toBe(0)
  })

  it('malformed marker-like text is NOT counted (parseMarker null)', () => {
    const out = foldCounters({
      events: [
        typedResult(`[dsh-cc compressed 41230→6180 tokens. Original: ccr://SHORT]`),
        typedResult(`[dsh-cc compressed 1,000→5 tokens. Original: ccr://a1b2c3d4e5f60708]`),
      ],
      dshHome: '',
    })
    expect(out).toEqual({ 'ccr.applied': 0, 'ccr.tokensBefore': 0, 'ccr.tokensAfter': 0 })
  })

  it('handles plain string content (non-block shape)', () => {
    const out = foldCounters({
      events: [{ type: 'tool/result', data: { message: { content: `x\n${markerLine(10, 2, 'c'.repeat(16))}` } } } as never],
      dshHome: '',
    })
    expect(out).toEqual({ 'ccr.applied': 1, 'ccr.tokensBefore': 10, 'ccr.tokensAfter': 2 })
  })

  it('dshHome unused for this fold but accepted', () => {
    expect(foldCounters({ events: [], dshHome: mkdtempSync(join(tmpdir(), 'ccr-fold-')) })).toEqual({
      'ccr.applied': 0,
      'ccr.tokensBefore': 0,
      'ccr.tokensAfter': 0,
    })
  })
})
