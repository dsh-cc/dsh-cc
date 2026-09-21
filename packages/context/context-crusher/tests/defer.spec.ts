import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/prune` shadow-price SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import { DEFAULTS, overlaySettings, resolveConfig, CrusherStore, shortHash } from '../src/index.ts'
import { evaluateDeferGate } from '../src/defer/gate.ts'
import { shouldCountRequest, toolResultFingerprints, wrapStreamWithCounting } from '../src/defer/counter.ts'
import { foldDeferRows, parseTodoCounts, rebuildResidents } from '../src/defer/residents.ts'
import type { DeferLedgerRow, ResidentEntry } from '../src/defer/residents.ts'
import { attemptSwap, suffixTokensAfter } from '../src/defer/swap.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-defer-'))
  dirs.push(dir)
  return dir
}

/** Deterministic stand-in estimator for pure swap tests (chars ≈ tokens). */
function estimate(message: Message): number {
  return JSON.stringify(message.content).length
}

const MODEL = 'test-model'
const TEXT = { type: 'text' as const }

function appendToolStep(s: Session, turn: number, call: string, text: string): number {
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

function appendAssistantText(s: Session, turn: number, text: string): void {
  s.append('turn/start', { turn })
  s.append('step/start', { turn, step: 1 })
  s.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
    }),
  }, { surfaceOp: 'append' })
  s.append('step/end', { turn, step: 1 })
  s.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function resident(over: Partial<ResidentEntry> = {}): ResidentEntry {
  return {
    hash: 'a1b2c3d4e5f60708',
    callId: ToolCallId('call-1'),
    sentCount: 3,
    tokensSaved: 100,
    createdAt: Date.now(),
    ...over,
  }
}

function surfaceResultTexts(s: Session): string[] {
  const out: string[] = []
  for (const seq of [...s.surface.nodes]) {
    const event = s.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    if (block?.type === 'tool-result') {
      out.push(block.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'))
    }
  }
  return out
}

describe('defer configuration', () => {
  it('resolves the pinned defaults: residency 0 (off), margin 1.5, max-age 30min, urgency unset', () => {
    const cfg = resolveConfig({})
    expect(cfg.deferRequests).toBe(0)
    expect(cfg.deferMargin).toBe(1.5)
    expect(cfg.deferMaxAgeMs).toBe(1_800_000)
    expect(cfg.deferUrgencyTokens).toBeUndefined()
    expect(DEFAULTS.deferRequests).toBe(0)
    expect(DEFAULTS.deferMargin).toBe(1.5)
    expect(DEFAULTS.deferMaxAgeMs).toBe(1_800_000)
  })

  it('accepts config overrides and settings overlay for all four keys', () => {
    const cfg = resolveConfig({
      'defer-requests': 2,
      'defer-margin': 2,
      'defer-max-age-ms': 60_000,
      'defer-urgency-tokens': 4096,
    })
    expect(cfg.deferRequests).toBe(2)
    expect(cfg.deferMargin).toBe(2)
    expect(cfg.deferMaxAgeMs).toBe(60_000)
    expect(cfg.deferUrgencyTokens).toBe(4096)
    const overlaid = overlaySettings(cfg, { 'defer-requests': 5, 'defer-urgency-tokens': 1024 })
    expect(overlaid.deferRequests).toBe(5)
    expect(overlaid.deferUrgencyTokens).toBe(1024)
    expect(overlaid.deferMargin).toBe(2)
  })

  it('rejects invalid defer values', () => {
    expect(() => resolveConfig({ 'defer-requests': -1 })).toThrow()
    expect(() => resolveConfig({ 'defer-requests': 1.5 })).toThrow()
    expect(() => resolveConfig({ 'defer-margin': 0 })).toThrow()
    expect(() => resolveConfig({ 'defer-max-age-ms': 0 })).toThrow()
    expect(() => resolveConfig({ 'defer-urgency-tokens': -5 })).toThrow()
  })
})

describe('evaluateDeferGate (suffix-cost economics)', () => {
  const base = { tokensSaved: 100, remainingRequestsEstimate: 2, margin: 1.5, suffixTokens: 100 }

  it('passes when tokensSaved × remaining > margin × suffix', () => {
    const out = evaluateDeferGate(base)
    expect(out.pass).toBe(true)
    expect(out.projectedSavings).toBe(200)
    expect(out.suffixCost).toBe(150)
    expect(out.urgencyOverride).toBe(false)
  })

  it('fails at the exact margin boundary (strict >)', () => {
    expect(evaluateDeferGate({ ...base, suffixTokens: 200 / 1.5 }).pass).toBe(false)
    expect(evaluateDeferGate({ ...base, suffixTokens: 200 / 1.5 - 0.01 }).pass).toBe(true)
  })

  it('floors the remaining-requests estimate at 1', () => {
    const out = evaluateDeferGate({ ...base, remainingRequestsEstimate: 0 })
    expect(out.projectedSavings).toBe(100)
  })

  it('urgency override swaps regardless of the gate when within the window distance', () => {
    const out = evaluateDeferGate({
      ...base,
      tokensSaved: 1,
      suffixTokens: 1_000_000,
      urgencyTokens: 4096,
      sessionTokens: 196_000,
      contextWindow: 200_000,
    })
    expect(out.pass).toBe(true)
    expect(out.urgencyOverride).toBe(true)
  })

  it('urgency stays inactive without a window source or when the key is unset', () => {
    const common = { ...base, tokensSaved: 1, suffixTokens: 1_000_000 }
    // Outside the override distance: 100_000 < 200_000 − 4_096.
    expect(evaluateDeferGate({ ...common, urgencyTokens: 4096, sessionTokens: 100_000, contextWindow: 200_000 }).pass).toBe(false)
    // No window source → inactive even inside the nominal distance.
    expect(evaluateDeferGate({ ...common, urgencyTokens: 4096, sessionTokens: 199_999 }).pass).toBe(false)
    // Key unset → inactive.
    expect(evaluateDeferGate({ ...common, sessionTokens: 199_999, contextWindow: 200_000 }).pass).toBe(false)
  })
})

describe('stream first-chunk counting', () => {
  function options(over: Partial<GenerateOptions> = {}): GenerateOptions {
    return {
      provider: 'mock',
      model: 'mock',
      messages: [],
      ...over,
    } as GenerateOptions
  }

  function toolResultMessage(text: string): Message {
    return {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text }] }],
    } as unknown as Message
  }

  it('fingerprints are sha256-16 of the joined tool-result text', () => {
    const text = 'line a\nline b'
    const fps = toolResultFingerprints([toolResultMessage(text)])
    expect(fps.has(shortHash(text))).toBe(true)
    expect(fps.size).toBe(1)
  })

  it('skips tool-result blocks with non-text content', () => {
    const message = {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId('c1'),
        content: [{ type: 'image' }],
      }],
    } as unknown as Message
    expect(toolResultFingerprints([message]).size).toBe(0)
  })

  it('counts only main-loop purposes for the owning session (allowlist + sessionId guard)', () => {
    const owned = new Set(['sess-1'])
    expect(shouldCountRequest(options({ sessionId: 'sess-1' as never }), owned)).toBe(true)
    expect(shouldCountRequest(options({ sessionId: 'sess-1' as never, purpose: 'compaction' }), owned)).toBe(false)
    expect(shouldCountRequest(options({ sessionId: 'sess-1' as never, purpose: 'session-title' }), owned)).toBe(false)
    // A fork-inheriting subagent session id never ages the parent's residents.
    expect(shouldCountRequest(options({ sessionId: 'sess-2' as never }), owned)).toBe(false)
    expect(shouldCountRequest(options({}), owned)).toBe(false)
  })

  it('counts exactly once at the first chunk and passes chunks through', async () => {
    let counted = 0
    async function* stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text', text: 'a' } as unknown as StreamChunk
      yield { type: 'text', text: 'b' } as unknown as StreamChunk
    }
    const wrapped = wrapStreamWithCounting(options(), stream(), () => { counted += 1 })
    const seen: unknown[] = []
    for await (const chunk of wrapped) seen.push(chunk)
    expect(counted).toBe(1)
    expect(seen.length).toBe(2)
  })

  it('PHASE-0 PIN: a stream that throws before its first yield counts zero', async () => {
    let counted = 0
    async function* stream(): AsyncIterable<StreamChunk> {
      throw new Error('provider exploded before first chunk')
      // eslint-disable-next-line no-unreachable
      yield { type: 'text', text: 'a' } as unknown as StreamChunk
    }
    const wrapped = wrapStreamWithCounting(options(), stream(), () => { counted += 1 })
    await expect(async () => {
      for await (const chunk of wrapped) void chunk
    }).rejects.toThrow('provider exploded before first chunk')
    expect(counted).toBe(0)
  })
})

describe('defer ledger fold + todo snapshot', () => {
  const residentRow: DeferLedgerRow = {
    ts: '2026-09-20T00:00:00.000Z',
    type: 'resident',
    hash: 'a1b2c3d4e5f60708',
    callId: 'call-1',
    tokensSaved: 100,
    createdAt: 1_000,
  }

  it('folds resident rows into candidates and committed swap rows remove them', () => {
    expect(foldDeferRows([residentRow]).size).toBe(1)
    for (const outcome of ['applied', 'stale', 'abandoned'] as const) {
      const rows: DeferLedgerRow[] = [residentRow, {
        ts: '2026-09-20T00:01:00.000Z', type: 'swap', hash: residentRow.hash, callId: 'call-1',
        outcome, applied: outcome === 'applied',
      }]
      expect(foldDeferRows(rows).size).toBe(0)
    }
  })

  it('dry-run intent rows do NOT remove the resident (nothing was applied)', () => {
    const rows: DeferLedgerRow[] = [residentRow, {
      ts: '2026-09-20T00:01:00.000Z', type: 'swap', hash: residentRow.hash, callId: 'call-1',
      outcome: 'dry-run', applied: false,
    }]
    expect(foldDeferRows(rows).size).toBe(1)
  })

  it('folded candidates always resume at sentCount 0', () => {
    const entry = foldDeferRows([residentRow]).get(residentRow.hash)
    expect(entry?.sentCount).toBe(0)
    expect(entry?.tokensSaved).toBe(100)
    expect(entry?.createdAt).toBe(1_000)
  })

  it('parseTodoCounts counts the latest snapshot and rejects garbage', () => {
    expect(parseTodoCounts({ todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ] })).toEqual({ completed: 1, pending: 2 })
    expect(parseTodoCounts({})).toBeUndefined()
    expect(parseTodoCounts({ todos: [{ nope: true }] })).toBeUndefined()
    expect(parseTodoCounts('x')).toBeUndefined()
  })
})

describe('rebuildResidents (resume by surface fingerprint)', () => {
  it('rebuilds entries whose stored text is live on the surface; drops the rest', async () => {
    const home = tmpHome()
    const store = new CrusherStore(join(home, 'ccr'))
    const projectKey = shortHash('/project')
    const liveText = 'live result body '.repeat(50)
    const goneText = 'compacted away body '.repeat(50)
    const liveHash = await store.put(projectKey, liveText)
    const goneHash = await store.put(projectKey, goneText)
    const session = Session.create(SessionId('resume-1'))
    appendToolStep(session, 1, 'call-live', liveText)

    const rows: DeferLedgerRow[] = [
      { ts: 't', type: 'resident', hash: liveHash, callId: 'call-live', tokensSaved: 10, createdAt: 1 },
      { ts: 't', type: 'resident', hash: goneHash, callId: 'call-gone', tokensSaved: 20, createdAt: 2 },
    ]
    const rebuilt = await rebuildResidents({ rows, store, projectKey, session })
    expect(rebuilt.size).toBe(1)
    const entry = rebuilt.get(liveHash)
    expect(entry).toBeDefined()
    expect(entry?.sentCount).toBe(0)
    expect(entry?.tokensSaved).toBe(10)
  })

  it('drops a resident whose surface body no longer matches the stored text', async () => {
    const home = tmpHome()
    const store = new CrusherStore(join(home, 'ccr'))
    const projectKey = shortHash('/project')
    const hash = await store.put(projectKey, 'original body '.repeat(50))
    const session = Session.create(SessionId('resume-2'))
    appendToolStep(session, 1, 'call-1', 'mutated body '.repeat(50))
    const rebuilt = await rebuildResidents({
      rows: [{ ts: 't', type: 'resident', hash, callId: 'call-1', tokensSaved: 10, createdAt: 1 }],
      store, projectKey, session,
    })
    expect(rebuilt.size).toBe(0)
  })
})

describe('attemptSwap (paired prune + replace, microcompact shape)', () => {
  const FULL = 'full deferred body '.repeat(40)
  const STUB = 'stub body\n[dsh-cc compressed 100→10 tokens. Original: ccr://a1b2c3d4e5f60708]'

  function swapInput(session: Session, over: Partial<Parameters<typeof attemptSwap>[0]> = {}) {
    return {
      session,
      entry: resident(),
      fullText: FULL,
      stubText: STUB,
      apply: true,
      margin: 1.5,
      remainingRequestsEstimate: 1,
      estimateMessage: estimate,
      ...over,
    }
  }

  it('appends prune then replace adjacently, preserves non-content fields, debits the meter', () => {
    const session = Session.create(SessionId('swap-1'))
    const seq = appendToolStep(session, 1, 'call-1', FULL)
    appendAssistantText(session, 2, 'short tail')
    const result = attemptSwap(swapInput(session))
    expect(result.outcome).toBe('applied')

    const log = session.snapshotEvents()
    const pruneIdx = log.findIndex((e) => e.type === 'compaction/prune')
    expect(pruneIdx).toBeGreaterThan(-1)
    const prune = log[pruneIdx]
    expect(prune?.type === 'compaction/prune' && prune.data.shadowedSeqs).toEqual([seq])
    const originalMessage = log[seq]
    expect(originalMessage?.type).toBe('tool/result')
    if (originalMessage?.type === 'tool/result') {
      expect(prune?.type === 'compaction/prune' && prune.data.shadowedTokenCount)
        .toBe(estimate(originalMessage.data.message))
    }
    // The replacement is the very next event and cites the shadowed node.
    const replacement = log[pruneIdx + 1]
    expect(replacement?.type).toBe('tool/result')
    if (replacement?.type === 'tool/result') {
      expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: seq, endSeq: seq })
      expect(replacement.sourceEventSeqs).toEqual([seq])
      const block = replacement.data.message.content[0]
      expect(block?.type).toBe('tool-result')
      if (block?.type === 'tool-result') {
        // Every non-content field of the original block survives.
        expect(block.toolCallId).toBe(ToolCallId('call-1'))
        expect(block.isError).toBe(false)
        expect(block.content).toEqual([{ type: 'text', text: STUB }])
      }
    }
    // Log stays append-only: the original event bytes are untouched; the
    // surface shows the stub.
    if (originalMessage?.type === 'tool/result') {
      const block = originalMessage.data.message.content[0]
      expect(block?.type === 'tool-result' && block.content[0]).toEqual({ type: 'text', text: FULL })
    }
    expect(surfaceResultTexts(session)).toEqual([STUB])
  })

  it('drops as stale when the surface body no longer byte-equals the stored text', () => {
    const session = Session.create(SessionId('swap-2'))
    appendToolStep(session, 1, 'call-1', 'mutated body '.repeat(40))
    const result = attemptSwap(swapInput(session))
    expect(result.outcome).toBe('stale')
    expect(session.snapshotEvents().some((e) => e.type === 'compaction/prune')).toBe(false)
  })

  it('drops as stale when the callId is absent from the surface', () => {
    const session = Session.create(SessionId('swap-3'))
    appendToolStep(session, 1, 'call-other', FULL)
    expect(attemptSwap(swapInput(session)).outcome).toBe('stale')
  })

  it('keeps the surface untouched when the gate fails and reports the facts', () => {
    const session = Session.create(SessionId('swap-4'))
    appendToolStep(session, 1, 'call-1', FULL)
    appendAssistantText(session, 2, 'x'.repeat(10_000))
    const result = attemptSwap(swapInput(session, { margin: 1e9 }))
    expect(result.outcome).toBe('gate-failed')
    if (result.outcome === 'gate-failed') {
      expect(result.gate.suffixTokens).toBeGreaterThan(0)
      expect(result.gate.projectedSavings).toBe(100)
    }
    expect(surfaceResultTexts(session)).toEqual([FULL])
  })

  it('dry-run (apply:false) evaluates but appends nothing', () => {
    const session = Session.create(SessionId('swap-5'))
    appendToolStep(session, 1, 'call-1', FULL)
    const result = attemptSwap(swapInput(session, { apply: false }))
    expect(result.outcome).toBe('dry-run')
    expect(session.snapshotEvents().some((e) => e.type === 'compaction/prune')).toBe(false)
    expect(surfaceResultTexts(session)).toEqual([FULL])
  })

  it('measures the suffix at swap time (only surface nodes AFTER the entry)', () => {
    const session = Session.create(SessionId('swap-6'))
    appendAssistantText(session, 1, 'y'.repeat(500))
    const seq = appendToolStep(session, 2, 'call-1', FULL)
    appendAssistantText(session, 3, 'z'.repeat(100))
    const suffix = suffixTokensAfter(session, seq, estimate)
    const tailOnly = suffixTokensAfter(session, seq, estimate)
    expect(suffix).toBe(tailOnly)
    // The 500-char pre-entry node is excluded; the 100-char tail is included.
    expect(suffix).toBeLessThan(500)
    expect(suffix).toBeGreaterThan(0)
  })
})
