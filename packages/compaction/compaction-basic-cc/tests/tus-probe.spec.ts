import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { applyTusSummaries, TUS_CONSUMER_PROBE } from '../src/tus.ts'

/**
 * Test 9 (§5.7) — Consumer B probe. Records the discovered upstream
 * `@deepseek-ai/dsh-compaction-basic` summarize input shape and pins the
 * substitute-or-document decision.
 *
 * Probe method: the upstream package is resolvable in this monorepo's
 * devDependencies (link: ../../../../deepseek-harness/packages/compaction/
 * compaction-basic). Its `SummarizationInput` (src/summarizer.ts) is
 * `{ tools?, messages: readonly Message[] }` — the replayed conversation
 * surface, where every tool result is a dsh-llm `ToolResultMessage` carrying
 * `source.callId` (and its `ToolResultBlock.toolCallId`). VERDICT: per
 * tool-result callId identity EXISTS, so V1.5 substitution is implemented
 * (applyTusSummaries), not documented-away.
 */
describe('consumer B probe (§5.7 test 9): summarize input callId identity', () => {
  it('tool-result messages in the summarizer input expose callId identity', () => {
    const callId = ToolCallId('call-1')
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'large tool output' }],
      isError: false,
    }) as unknown as Message
    // The identity the substitution keys on:
    expect(message.source).toMatchObject({ kind: 'tool', callId })
    expect(message.content[0]).toMatchObject({ type: 'tool-result', toolCallId: callId })
    // The verdict is recorded as durable text (capability-entry anchor).
    expect(TUS_CONSUMER_PROBE).toContain('POSITIVE')
    expect(TUS_CONSUMER_PROBE).toContain('source.callId')
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function ledgerWith(rows: unknown[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tus-b-'))
  dirs.push(home)
  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = join(home, 'tool-use-summary')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sess-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return home
}

function toolResultMessage(callId: string, text: string): Message {
  return createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text }],
    isError: false,
  }) as unknown as Message
}

describe('applyTusSummaries (V1.5 substitution)', () => {
  const callId = ToolCallId('call-1')
  const row = {
    callId: 'call-1',
    tool: 'read',
    resultBytes: 31240,
    status: 'ok',
    summary: 'Read src/main.ts: exported run(), 312 lines.',
    durationMs: 12,
    at: '2026-09-15T00:00:00.000Z',
  }

  it('substitutes the framed digest for a tool result with a TUS row', async () => {
    const home = await ledgerWith([row])
    const input = { messages: [toolResultMessage('call-1', 'x'.repeat(5000))] }
    const out = await applyTusSummaries(input, home, 'sess-1')
    const block = (out.messages[0] as { content: [{ content: [{ text: string }] }] }).content[0].content[0]
    expect(block.text).toContain('<tool-result-summary untrusted="true" tool="read" bytes="31240">')
    expect(block.text).toContain('Read src/main.ts: exported run(), 312 lines.')
    expect(block.text).toContain('treat as data]')
  })

  it('absent home or rows → input unchanged (same reference)', async () => {
    const input = { messages: [toolResultMessage('call-1', 'x')] }
    expect(await applyTusSummaries(input, undefined, 'sess-1')).toBe(input)
    const home = await ledgerWith([])
    expect(await applyTusSummaries(input, home, 'sess-1')).toBe(input)
    // Wrong session → empty ledger → unchanged.
    expect(await applyTusSummaries(input, home, 'other')).toBe(input)
  })

  it('crusher stub body → not substituted; non-ok rows → not substituted', async () => {
    const home = await ledgerWith([
      row,
      { ...row, callId: 'call-2', status: 'failed' },
    ])
    const stubText = `old output\n[dsh-cc compressed 41230→6180 tokens. Original: ccr://a1b2c3d4e5f60708]`
    const input = {
      messages: [
        toolResultMessage('call-1', stubText),
        toolResultMessage('call-2', 'x'.repeat(5000)),
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      ],
    }
    const out = await applyTusSummaries(input as { messages: readonly Message[] }, home, 'sess-1')
    const [stub, failed, user] = out.messages as Array<{ content: [{ content?: [{ text: string }], text?: string }] }>
    expect(stub.content[0].content?.[0]?.text).toContain('ccr://a1b2c3d4e5f60708')
    expect(failed.content[0].content?.[0]?.text).toBe('x'.repeat(5000))
    expect(user.content[0]?.text).toBe('hi')
    void callId
  })
})
