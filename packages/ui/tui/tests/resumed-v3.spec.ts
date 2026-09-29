/**
 * Resumed-v3-log read-side acceptance (migration plan §3.1 amendment): a
 * session recorded at the OLD v3 shape, put through the REAL harness
 * v3→v4 converter (via `session-persistence-jsonl`, which mounts the
 * `session-format-v3-to-v4` migration), must still render on the TUI read
 * sides:
 *  - migrated plugin sources (`plugin:<name>` / same-name kinds) reach the
 *    form-keyed notice router → a status row, never silently dropped;
 *  - the migrated `compact-checkpoint` source paints a compact boundary;
 *  - the v4-flat role:'tool' result resolves through `normalizeToolResult`.
 * Also records and shape-guards the committed v4 fixture: re-recording an
 * old-shape fixture fails loudly here.
 * @module @dsh-cc/tui/resumed-v3
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterAll, describe, expect, it } from 'vitest'
import { isCompactCheckpointSource } from '@dsh-cc/tui/compact-fold.ts'
import { createInitialState } from '@dsh-cc/tui/store.ts'
import { applySessionEvent } from '@dsh-cc/tui/transcript.ts'
import { normalizeToolResult } from '../src/tool-result-payload.ts'
import v4Fixture from './fixtures/v4-session-events.json' with { type: 'json' }

/** Verbatim v3 stream (recorded shape): notice, tool result, compact checkpoint. */
const V3_ID = 'resume3'
const V3_EVENTS: Array<Record<string, unknown>> = [
  { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 11, data: { turn: 1, step: 1 } },
  {
    type: 'agent/inbox/spliced', seq: 2, time: 12,
    data: {
      target: 'in-turn',
      inserted: [{
        id: 'notice-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-cc-notice', form: 'notice', summary: 'Compacted 3 history items' },
        content: [{ type: 'text', text: 'model-facing body' }],
      }],
    },
  },
  {
    type: 'user/message', seq: 3, time: 13, surfaceOp: 'append',
    data: {
      id: 'notice-1', role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-cc-notice', form: 'notice', summary: 'Compacted 3 history items' },
      content: [{ type: 'text', text: 'model-facing body' }],
    },
  },
  {
    type: 'assistant/message', seq: 4, time: 14, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: 'assistant-1', role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{}' },
        ],
      },
      stream: [{ type: 'chunk', time: 14, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{}' } } }],
    },
  },
  {
    type: 'tool/call', seq: 5, time: 15,
    data: { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{}' },
  },
  {
    type: 'tool/result', seq: 6, time: 16, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: 'tr-1', role: 'user',
        source: { kind: 'tool', callId: 'call-9' },
        content: [{ type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'tool ok' }] }],
      },
    },
  },
  { type: 'step/end', seq: 7, time: 17, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 8, time: 17, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 9, time: 18, data: { turn: 2 } },
  { type: 'step/start', seq: 10, time: 19, data: { turn: 2, step: 1 } },
  { type: 'compaction/start', seq: 11, time: 20, data: { compactionId: 'cca-1', turn: 2 } },
  { type: 'compaction/summary', seq: 12, time: 20, data: {
    compactionId: 'cca-1', summary: [{ type: 'text', text: '## Prior work\n- done' }],
    shadowedRange: { start: 3, end: 6 }, shadowedSeqs: [3, 4, 6], shadowedTokenCount: 120,
    provider: 'mock', model: 'mock',
  } },
  {
    type: 'user/message', seq: 13, time: 20,
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 6 },
    sourceEventSeqs: [3, 4, 6, 11, 12],
    data: {
      id: 'cp-1', role: 'user',
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'cca-1' },
      content: [
        { type: 'text', text: 'This is an automatically generated checkpoint...\n\n<compacted-summary>' },
        { type: 'text', text: '## Prior work\n- done' },
        { type: 'text', text: '</compacted-summary>' },
      ],
    },
  },
  { type: 'compaction/end', seq: 14, time: 21, data: { compactionId: 'cca-1', turn: 2 } },
  { type: 'step/end', seq: 15, time: 21, data: { turn: 2, step: 1 } },
  { type: 'turn/end', seq: 16, time: 21, data: { turn: 2, reason: { kind: 'completed' } } },
]
const V3_STREAM =
  `${JSON.stringify({ type: 'session', version: 3, id: V3_ID, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n` +
  V3_EVENTS.map(event => `${JSON.stringify(event)}\n`).join('')

const roots: string[] = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * Run the verbatim v3 stream through the real converter (persistence mounts
 * the `sessionFormatV3ToV4` migration) and return the migrated v4 events.
 */
async function convertV3(): Promise<{ events: Array<Record<string, unknown>>; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-resumed-v3-'))
  roots.push(root)
  // cwd undefined → project dir `_no-cwd`; simple ids pass `encodeSegment` through.
  const dir = join(root, '_no-cwd', V3_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v3.jsonl'), V3_STREAM)
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const reader = await ctx.sessionPersistence.open(SessionId(V3_ID), 'read')
  try {
    const read = await reader.read()
    expect(reader.header.version).toBe(4)
    return { events: read.events as Array<Record<string, unknown>>, root }
  } finally {
    await reader.close()
    await ctx.fiber.dispose()
  }
}

describe('resumed v3 log through the real v3→v4 converter', () => {
  it('converts the verbatim v3 stream to v4', async () => {
    const { events } = await convertV3()
    // Shape guards on the real conversion output.
    const sources = events.map(event =>
      (event.data as { source?: { kind?: string } } | undefined)?.source?.kind)
    // Converter spellings on migrated plugin sources (README:122-131).
    expect(sources).toContain('plugin:dsh-cc-notice')
    expect(sources).toContain('compact-checkpoint')
    const toolResult = events.find(event => event.type === 'tool/result')
    expect((toolResult!.data as { message: { role: string } }).message.role).toBe('tool')
  })

  it('renders a status row from a migrated notice spelling', async () => {
    const { events } = await convertV3()
    const notice = events.find(event =>
      (event.data as { source?: { kind?: string } })?.source?.kind === 'plugin:dsh-cc-notice')!
    const state = applySessionEvent(createInitialState(), notice as never)
    expect(state.rows.some(row => row.kind === 'status' && row.text === 'Compacted 3 history items')).toBe(true)
  })

  it('paints a compact boundary from the migrated checkpoint kind', async () => {
    const { events } = await convertV3()
    const checkpoint = events.find(event =>
      (event.data as { source?: { kind?: string } })?.source?.kind === 'compact-checkpoint')!
    expect(isCompactCheckpointSource((checkpoint.data as { source: unknown }).source)).toBe(true)
    const state = events.reduce(
      (acc, event) => applySessionEvent(acc, event as never),
      createInitialState(),
    )
    const compact = state.rows.find(row => row.kind === 'compact')
    expect(compact).toBeDefined()
    expect(compact!.summary).toBe('## Prior work\n- done')
    // The replaced span (notice + tool result) is dropped from the surface.
    expect(state.rows.some(row => row.kind === 'tool')).toBe(false)
  })

  it('resolves the migrated tool/result through normalizeToolResult', async () => {
    const { events } = await convertV3()
    const toolResult = events.find(event => event.type === 'tool/result')!
    const payload = normalizeToolResult(toolResult.data)
    expect(payload.callId).toBe('call-9')
    expect(payload.text).toBe('tool ok')
    expect(payload.isError).toBe(false)
  })

  it('keeps the committed v4 fixture verbatim and v4-shaped', () => {
    // Shape guards: fail loudly if the fixture is re-recorded in an old shape.
    // (Events only: the stream header is validated as version 4 in convertV3.)
    expect(v4Fixture.length).toBeGreaterThan(3)
    const kinds = v4Fixture.map(event =>
      (event.data as { source?: { kind?: string } } | undefined)?.source?.kind)
    expect(kinds).toContain('plugin:dsh-cc-notice')
    expect(kinds).toContain('compact-checkpoint')
    const toolResult = v4Fixture.find(event => event.type === 'tool/result')!
    expect((toolResult.data as { message: { role: string; toolCallId: string } }).message).toMatchObject({
      role: 'tool', toolCallId: 'call-9',
    })
    expect((toolResult.data as { message: { content: unknown[] } }).message.content)
      .toEqual([{ type: 'text', text: 'tool ok' }])
  })
})

// Record the verbatim fixture on first run (real conversion output, verbatim).
const fixtureUrl = new URL('./fixtures/v4-session-events.json', import.meta.url)
if (!existsSync(fixtureUrl) || readFileSync(fixtureUrl, 'utf8').trim().length < 10) {
  const { events } = await convertV3()
  writeFileSync(
    new URL('./fixtures/v4-session-events.json', import.meta.url),
    JSON.stringify(events, null, 2) + '\n',
  )
}
