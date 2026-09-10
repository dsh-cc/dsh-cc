import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLedgerRow, observeChunk, type FoldRecord } from '../src/ledger.ts'
import { foldStream } from '../src/index.ts'

function record(): FoldRecord {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    sessionId: 's1',
    purpose: null,
    reasoningBytes: 0,
    textBytes: 0,
  }
}

describe('observeChunk byte counting', () => {
  it('counts multi-chunk reasoning deltas in UTF-8 bytes, incl. multibyte', () => {
    const r = record()
    observeChunk(r, { type: 'reasoning-delta', index: 0, text: '中' }) // 3 bytes
    observeChunk(r, { type: 'reasoning-delta', index: 0, text: '文' }) // 3 bytes
    observeChunk(r, { type: 'reasoning-delta', index: 0, text: '😀' }) // 4 bytes
    observeChunk(r, { type: 'reasoning-delta', index: 0, text: 'abc' }) // 3 bytes
    expect(r.reasoningBytes).toBe(13)
    expect(r.textBytes).toBe(0)
  })

  it('counts text deltas separately', () => {
    const r = record()
    observeChunk(r, { type: 'text-delta', index: 0, text: 'hello' })
    observeChunk(r, { type: 'reasoning-delta', index: 1, text: '思考' })
    expect(r.textBytes).toBe(5)
    expect(r.reasoningBytes).toBe(6)
  })

  it('ignores block-start/block-end/tool-call-delta/finish', () => {
    const r = record()
    observeChunk(r, { type: 'block-start', index: 0, blockType: 'text' })
    observeChunk(r, {
      type: 'tool-call-delta', index: 0, id: 't1' as never, name: 'bash', argumentsDelta: '{"cmd"',
    })
    observeChunk(r, { type: 'finish', reason: { kind: 'stop' } })
    expect(r.reasoningBytes).toBe(0)
    expect(r.textBytes).toBe(0)
    expect(r.usage).toBeUndefined()
  })
})

describe('usage join', () => {
  it('captures a full usage-copy when usage arrives after the blocks', () => {
    const r = record()
    observeChunk(r, { type: 'block-start', index: 0, blockType: 'text' })
    observeChunk(r, { type: 'text-delta', index: 0, text: 'hi' })
    const usage = {
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
      cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 2,
    }
    observeChunk(r, { type: 'usage', usage })
    observeChunk(r, { type: 'finish', reason: { kind: 'stop' } })
    expect(r.usage).toEqual(usage)
    // Spread copy: mutating/detaching the chunk afterwards must not leak.
    expect(r.usage).not.toBe(usage)
  })
})

describe('ledger row', () => {
  it('omits usage when the call never carried a usage chunk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-'))
    const file = join(dir, 's1.jsonl')
    await appendLedgerRow(file, record())
    const row = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>
    expect(row.purpose).toBeNull()
    expect(row.reasoningBytes).toBe(0)
    expect(row.textBytes).toBe(0)
    expect(row).not.toHaveProperty('usage')
    expect(typeof row.ts).toBe('string')
    expect(new Date(row.ts as string).toISOString()).toBe(row.ts)
  })

  it('includes usage when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fold-'))
    const file = join(dir, 's2.jsonl')
    const r = record()
    r.usage = { inputTokens: 1, outputTokens: 2 }
    await appendLedgerRow(file, r)
    const row = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>
    expect(row.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })
})

describe('foldStream abort path', () => {
  it('still appends the ledger row when the upstream throws mid-iteration', async () => {
    const appended: FoldRecord[] = []
    const r = record()
    async function* upstream(): AsyncIterable<{ type: 'reasoning-delta'; index: number; text: string }> {
      yield { type: 'reasoning-delta', index: 0, text: '部分' }
      throw new Error('aborted mid-stream')
    }
    const out = foldStream(r, true, observeChunk, async (x) => appended.push(x), upstream as never)
    await expect(async () => {
      for await (const _ of out) { /* consume */ }
    }).rejects.toThrow('aborted mid-stream')
    expect(appended).toHaveLength(1)
    expect(appended[0]!.reasoningBytes).toBe(6)
  })

  it('passes chunks through untouched while observing', async () => {
    const r = record()
    const chunks = [
      { type: 'reasoning-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 1, text: 'b' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] as never[]
    async function* upstream(): AsyncIterable<never> {
      yield * chunks
    }
    const seen: unknown[] = []
    for await (const c of foldStream(r, true, observeChunk, async () => {}, upstream)) {
      seen.push(c)
    }
    expect(seen).toEqual(chunks)
    expect(r.reasoningBytes).toBe(1)
    expect(r.textBytes).toBe(1)
  })
})
