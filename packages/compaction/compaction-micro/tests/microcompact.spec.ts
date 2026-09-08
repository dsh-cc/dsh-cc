import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/prune` shadow-price SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Microcompactor, {
  DEFAULTS,
  MICROCOMPACT_MARKER,
  isMicrocompactPlaceholder,
  resolveConfig,
  reuseSpillLocator,
} from '@dsh-cc/compaction-micro'
import type { MicrocompactConfig } from '@dsh-cc/compaction-micro'

const MODEL = 'test-model'

function service(config: MicrocompactConfig = { retainResults: 2 }): Microcompactor {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  void new TokenMeter(ctx)
  return new Microcompactor(ctx, config)
}

function session(): Session {
  return Session.create(SessionId('test'))
}

const TEXT = { type: 'text' as const }

function appendToolStep(
  s: Session,
  turn: number,
  call: string,
  text: string,
): number {
  const callId = ToolCallId(call)
  s.append('turn/start', { turn })
  s.append('step/start', { turn, step: 1 })
  s.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
    }),
  }, { surfaceOp: 'append' })
  s.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = s.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append' })
  s.append('step/end', { turn, step: 1 })
  s.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

/** All current-surface tool/result node seqs in surface order. */
function surfaceToolResults(s: Session): number[] {
  const seqs: number[] = []
  for (const seq of [...s.surface.nodes]) {
    if (s.events[seq]?.type === 'tool/result') seqs.push(seq)
  }
  return seqs
}

function replacementText(s: Session, call: string): string | undefined {
  for (const seq of [...s.surface.nodes]) {
    const event = s.events[seq]
    if (event?.type !== 'tool/result') continue
    const msg = event.data.message as SessionEvent<'tool/result'>['data']['message']
    if (msg.source.callId !== ToolCallId(call)) continue
    const block = msg.content[0]
    return block?.type === 'tool-result' && block.content[0]?.type === 'text'
      ? block.content[0].text
      : undefined
  }
  return undefined
}

describe('microcompact configuration', () => {
  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { retainResults: 4, auto: true, placeholderChars: 100 }
    const resolved = resolveConfig(raw)
    raw.retainResults = 1
    expect(resolved).toEqual({ retainResults: 4, auto: true, placeholderChars: 100 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({ retainResults: 10, auto: false, placeholderChars: 256 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys and invalid scalars', () => {
    const bad = [
      [{ retainResults: 0 }, /retainResults .* positive integer/],
      [{ retainResults: -1 }, /retainResults .* positive integer/],
      [{ retainResults: 1.5 }, /retainResults .* positive integer/],
      [{ placeholderChars: 0 }, /placeholderChars .* positive integer/],
      [{ window: 5 }, /unknown key "window"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as MicrocompactConfig)).toThrow(pattern)
    }
  })
})

describe('spill locator extraction', () => {
  it('extracts a rendered locator sentence', () => {
    expect(reuseSpillLocator('plain output')).toBeUndefined()
    expect(reuseSpillLocator('Full grep result stored at: /tmp/x/abc123. Read it with read.')).toBe(
      'Full result still available at: /tmp/x/abc123.',
    )
  })
})

describe('Microcompactor window + freeze', () => {
  it('keeps the most recent N tool results verbatim and collapses older ones', () => {
    const micro = service({ retainResults: 2 })
    const s = session()
    for (let i = 1; i <= 5; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)

    const before = surfaceToolResults(s)
    expect(before).toHaveLength(5)
    const result = micro.microcompactSession(s)

    // retrain 2 → collapse the oldest 3.
    expect(result.replaced).toHaveLength(3)
    expect(result.stable).toBe(false)
    expect(result.replaced.map(e => e.callId)).toEqual(
      [1, 2, 3].map(i => ToolCallId(`call-${i}`)),
    )
    // Newest two are untouched verbatim.
    expect(replacementText(s, 'call-4')).toBe('result 4')
    expect(replacementText(s, 'call-5')).toBe('result 5')
    // Oldest three became placeholders.
    for (const i of [1, 2, 3]) {
      expect(replacementText(s, `call-${i}`)!.startsWith(MICROCOMPACT_MARKER)).toBe(true)
    }
    // Placeholder content begins with the marker (freeze detection).
    const ph = replacementText(s, 'call-1')!
    expect(isMicrocompactPlaceholder([{ type: 'text', text: ph }])).toBe(true)
  })

  it('is idempotent: a second pass emits no replacement and a byte-identical prompt', () => {
    const micro = service({ retainResults: 2 })
    const s = session()
    for (let i = 1; i <= 4; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)

    micro.microcompactSession(s)
    const surfaceAfterFirst = s.surface.nodes.slice()
    const firstEnd = surfaceToolResults(s)

    const second = micro.microcompactSession(s)
    expect(second.replaced).toHaveLength(0)
    expect(second.stable).toBe(true)
    // Surface (and thus the projected prompt) is unchanged on re-run.
    expect(s.surface.nodes.slice()).toEqual(surfaceAfterFirst)
    expect(surfaceToolResults(s)).toEqual(firstEnd)
  })

  it('recognizes an already-collapsed result and never re-decides it', () => {
    const micro = service({ retainResults: 1 })
    const s = session()
    appendToolStep(s, 1, 'a', 'big result')
    appendToolStep(s, 2, 'b', 'kept')
    micro.microcompactSession(s)
    // With retainResults 1, the remaining 'b' is within the window; the
    // placeholder 'a' is skipped via marker detection, so nothing collapses.
    const second = micro.microcompactSession(s)
    expect(second.replaced).toHaveLength(0)
  })

  it('returns the replacement decisions in the pass result (origin seqs, call ids)', () => {
    const micro = service({ retainResults: 2 })
    const s = session()
    for (let i = 1; i <= 4; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)
    const originalSeqs = surfaceToolResults(s)

    const result = micro.microcompactSession(s)

    // The oldest two (seqs originalSeqs[0..1]) were collapsed.
    expect(result.replaced).toHaveLength(2)
    expect(result.replaced.map(r => r.originalSeq)).toEqual([originalSeqs[0], originalSeqs[1]])
    expect(result.replaced.map(r => r.callId)).toEqual([ToolCallId('call-1'), ToolCallId('call-2')])
    // Each decision's replacementSeq is a current-surface node whose content is the placeholder,
    // and which cites the shadowed original — the decision reconstructs from log + code.
    for (const record of result.replaced) {
      const replacement = s.events[record.replacementSeq] as SessionEvent<'tool/result'> | undefined
      expect(replacement?.type).toBe('tool/result')
      const block = replacement!.data.message.content[0]
      expect(block?.type === 'tool-result' && block.content[0]?.type === 'text'
        && block.content[0].text.startsWith(MICROCOMPACT_MARKER)).toBe(true)
      expect(replacement!.sourceEventSeqs).toContain(record.originalSeq)
    }
  })

  it('re-embeds a cited spill locator into the placeholder', () => {
    const micro = service({ retainResults: 1 })
    const s = session()
    appendToolStep(s, 1, 'a', 'Full grep result stored at: /tmp/spill/xyz. Read with read.')
    appendToolStep(s, 2, 'b', 'kept')
    const result = micro.microcompactSession(s)
    const ph = replacementText(s, 'a')!
    expect(ph).toContain('Full result still available at: /tmp/spill/xyz.')
    // The locator rides the returned decision record.
    expect(result.replaced[0]?.spillLocator).toBe('Full result still available at: /tmp/spill/xyz.')
  })

  it('keeps every result when all are within the retention window (stable pass)', () => {
    const micro = service({ retainResults: 10 })
    const s = session()
    for (let i = 1; i <= 3; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)
    const result = micro.microcompactSession(s)
    expect(result.replaced).toHaveLength(0)
    expect(result.stable).toBe(true)
  })
})

describe('Microcompactor single-pass batch folding', () => {
  it('collapses every over-window node in one pass, each shadow-priced by an adjacent compaction/prune', () => {
    const micro = service({ retainResults: 2 })
    const s = session()
    for (let i = 1; i <= 5; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)
    const originalSeqs = surfaceToolResults(s)

    const result = micro.microcompactSession(s)

    // One pass collapses ALL over-window nodes (the oldest 3), not one per pass.
    expect(result.replaced).toHaveLength(3)
    expect(result.replaced.map(r => r.originalSeq)).toEqual(originalSeqs.slice(0, 3))
    for (const record of result.replaced) {
      // Shadow-price protocol: the metering event is appended synchronously
      // adjacent, immediately before its surface replacement.
      const prune = s.events[record.replacementSeq - 1] as SessionEvent<'compaction/prune'> | undefined
      expect(prune?.type).toBe('compaction/prune')
      expect(prune!.data.shadowedSeqs).toEqual([record.originalSeq])
      expect(prune!.data.shadowedRange).toEqual({ start: record.originalSeq, end: record.originalSeq })
      expect(prune!.data.shadowedTokenCount).toBeGreaterThan(0)
      // The priced replacement shadows exactly the metered node.
      const replacement = s.events[record.replacementSeq] as SessionEvent<'tool/result'> | undefined
      expect(replacement?.type).toBe('tool/result')
      expect(replacement!.sourceEventSeqs).toEqual([record.originalSeq])
    }
  })

  it('is a byte-level no-op when invoked immediately after a batch pass', () => {
    const micro = service({ retainResults: 2 })
    const s = session()
    for (let i = 1; i <= 5; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)

    const first = micro.microcompactSession(s)
    expect(first.replaced).toHaveLength(3)
    const logBytesBefore = JSON.stringify(s.events)
    const surfaceBytesBefore = JSON.stringify(
      [...s.surface.nodes].map(seq => s.events[seq]),
    )

    const second = micro.microcompactSession(s)

    expect(second.replaced).toHaveLength(0)
    expect(second.stable).toBe(true)
    // Nothing appended and nothing rewritten: the event log and the projected
    // surface are byte-identical after the no-op second pass.
    expect(JSON.stringify(s.events)).toBe(logBytesBefore)
    expect(JSON.stringify([...s.surface.nodes].map(seq => s.events[seq]))).toBe(surfaceBytesBefore)
  })

  it('folds exactly one node when the window overflows by exactly one (steady state)', () => {
    const micro = service({ retainResults: 5 })
    const s = session()
    for (let i = 1; i <= 6; i++) appendToolStep(s, i, `call-${i}`, `result ${i}`)

    const first = micro.microcompactSession(s)
    expect(first.replaced).toHaveLength(1)
    expect(first.replaced[0]?.callId).toEqual(ToolCallId('call-1'))
    expect(first.stable).toBe(false)

    // Steady state: with the overflow landed, a re-pass folds nothing.
    const second = micro.microcompactSession(s)
    expect(second.replaced).toHaveLength(0)
    expect(second.stable).toBe(true)

    // Overflow by one again: the steady state still folds exactly the one new
    // over-window node (the already-collapsed placeholder is never re-decided).
    appendToolStep(s, 7, 'call-7', 'result 7')
    const third = micro.microcompactSession(s)
    expect(third.replaced).toHaveLength(1)
    expect(third.replaced[0]?.callId).toEqual(ToolCallId('call-2'))
    expect(replacementText(s, 'call-7')).toBe('result 7')
  })
})

describe('Microcompactor content guard', () => {
  it('treats non-tool-result tool/result messages safely and skips non-text placeholders', () => {
    expect(isMicrocompactPlaceholder([{ type: 'text', text: 'x' }])).toBe(false)
    expect(isMicrocompactPlaceholder([TEXT])).toBe(false)
    expect(isMicrocompactPlaceholder([
      { type: 'text', text: `${MICROCOMPACT_MARKER} extra` },
    ])).toBe(true)
  })

  it('invariant companion loads as a plugin and reserves its package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const MicroInvariant = await import('@dsh-cc/compaction-micro/invariant')
    await ctx.plugin(MicroInvariant)
    // The plugin install reserves the package name against duplicate registration.
    expect(() => {
      ctx.invariants.register('@dsh-cc/compaction-micro', () => {})
    }).toThrow(/already registered/)
  })
})
