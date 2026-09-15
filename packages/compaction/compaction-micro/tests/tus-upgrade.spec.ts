import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { tusFramedSummary, isCrusherStub } from '@dsh-cc/tool-use-summary'
import type { SummaryRow } from '@dsh-cc/tool-use-summary'
import Microcompactor from '@dsh-cc/compaction-micro'

// Test 7 (§5.7): micro integration with TUS summaries — placeholder upgraded
// with the framed digest; absence → legacy placeholder; crusher stub → skip.

const CRUSHER_MARKER = '[dsh-cc compressed 41230→6180 tokens. Original: ccr://a1b2c3d4e5f60708]'

function row(callId: string, over: Partial<SummaryRow> = {}): SummaryRow {
  return {
    callId,
    tool: 'read',
    resultBytes: 31240,
    status: 'ok',
    summary: 'Read src/main.ts: exported run(), 312 lines.',
    durationMs: 12,
    at: '2026-09-15T00:00:00.000Z',
    ...over,
  }
}

function micro(ctx: Context): Microcompactor {
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new Microcompactor(ctx, { retainResults: 1 })
}

function sessionWithResults(calls: Array<[string, string]>): Session {
  const s = Session.create(SessionId('tus-micro'))
  let turn = 0
  for (const [call, text] of calls) {
    turn += 1
    const callId = ToolCallId(call)
    s.append('turn/start', { turn })
    s.append('step/start', { turn, step: 1 })
    s.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', ...{ provider: 'm', model: 'm' } },
      }),
    }, { surfaceOp: 'append' })
    s.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
    s.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn, step: 1 })
    s.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return s
}

describe('micro × TUS placeholder upgrade (Consumer A)', () => {
  it('upgrades a stale placeholder with the framed digest when a TUS row exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-micro-'))
    const dir = join(home, 'tool-use-summary')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tus-micro.jsonl'),
      `${JSON.stringify(row('call-1'))}\n`, 'utf8')
    const ctx = new Context()
    ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
      (...segments: string[]) => join(home, ...segments)
    const m = micro(ctx)
    const s = sessionWithResults([
      ['call-1', 'x'.repeat(5000)],
      ['call-2', 'fresh'],
    ])
    const tus = new Map([[ToolCallId('call-1'), row('call-1')]])
    const result = m.microcompactSession(s, tus)
    expect(result.replaced).toHaveLength(1)
    const text = s.eventAt(result.replaced[0]!.replacementSeq)
    const body = (text?.data as { message: { content: [{ content: [{ text?: string }] }] } }).message.content[0]
      .content[0]?.text ?? ''
    expect(body).toBe(tusFramedSummary(row('call-1')))
    expect(body).toContain('<tool-result-summary untrusted="true" tool="read" bytes="31240">')
  })

  it('absent TUS row → bit-identical legacy placeholder', async () => {
    const ctx = new Context()
    const m = micro(ctx)
    const text = 'x'.repeat(300)
    const s1 = sessionWithResults([['call-1', text], ['call-2', 'fresh']])
    const s2 = sessionWithResults([['call-1', text], ['call-2', 'fresh']])
    const withTus = m.microcompactSession(s2, new Map())
    const without = m.microcompactSession(s1)
    expect(withTus.replaced).toHaveLength(without.replaced.length)
    const a = without.replaced[0]!.replacementSeq
    const b = withTus.replaced[0]!.replacementSeq
    const ta = (s1.eventAt(a)?.data as { message: { content: [{ content: [{ text?: string }] }] } }).message.content[0].content[0]?.text
    const tb = (s2.eventAt(b)?.data as { message: { content: [{ content: [{ text?: string }] }] } }).message.content[0].content[0]?.text
    expect(tb).toBe(ta)
  })

  it('crushed-stub node → skipped (pinned crusher marker)', async () => {
    const ctx = new Context()
    const m = micro(ctx)
    const s = sessionWithResults([
      ['call-1', `old output\n${CRUSHER_MARKER}`],
      ['call-2', 'fresh'],
    ])
    const tus = new Map([[ToolCallId('call-1'), row('call-1')]])
    expect(isCrusherStub(`old output\n${CRUSHER_MARKER}`)).toBe(true)
    const result = m.microcompactSession(s, tus)
    // The crusher stub is NOT substituted; it was the only over-window node.
    expect(result.replaced).toHaveLength(0)
  })
})
