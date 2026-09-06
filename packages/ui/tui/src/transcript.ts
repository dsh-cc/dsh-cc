/**
 * Fold a harness session-event envelope into the TUI store. UI-only: never
 * appends new durable event types.
 * @module @dsh-cc/tui/transcript
 */

import {
  formatCallCard,
  formatResultCard,
  type ToolCallView,
  type ToolResultView,
} from './tool-card.ts'
import {
  setBusy,
  setPermissionMode,
  setSessionTitle,
  upsertRow,
  type TranscriptRow,
  type TuiState,
} from './store.ts'
import { dropRowsInRange, extractCompactSummary, isCompactCheckpointSource } from './compact-fold.ts'

/**
 * Minimal session-event face the TUI understands. `seq` tags created rows so
 * a surface replacement can drop exactly the replaced span; `surfaceOp`
 * mirrors the session surface contract (plain `'append'` or a positional
 * `'replace'` range).
 */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
  readonly seq?: number
  readonly surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
}

/** Optional presenters looked up by tool name (agent-scoped registry). */
export interface ToolPresenters {
  presentCall?(name: string, args: unknown): ToolCallView | undefined
  presentResult?(name: string, args: unknown, result: { content: unknown; isError: boolean; meta?: unknown }): ToolResultView | undefined
}

function parseArgs(raw: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function textOf(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  if (typeof data !== 'object') return String(data)
  const record = data as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.message === 'string') return record.message
  if (typeof record.content === 'string') return record.content
  // UserMessage carries content as an array of typed blocks; concatenate the
  // text of every text block (ignore images and other non-text blocks).
  if (Array.isArray(record.content)) {
    return record.content
      .filter((block): block is { type: 'text'; text: string } =>
        block !== null && typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join('')
  }
  return ''
}

function callIdOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (record.callId !== undefined) return String(record.callId)
  if (record.id !== undefined) return String(record.id)
  return ''
}

function nameOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return 'tool'
  const record = data as Record<string, unknown>
  if (typeof record.name === 'string') return record.name
  if (typeof record.toolName === 'string') return record.toolName
  return 'tool'
}

function argsOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (typeof record.arguments === 'string') return record.arguments
  if (record.arguments !== undefined) {
    try {
      return JSON.stringify(record.arguments)
    } catch {
      return String(record.arguments)
    }
  }
  return ''
}

/** Unwrap the live {turn, step, chunk} envelope to the inner StreamChunk. */
function unwrapChunk(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  if (record.chunk !== null && typeof record.chunk === 'object' && !Array.isArray(record.chunk)) {
    return record.chunk
  }
  return data
}

interface ToolCallDeltaChunk {
  readonly type: 'tool-call-delta'
  readonly id: string | number
  readonly name?: string
  readonly argumentsDelta: string
}

/** Structural check for a tool-call-delta stream chunk. */
function isToolCallDelta(chunk: unknown): chunk is ToolCallDeltaChunk {
  if (chunk === null || typeof chunk !== 'object') return false
  const record = chunk as Record<string, unknown>
  return record.type === 'tool-call-delta'
    && (typeof record.id === 'string' || typeof record.id === 'number')
    && typeof record.argumentsDelta === 'string'
}

function chunkKind(data: unknown): 'assistant' | 'thinking' {
  const chunk = unwrapChunk(data)
  if (chunk === null || typeof chunk !== 'object') return 'assistant'
  const record = chunk as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (type.includes('reason') || type.includes('think')) return 'thinking'
  if (record.reasoning === true) return 'thinking'
  return 'assistant'
}

function chunkText(data: unknown): string {
  if (data === null || typeof data !== 'object') return textOf(data)
  const record = unwrapChunk(data) as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.delta === 'string') return record.delta
  if (record.delta !== null && typeof record.delta === 'object') {
    const delta = record.delta as Record<string, unknown>
    if (typeof delta.text === 'string') return delta.text
  }
  return textOf(data)
}

/**
 * Seq tag for rows created by `event`: rows carry the log position that
 * produced them so a surface `replace` can drop the exact replaced span.
 * Omitted (key absent) when the envelope carries no seq.
 */
function seqTag(event: SessionEventLike): { seq: number } | Record<string, never> {
  return typeof event.seq === 'number' ? { seq: event.seq } : {}
}

/** The surface-replacement range of a `user/message`, when it replaces. */
function replaceOpOf(
  event: SessionEventLike,
): { start: number; end: number } | undefined {
  const op = event.surfaceOp
  if (typeof op !== 'object' || op === null || op.op !== 'replace') return undefined
  return typeof op.start === 'number' && typeof op.end === 'number' ? { start: op.start, end: op.end } : undefined
}

/** Drop `pendingCompact` (exactOptionalPropertyTypes-safe field removal). */
function withoutPendingCompact(state: TuiState): TuiState {
  const { pendingCompact: _dropped, ...rest } = state
  return rest
}

/**
 * Apply one surface replacement: drop the replaced span from the transcript
 * and — when the replacement is a compact checkpoint — paint the collapsible
 * compact boundary at the cut point using the metering armed by the adjacent
 * `compaction/summary`. Non-checkpoint replacements just shrink the visible
 * transcript (the model sees the same surface).
 */
function applySurfaceReplace(
  state: TuiState,
  event: SessionEventLike,
  op: { start: number; end: number },
): TuiState {
  const data = event.data
  const source = data !== null && typeof data === 'object'
    ? (data as { source?: unknown }).source
    : undefined
  const rows = dropRowsInRange(state.rows, op.start, op.end)
  if (!isCompactCheckpointSource(source)) {
    return withoutPendingCompact({ ...state, rows })
  }
  const pending = state.pendingCompact
  const sourceCommandId = pending?.sourceCommandId
    ?? (source !== null && typeof source === 'object'
      && typeof (source as { sourceCommandId?: unknown }).sourceCommandId === 'string'
      ? (source as { sourceCommandId: string }).sourceCommandId
      : undefined)
  const compact: TranscriptRow = {
    kind: 'compact',
    trigger: sourceCommandId === undefined ? 'auto' : 'manual',
    items: pending?.items ?? 0,
    tokens: pending?.tokens ?? 0,
    summary: extractCompactSummary((data as { content?: unknown }).content),
    ...seqTag(event),
  }
  // Insert at the cut point: before the first surviving row past the
  // replaced range (or the tail when the compaction kept nothing newer).
  const insertAt = rows.findIndex(row => {
    const seq = (row as { seq?: unknown }).seq
    return typeof seq === 'number' && seq > op.end
  })
  const withCompact = insertAt === -1
    ? [...rows, compact]
    : [...rows.slice(0, insertAt), compact, ...rows.slice(insertAt)]
  return withoutPendingCompact({ ...state, rows: withCompact })
}

/**
 * Fold a tool-call-delta chunk into the pending tool row, accumulating
 * `argumentsDelta` per callId. Presenters are NOT invoked on partial JSON;
 * the durable tool/call finalizes the card through the existing callId
 * upsert. A delta arriving after the row was finalized (running:false with
 * a result) is ignored — durable order normally prevents this.
 */
function foldToolCallDelta(state: TuiState, chunk: ToolCallDeltaChunk, seq: number | undefined): TuiState {
  const callId = String(chunk.id)
  const carriedName = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
  const existing = state.rows.find(row => row.kind === 'tool' && row.callId === callId)
  if (existing !== undefined && existing.kind === 'tool') {
    if (existing.running === false && existing.result !== undefined) return state
    const name = carriedName !== undefined && existing.name === 'tool' ? carriedName : existing.name
    const title = carriedName !== undefined && existing.title === 'tool' ? carriedName : existing.title
    return setBusy(upsertRow(state, {
      kind: 'tool',
      callId,
      name,
      args: existing.args + chunk.argumentsDelta,
      title,
      ...existing.body !== undefined ? { body: existing.body } : {},
      ...existing.result !== undefined ? { result: existing.result } : {},
      ...existing.error !== undefined ? { error: existing.error } : {},
      running: true,
      ...seq === undefined ? {} : { seq },
    }), true)
  }
  const initialName = carriedName ?? 'tool'
  return setBusy(upsertRow(state, {
    kind: 'tool',
    callId,
    name: initialName,
    args: chunk.argumentsDelta,
    title: initialName,
    running: true,
    ...seq === undefined ? {} : { seq },
  }), true)
}

/**
 * Apply one session event to the view model.
 * @param state - current TUI state.
 * @param event - a `session/event` envelope.
 * @param presenters - optional presentCall/presentResult lookup.
 */
export function applySessionEvent(
  state: TuiState,
  event: SessionEventLike,
  presenters?: ToolPresenters,
): TuiState {
  const data = event.data
  switch (event.type) {
    case 'user/message': {
      // A surface replacement follows the compact seam: drop the replaced
      // span and (for the checkpoint) paint the compact boundary. Busy and
      // turn anchoring stay driver-side.
      const replace = replaceOpOf(event)
      if (replace !== undefined) return applySurfaceReplace(state, event, replace)
      // Route on UserMessage.source.kind: only human input renders as a user
      // row. Injected context (kind 'plugin') is model-facing — a notice form
      // surfaces as a one-line dim status per its contract, every other form
      // (instructions/catalog/snapshot/relay/recall) stays hidden. Tool and
      // unknown/absent kinds fold to nothing: never dump unrecognized
      // injected content as if the user typed it.
      const source = data !== null && typeof data === 'object'
        ? (data as { source?: unknown }).source
        : undefined
      const kind = source !== null && typeof source === 'object'
        && typeof (source as { kind?: unknown }).kind === 'string'
        ? (source as { kind: string }).kind
        : undefined
      if (kind !== 'user') {
        if (kind === 'plugin') {
          const plugin = source as { form?: unknown; summary?: unknown }
          if (plugin.form === 'notice' && typeof plugin.summary === 'string') {
            return upsertRow(state, { kind: 'status', text: plugin.summary, ...seqTag(event) })
          }
        }
        return state
      }
      const text = textOf(data)
      // Chip clearing is deliberately NOT event-driven: the driver clears the
      // queue synchronously at dispatch (flush / Ctrl+S / interrupt / recall),
      // so a late durable `user/message` can never wipe a same-text chip the
      // user re-queued in the meantime. Empty or whitespace-only text adds no
      // row (no blank `> ` lines).
      if (text.trim().length === 0) return state
      return upsertRow(state, { kind: 'user', text, ...seqTag(event) })
    }
    case 'compaction/summary': {
      // Metering for the immediately following surface replacement: park the
      // shadowed accounting on state; the replacement paints the compact row.
      const record = data !== null && typeof data === 'object'
        ? (data as { shadowedSeqs?: unknown; shadowedTokenCount?: unknown; sourceCommandId?: unknown })
        : {}
      const items = Array.isArray(record.shadowedSeqs) ? record.shadowedSeqs.length : 0
      const tokens = typeof record.shadowedTokenCount === 'number' ? record.shadowedTokenCount : 0
      return {
        ...state,
        pendingCompact: {
          items,
          tokens,
          ...typeof record.sourceCommandId === 'string' ? { sourceCommandId: record.sourceCommandId } : {},
        },
      }
    }
    case 'assistant/chunk': {
      const chunk = unwrapChunk(data)
      if (isToolCallDelta(chunk)) return foldToolCallDelta(state, chunk, event.seq)
      const text = chunkText(data)
      if (text.length === 0) return setBusy(state, true)
      return setBusy(upsertRow(state, { kind: chunkKind(data), text, ...seqTag(event) }), true)
    }
    case 'assistant/message':
      return setBusy(state, false)
    case 'tool/call': {
      const name = nameOf(data)
      const args = argsOf(data)
      const view = presenters?.presentCall?.(name, parseArgs(args))
      const card = formatCallCard(view, { name, args })
      const diffs = view !== undefined && view.card === 'diff' ? view.diffs : undefined
      return upsertRow(state, {
        kind: 'tool',
        callId: callIdOf(data),
        name,
        args,
        title: card.title,
        ...card.body === undefined ? {} : { body: card.body },
        ...diffs !== undefined ? { diffs } : {},
        running: true,
        ...seqTag(event),
      })
    }
    case 'tool/result': {
      const name = nameOf(data)
      const callId = callIdOf(data)
      const pending = state.rows.find(row => row.kind === 'tool' && row.callId === callId)
      const pendingTitle = pending?.kind === 'tool' ? pending.title : name
      const pendingArgs = pending?.kind === 'tool' ? pending.args : argsOf(data)
      const isError = data !== null && typeof data === 'object' && (data as { error?: unknown }).error !== undefined
      const fallback = textOf(data) || argsOf(data)
      const view = presenters?.presentResult?.(name, parseArgs(pendingArgs), {
        content: data,
        isError,
      })
      const card = formatResultCard(view, { pendingTitle, fallback, error: isError })
      const diffs = view !== undefined && view.card === 'diff' ? view.diffs : undefined
      return upsertRow(state, {
        kind: 'tool',
        callId,
        name,
        args: pendingArgs,
        title: card.title,
        ...card.body === undefined ? {} : { body: card.body, result: card.body },
        ...diffs !== undefined ? { diffs } : {},
        error: card.error,
        running: false,
        ...seqTag(event),
      })
    }
    case 'turn/start':
      return setBusy(state, true)
    case 'turn/end': {
      // A turn always clears busy. Beyond that, fold the reason into a visible
      // status row so a backend failure never ends the turn silently: error
      // reasons paint red, blocked/max-tokens paint dim, and
      // completed/aborted/absent add nothing (abort already shows
      // "Interrupted by user." from interrupt()).
      const reason = data !== null && typeof data === 'object'
        ? (data as { reason?: unknown }).reason
        : undefined
      const kind = reason !== null && typeof reason === 'object'
        ? (reason as { kind?: unknown }).kind
        : undefined
      if (kind === 'error') {
        const err = (reason as { error?: unknown }).error
        const message = err !== null && typeof err === 'object'
          ? (err as { message?: unknown }).message
          : undefined
        const text = typeof message === 'string' && message.length > 0
          ? `⚠ Turn failed: ${message}`
          : '⚠ Turn failed'
        return setBusy(upsertRow(state, { kind: 'status', text, error: true, ...seqTag(event) }), false)
      }
      if (kind === 'blocked') {
        return setBusy(upsertRow(state, { kind: 'status', text: '⚠ Turn blocked', ...seqTag(event) }), false)
      }
      if (kind === 'max-tokens') {
        return setBusy(upsertRow(state, { kind: 'status', text: '⚠ Reached the token ceiling', ...seqTag(event) }), false)
      }
      return setBusy(state, false)
    }
    case 'agent/status': {
      const status = data !== null && typeof data === 'object'
        ? (data as { status?: string }).status
        : undefined
      if (event.type === 'agent/status' && status === 'running') return setBusy(state, true)
      return setBusy(state, false)
    }
    case 'permission/mode': {
      const mode = data !== null && typeof data === 'object'
        ? (data as { mode?: string }).mode
        : undefined
      return mode === undefined ? state : setPermissionMode(state, mode)
    }
    case 'plan/mode': {
      const active = data !== null && typeof data === 'object'
        ? (data as { active?: boolean }).active
        : undefined
      return active ? setPermissionMode(state, 'plan') : state
    }
    case 'session/title': {
      // Log-only framework title (fallback or LLM provider): fold last-wins
      // into state.title for the window-title effect; never a transcript row.
      const title = data !== null && typeof data === 'object'
        ? (data as { title?: unknown }).title
        : undefined
      return typeof title === 'string' && title.length > 0 ? setSessionTitle(state, title) : state
    }
    default:
      return state
  }
}
