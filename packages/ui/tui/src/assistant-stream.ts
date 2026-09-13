/**
 * Assistant reply/thinking folding over the cordis `agent/assistant-stream`
 * notification (live painting from transient frames) and the durable
 * `assistant/message` `data.stream` (settle backfill on replay/compact).
 * UI-only: never appends new durable event types.
 * @module @dsh-cc/tui/assistant-stream
 */
import type { TranscriptRow, TuiState } from './store.ts'
import type { SessionEventLike } from './transcript.ts'

/**
 * Structural mirror of the harness assistant-stream frame (owned upstream by
 * the agent package). Kept local on purpose: UI/store modules must not
 * import harness packages (the tui-boundary gate is textual).
 */
export interface AssistantStreamFrameLike {
  type: string
  attemptId?: string
  revision?: number
  index?: number
  turn?: number
  step?: number
  chunk?: StreamChunkLike
}

/** Structural mirror of the upstream stream chunk union (fields the fold reads). */
export interface StreamChunkLike {
  type: string
  text?: string
  blockType?: string
  index?: number
}

/** Live scratch rows are plain assistant/thinking rows carrying a streamKey. */
type ScratchRow = Extract<TranscriptRow, { kind: 'assistant' | 'thinking' }>

function scratchOf(row: TranscriptRow): (ScratchRow & { streamKey: string }) | undefined {
  return (row.kind === 'assistant' || row.kind === 'thinking') && row.streamKey !== undefined
    ? { ...row, streamKey: row.streamKey }
    : undefined
}

function scratchKey(turn: number, step: number, kind: 'assistant' | 'thinking'): string {
  return `${turn}:${step}:${kind}`
}

/** Drop scratch rows owned by one durable (turn, step), and its live owner. */
function dropScratchFor(state: TuiState, turn: number, step: number): TuiState {
  const prefix = `${turn}:${step}:`
  const rows = state.rows.filter(row => scratchOf(row) === undefined || !scratchOf(row)!.streamKey.startsWith(prefix))
  const { liveStream, ...rest } = state
  const cleared = liveStream !== undefined && liveStream.turn === turn && liveStream.step === step
  return { ...(cleared ? rest : state), rows }
}

/**
 * Fold one live `agent/assistant-stream` frame into the view model. Chunk
 * frames carry only `attemptId`, so the `start` frame parks its (turn, step)
 * owner on `state.liveStream`; chunks for an unknown attempt are ignored.
 */
export function applyStreamFrame(state: TuiState, frame: AssistantStreamFrameLike): TuiState {
  if (frame.type === 'start') {
    // Malformed payload (or a non-frame object arriving on the bus): ignore.
    if (typeof frame.attemptId !== 'string' || typeof frame.turn !== 'number' || typeof frame.step !== 'number') return state
    // A fresh attempt supersedes any in-flight scratch rows (retry lineage).
    const { liveStream: _dropped, ...rest } = state
    return {
      ...rest,
      rows: state.rows.filter(row => scratchOf(row) === undefined),
      liveStream: { attemptId: frame.attemptId, turn: frame.turn, step: frame.step },
    }
  }
  if (frame.type === 'end') {
    const owner = state.liveStream
    if (owner === undefined || owner.attemptId !== frame.attemptId) return state
    // The durable settle fold already replaced scratch rows on commit; on
    // abandonment (or a missed settle) dropping here clears the residue.
    return dropScratchFor(state, owner.turn, owner.step)
  }
  const owner = state.liveStream
  if (owner === undefined || frame.chunk === undefined || owner.attemptId !== frame.attemptId) return state
  return foldLiveChunk(state, owner.turn, owner.step, frame.chunk)
}

function foldLiveChunk(state: TuiState, turn: number, step: number, chunk: StreamChunkLike): TuiState {
  switch (chunk.type) {
    case 'text-delta':
      return typeof chunk.text === 'string' ? appendScratch(state, turn, step, 'assistant', chunk.text) : state
    case 'reasoning-delta':
      return typeof chunk.text === 'string' ? appendScratch(state, turn, step, 'thinking', chunk.text) : state
    case 'block-start':
      if (chunk.blockType === 'text') return ensureScratch(state, turn, step, 'assistant')
      if (chunk.blockType === 'reasoning') return ensureScratch(state, turn, step, 'thinking')
      return state
    default:
      // tool-call-delta (tool cards come from durable tool/call), block-end,
      // usage, finish: nothing to paint live.
      return state
  }
}

/** Append delta text to the step's scratch row, creating it when absent. */
function appendScratch(
  state: TuiState,
  turn: number,
  step: number,
  kind: 'assistant' | 'thinking',
  text: string,
): TuiState {
  const key = scratchKey(turn, step, kind)
  const index = state.rows.findIndex(entry => scratchOf(entry)?.streamKey === key)
  const existing = index >= 0 ? scratchOf(state.rows[index]!) : undefined
  const row: ScratchRow = { kind, text: (existing?.text ?? '') + text, streamKey: key }
  const rows = state.rows.slice()
  if (index >= 0) rows[index] = row
  else rows.push(row)
  return { ...state, rows }
}

/** Ensure the step's scratch row exists (empty text), preserving block order. */
function ensureScratch(
  state: TuiState,
  turn: number,
  step: number,
  kind: 'assistant' | 'thinking',
): TuiState {
  const key = scratchKey(turn, step, kind)
  if (state.rows.some(row => scratchOf(row)?.streamKey === key)) return state
  return { ...state, rows: [...state.rows, { kind, text: '', streamKey: key } satisfies ScratchRow] }
}

/** Visible text of one durable stream entry (raw chunk or packed run). */
function recordText(
  record: Record<string, unknown>,
  text: Map<number, string>,
  reasoning: Map<number, string>,
): void {
  const inner = record.chunk
  if (inner !== null && typeof inner === 'object') {
    const chunk = inner as Record<string, unknown>
    const block = chunk.block
    if (chunk.type === 'block-end' && block !== null && typeof block === 'object') {
      const typed = block as { type?: unknown; text?: unknown }
      const index = typeof chunk.index === 'number' ? chunk.index : 0
      if (typed.type === 'text' && typeof typed.text === 'string') text.set(index, typed.text)
      if (typed.type === 'reasoning' && typeof typed.text === 'string') reasoning.set(index, typed.text)
    }
    return
  }
  if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks') return
  if (typeof record.index !== 'number' || !Array.isArray(record.texts)) return
  const map = record.type === 'text-chunks' ? text : reasoning
  const packed = record.texts.filter(part => typeof part === 'string').join('')
  map.set(record.index, (map.get(record.index) ?? '') + packed)
}

/** Concatenate per-block text in block-index order. */
function blocksInOrder(map: Map<number, string>): string {
  return [...map.keys()].sort((a, b) => a - b).map(index => map.get(index) ?? '').join('')
}

/**
 * Visible text/reasoning of a settled message as ordered rows: its packed
 * stream, else its legacy content blocks. Rows are emitted in block order
 * (first block index decides text-vs-reasoning precedence).
 */
function settleRows(data: Record<string, unknown>): readonly ScratchRow[] {
  const stream = Array.isArray(data.stream) ? data.stream : []
  if (stream.length > 0) {
    const text = new Map<number, string>()
    const reasoning = new Map<number, string>()
    for (const entry of stream) {
      if (entry !== null && typeof entry === 'object') recordText(entry as Record<string, unknown>, text, reasoning)
    }
    const first = (map: Map<number, string>): number => map.size === 0 ? Infinity : Math.min(...map.keys())
    const thinkingRow = { kind: 'thinking', text: blocksInOrder(reasoning) } as const
    const replyRow = { kind: 'assistant', text: blocksInOrder(text) } as const
    // One row per kind, ordered by first block index (reasoning wins ties).
    return first(reasoning) <= first(text) ? [thinkingRow, replyRow] : [replyRow, thinkingRow]
  }
  // Legacy durability (pre-stream logs): fall back to message.content blocks.
  const message = data.message
  const content = message !== null && typeof message === 'object' && Array.isArray((message as { content?: unknown }).content)
    ? (message as { content: readonly unknown[] }).content
    : []
  const rows: ScratchRow[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typeof typed.text !== 'string' || typed.text.length === 0) continue
    if (typed.type === 'text') rows.push({ kind: 'assistant', text: typed.text })
    if (typed.type === 'reasoning') rows.push({ kind: 'thinking', text: typed.text })
  }
  // Legacy logs interleave block types per content order but the transcript
  // keeps at most one row per kind: concatenate same-kind blocks in order.
  const collapsed: ScratchRow[] = []
  for (const row of rows) {
    const last = collapsed[collapsed.length - 1]
    if (last !== undefined && last.kind === row.kind) last.text += row.text
    else collapsed.push(row)
  }
  return collapsed
}

/**
 * Settle the durable `assistant/message` fold: replace this (turn, step)'s
 * live scratch rows with final rows derived from `event.data.stream` (or the
 * legacy `message.content` blocks), seq-tagged so compaction surface
 * replacements drop them like any durable row.
 */
export function foldSettledMessage(state: TuiState, event: SessionEventLike): TuiState {
  const data = (event.data ?? {}) as Record<string, unknown>
  const turn = typeof data.turn === 'number' ? data.turn : 0
  const step = typeof data.step === 'number' ? data.step : 0
  // Shadowed compaction history: drop any live residue, never re-insert.
  if (state.shadowedThrough !== undefined && typeof event.seq === 'number' && event.seq <= state.shadowedThrough) {
    return dropScratchFor(state, turn, step)
  }
  const rows = state.rows.filter(row => {
    const scratch = scratchOf(row)
    return scratch === undefined || !scratch.streamKey.startsWith(`${turn}:${step}:`)
  })
  const seq = typeof event.seq === 'number' ? { seq: event.seq } : {}
  for (const final of settleRows(data)) {
    if (final.text.length > 0) rows.push({ ...final, ...seq })
  }
  return { ...state, rows }
}
