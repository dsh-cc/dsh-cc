import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCcTranscriptMirror,
  translateEventsToCcTranscript,
} from '@dsh-cc/tui/harness/statusline-cc-transcript.ts'

/**
 * Slice C — CC-shape transcript mirror: translator purity cases and the
 * writer's readiness/append/GC/failure policy. Temp dirs live INSIDE the
 * worktree (os.tmpdir() writes are sandbox-denied here) and are cleaned in
 * afterEach.
 */

const usageEvent = (seq: number, time: number, tokens?: Partial<{
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}>) => ({
  type: 'assistant/message',
  seq,
  time,
  data: { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, ...tokens } },
})

const userEvent = (seq: number, time: number) => ({ type: 'user/message', seq, time })

let tmpRoot: string
let tempDir: string

beforeEach(() => {
  tmpRoot = join(dirname(fileURLToPath(import.meta.url)), '.tmp-cc-transcript-' + Math.random().toString(36).slice(2))
  mkdirSync(tmpRoot, { recursive: true })
  tempDir = join(tmpRoot, 'tui')
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('translateEventsToCcTranscript', () => {
  it('maps an assistant usage event onto the CC line with explicit cache zeros', () => {
    const [line] = translateEventsToCcTranscript(
      [{ type: 'assistant/message', seq: 1, time: 1_700_000_000_000, data: { usage: { inputTokens: 5, outputTokens: 7 } } }],
      's-1',
    )
    expect(JSON.parse(line!)).toEqual({
      type: 'assistant',
      timestamp: new Date(1_700_000_000_000).toISOString(),
      isSidechain: false,
      sessionId: 's-1',
      message: {
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })
  })

  it('carries cache read/write tokens when present', () => {
    const [line] = translateEventsToCcTranscript(
      [usageEvent(1, 1_700_000_000_000, { cacheReadTokens: 11, cacheWriteTokens: 22 })],
      's-1',
    )
    expect(JSON.parse(line!).message.usage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 22,
      cache_read_input_tokens: 11,
    })
  })

  it('emits user anchor lines and correct ISO timestamps', () => {
    const lines = translateEventsToCcTranscript([userEvent(1, 1_700_000_000_123), userEvent(2, 0)], 's-1')
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'user', timestamp: new Date(1_700_000_000_123).toISOString(), isSidechain: false, sessionId: 's-1',
    })
    expect(lines[1]).toContain('"timestamp":"1970-01-01T00:00:00.000Z"')
  })

  it('skips non-finite time, non-finite usage, and unrelated event types', () => {
    const lines = translateEventsToCcTranscript([
      { type: 'assistant/message', seq: 1, time: Number.NaN, data: { usage: { inputTokens: 1, outputTokens: 1 } } },
      { type: 'assistant/message', seq: 2, time: 1, data: { usage: { inputTokens: Number.NaN, outputTokens: 1 } } },
      { type: 'assistant/message', seq: 3, time: 1, data: {} },
      { type: 'other/event', seq: 4, time: 1 },
      null,
      'string',
      {},
    ], 's-1')
    expect(lines).toEqual([])
  })

  it('NEVER emits stop_reason anywhere in the output (ccstatusline accumulator trap)', () => {
    const lines = translateEventsToCcTranscript([
      usageEvent(1, 1_700_000_000_000),
      userEvent(2, 1_700_000_001_000),
      { type: 'assistant/message', seq: 3, time: 1, data: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop' } },
    ], 's-1')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.includes('stop_reason')).toBe(false)
  })
})

describe('createCcTranscriptMirror', () => {
  it('rebind with usage events creates the file, marks ready, and writes translated lines', () => {
    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.rebind('s-1', [userEvent(1, 1_700_000_000_000), usageEvent(2, 1_700_000_001_000)])
    expect(mirror.isReady()).toBe(true)
    expect(mirror.getPath()).toBe(join(tempDir, 'cc-transcripts', 's-1.jsonl'))
    const lines = readFileSync(mirror.getPath()!, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).message.usage.input_tokens).toBe(10)
  })

  it('rebind with no usage lines is not ready and writes no file (zeros-shadow trap)', () => {
    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.rebind('s-1', [userEvent(1, 1_700_000_000_000)])
    expect(mirror.isReady()).toBe(false)
    expect(mirror.getPath()).toBeUndefined()
    expect(existsSync(join(tempDir, 'cc-transcripts'))).toBe(false)
  })

  it('append adds lines for fresh seqs (user anchors included) and dedups by watermark', () => {
    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.rebind('s-1', [usageEvent(2, 1_700_000_001_000)])
    const before = readFileSync(mirror.getPath()!, 'utf8').split('\n').length

    mirror.append(userEvent(3, 1_700_000_002_000))
    mirror.append(usageEvent(3, 1_700_000_003_000)) // same seq — deduped
    mirror.append(usageEvent(2, 1_700_000_004_000)) // seq ≤ watermark — ignored
    mirror.append(userEvent(4, 1_700_000_005_000))

    const lines = readFileSync(mirror.getPath()!, 'utf8').trim().split('\n')
    expect(lines.length).toBe(before - 1 + 2)
    expect(JSON.parse(lines.at(-1)!).type).toBe('user')
    expect(JSON.parse(lines.at(-2)!).type).toBe('user')
  })

  it('append while not ready is a no-op', () => {
    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.append(usageEvent(1, 1_700_000_000_000))
    expect(mirror.isReady()).toBe(false)
  })

  it('an fs failure permanently disables the mirror (no recovery, even via rebind)', () => {
    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.rebind('s-1', [usageEvent(1, 1_700_000_000_000)])
    expect(mirror.isReady()).toBe(true)
    // Simulate an append fs failure: the whole cc-transcripts dir is gone
    // (removing only the file would not fail — flag-'a' appends recreate it).
    rmSync(join(tempDir, 'cc-transcripts'), { recursive: true, force: true })
    mirror.append(usageEvent(2, 1_700_000_001_000))
    expect(mirror.isReady()).toBe(false)
    expect(mirror.getPath()).toBeUndefined()
    // A later rebind on the SAME instance stays dead — later appends to a
    // corrupt stream are worse than silence, so no retries at all.
    mirror.rebind('s-1', [usageEvent(1, 1_700_000_000_000)])
    expect(mirror.isReady()).toBe(false)
  })

  it('GC sweep deletes synthetically old *.jsonl files and keeps fresh ones', () => {
    const ccDir = join(tempDir, 'cc-transcripts')
    mkdirSync(ccDir, { recursive: true })
    const oldPath = join(ccDir, 'old-session.jsonl')
    const freshPath = join(ccDir, 'fresh-session.jsonl')
    const otherPath = join(ccDir, 'keep-me.tmp')
    writeFileSync(oldPath, '{}\n')
    writeFileSync(freshPath, '{}\n')
    writeFileSync(otherPath, '{}\n')
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    utimesSync(oldPath, oldDate, oldDate)

    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.rebind('s-gc', [usageEvent(1, 1_700_000_000_000)])

    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(freshPath)).toBe(true)
    expect(existsSync(otherPath)).toBe(true)
    expect(readdirSync(ccDir)).toContain('s-gc.jsonl')
  })

  it('rebind to a different session id switches the path (last-writer-wins atomic rename)', () => {
    const mirror = createCcTranscriptMirror({ dir: tempDir })
    mirror.rebind('s-1', [usageEvent(1, 1_700_000_000_000)])
    const first = mirror.getPath()!
    mirror.rebind('s-2', [usageEvent(1, 1_700_000_000_000)])
    expect(mirror.getPath()).toBe(join(tempDir, 'cc-transcripts', 's-2.jsonl'))
    expect(existsSync(first)).toBe(true)
    // No tmp files left behind.
    for (const name of readdirSync(join(tempDir, 'cc-transcripts'))) {
      expect(name.endsWith('.tmp')).toBe(false)
    }
    expect(statSync(join(tempDir, 'cc-transcripts', 's-1.jsonl')).isFile()).toBe(true)
  })
})
