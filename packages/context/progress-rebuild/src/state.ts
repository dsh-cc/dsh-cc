/**
 * M1 progress-state projection (design
 * docs/plans/2026-10-09-structured-progress-and-post-compact-rebuild.md §3.2):
 * one registered Session projection unit whose `apply` fold consumes EVERY
 * committed session event, self-filtering per arm (goal / todos / verified /
 * lastUser). Registered under the host-only key `progress-rebuild` (§3.1).
 *
 * The fold NEVER THROWS — the projection registry's `drive` has no try/catch
 * (upstream session-projection/src/index.ts:681-684), so every parse is caught
 * and every arm is individually contained: a throw inside an arm leaves that
 * arm unchanged. State is plain JSON (arrays, no Map/Set) so the persisted
 * projection cache can restore it.
 *
 * @module
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { applyGoalProjection, type GoalProjectionState } from '@deepseek-ai/dsh-goal'

/** One verified bash receipt: command head + execution evidence (exit 0). */
export interface VerifiedReceipt {
  /** Unix epoch ms of the `tool/result` event. */
  ts: number
  /** `tool/call`/`tool/result` pairing id. */
  callId: string
  /** First 200 chars of the bash command. */
  commandHead: string
}

/** One recorded `tool/call`, doubling as the receipt dedupe set. */
export interface RecordedCall {
  callId: string
  name: string
  commandHead: string
  /** Whether the command passed the conservative eligibility scan. */
  eligible: boolean
}

/** Last genuine user message reference. */
export interface LastUserMessage {
  ts: number
  /** Session log seq of the `user/message` event (as decimal string — plain JSON). */
  seq: string
  /** First 200 chars of the first non-empty text block. */
  text: string
}

/** The whole `progress-rebuild` projection state (plain JSON). */
export interface ProgressRebuildState {
  /** Harness canonical goal fold (§3.2 goal row). */
  goal: GoalProjectionState
  /** Latest `todo/write` snapshot verbatim; null before the first write. */
  todos: { content: string; status: string }[] | null
  /** Verified bash receipts, newest LAST, ring-capped at 20. */
  verified: VerifiedReceipt[]
  /** Recent `tool/call` records, oldest first, LRU-capped at 512; FIRST occurrence kept per callId. */
  callIndex: RecordedCall[]
  /** Last genuine user message, or null. */
  lastUser: LastUserMessage | null
}

/** Verified-receipt ring capacity. */
export const VERIFIED_RING_CAP = 20
/** Recent-calls index capacity (also the receipt dedupe set). */
export const CALL_INDEX_CAP = 512

/**
 * Fixed exit/interrupt marker vocabulary rendered by the bash tool
 * (upstream tool-bash/src/render.ts): marker ABSENCE in the result tail is
 * the success signal. Note the exit marker appears only for NON-ZERO exits,
 * so a clean exit-0 result carries no marker at all.
 */
export const FAILURE_MARKERS = [
  '[exit code: ',
  '[killed by signal: ',
  '[timed out after ',
  '[stopped: ',
  '[still running after ',
  '[sandbox: file access denied under ',
  '[sandbox: the sandbox runner itself failed under ',
] as const

/** Number of trailing lines of the rendered result scanned for markers. */
const TAIL_LINES = 10

/** commandHead bound (§3.2). */
const COMMAND_HEAD_CHARS = 200

/**
 * Conservative command eligibility scan (§3.2 verified row): reject compound
 * commands and substitution so a receipt can only attest one simple command.
 * Any `;`, `||`, `&&`, `|`, newline, `$(…)`, backtick, or `&` (mid-command or
 * trailing — `&&` is already covered) rejects, as does `run_in_background: true`.
 * Quoted separators false-reject — accepted, conservatism is deliberate.
 */
function commandIsEligible(command: string): boolean {
  return !/;|\|\||&&|\||\n|\$\(|`|&/.test(command)
}

/** Result text tail: last TAIL_LINES lines across all text blocks. */
function resultTailLines(message: { readonly content: readonly unknown[] }): string[] {
  const lines: string[] = []
  for (const block of message.content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') lines.push(...text.split('\n'))
    }
  }
  return lines.slice(-TAIL_LINES)
}

/** True when the tail carries a marker line (→ NOT a receipt). */
function tailHasMarker(message: { readonly content: readonly unknown[] }): boolean {
  return resultTailLines(message).some((line) =>
    FAILURE_MARKERS.some((marker) => line.includes(marker)),
  )
}

/**
 * Read a `tool/call` event through the recorded-call face (defensive — the
 * declared payload is trusted to a point, never to a throw).
 */
function asCallRecord(callId: string, event: SessionEvent): RecordedCall | undefined {
  const data = event.data as { name?: unknown; arguments?: unknown }
  if (typeof data.name !== 'string' || typeof data.arguments !== 'string') {
    return { callId, name: '', commandHead: '', eligible: false }
  }
  let parsed: { command?: unknown; run_in_background?: unknown } | undefined
  try {
    parsed = JSON.parse(data.arguments) as { command?: unknown; run_in_background?: unknown }
  } catch {
    return { callId, name: data.name, commandHead: '', eligible: false } // unparseable → not eligible, no throw
  }
  if (typeof parsed.command !== 'string') {
    return { callId, name: data.name, commandHead: '', eligible: false }
  }
  const eligible = parsed.run_in_background !== true && commandIsEligible(parsed.command)
  return { callId, name: data.name, commandHead: parsed.command.slice(0, COMMAND_HEAD_CHARS), eligible }
}

/**
 * Read a `tool/result` event's message through the defensive face (keyed by
 * `message.source.callId`, isError flag, rendered text blocks).
 */
function asResultFace(event: SessionEvent):
  | { callId: string; isError: boolean; content: readonly unknown[] }
  | undefined {
  const message = (event.data as { message?: unknown }).message as
    | { isError?: unknown; content?: unknown; source?: { callId?: unknown } }
    | undefined
  const callId = message?.source?.callId
  if (typeof callId !== 'string' || !Array.isArray(message?.content)) return undefined
  return { callId, isError: message?.isError === true, content: message?.content ?? [] }
}

/** Run one arm; on any throw leave that arm unchanged (round-9 no-throw rule). */
function safely<T>(arm: T, transition: () => T): T {
  try {
    return transition()
  } catch {
    return arm
  }
}

/**
 * The fold: previous state + one committed event → next state. Returns the
 * SAME reference when the event touches nothing (the registry's zero-work
 * contract). Consumes every session event; each arm self-filters.
 */
export function applyProgressRebuild(state: ProgressRebuildState, event: SessionEvent): ProgressRebuildState {
  let next = state

  // Goal arm: the harness's canonical throw-free fold, fed EVERY event (it
  // self-filters goal/change and goal-sourced user/message round events).
  next = safely(next, () => {
    const goal = applyGoalProjection(next.goal, event)
    return goal === next.goal ? next : { ...next, goal }
  })

  // Todos arm: latest whole `todo/write` snapshot verbatim.
  next = safely(next, () => {
    // `todo/write` is declared in the SessionEventMap by @dsh-cc/tool-todo's
    // augmentation, which this package does not import — compare loosely.
    if (String(event.type) !== 'todo/write') return next
    const todos = (event.data as { todos?: unknown }).todos
    if (!Array.isArray(todos)) return next
    return { ...next, todos: todos as { content: string; status: string }[] }
  })

  // Verified arm: `tool/call` records eligibility; `tool/result` becomes a
  // receipt iff the recorded call was an eligible bash command, the result is
  // not isError, and the result tail carries no failure marker. Reads
  // `tool/result` ONLY (the future `completion-gate/receipt` source is a D1
  // forward hook — deliberately not implemented, structured to slot in here).
  next = safely(next, () => {
    if (event.type === 'tool/call') {
      const data = event.data as { callId?: unknown }
      if (typeof data.callId !== 'string') return next
      const existing = next.callIndex.find((call) => call.callId === data.callId)
      if (existing !== undefined) return next // FIRST occurrence kept (dedupe set)
      const record = asCallRecord(data.callId, event)
      const callIndex = next.callIndex.length >= CALL_INDEX_CAP
        ? [...next.callIndex.slice(1), record!]
        : [...next.callIndex, record!]
      return { ...next, callIndex }
    }
    if (event.type !== 'tool/result') return next
    const result = asResultFace(event)
    if (result === undefined) return next
    const call = next.callIndex.find((entry) => entry.callId === result.callId)
    if (call === undefined || call.name !== 'bash' || !call.eligible) return next
    if (result.isError) return next
    if (tailHasMarker(result)) return next
    if (next.verified.some((receipt) => receipt.callId === result.callId)) return next
    const receipt: VerifiedReceipt = { ts: event.time, callId: result.callId, commandHead: call.commandHead }
    const verified = next.verified.length >= VERIFIED_RING_CAP
      ? [...next.verified.slice(1), receipt]
      : [...next.verified, receipt]
    return { ...next, verified }
  })

  // lastUser arm: genuine user messages only — `source` undefined OR
  // `kind === 'user'`, with at least one non-empty text block. By
  // construction this excludes compact-checkpoint and every injected kind.
  next = safely(next, () => {
    if (event.type !== 'user/message') return next
    const message = event.data as {
      content?: unknown
      source?: { kind?: unknown }
    }
    const kind = message.source?.kind
    if (kind !== undefined && kind !== 'user') return next
    const firstText = (Array.isArray(message.content) ? message.content : []).find(
      (block): block is { text: string } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
        && ((block as { text?: unknown }).text as string).length > 0,
    )
    if (firstText === undefined) return next
    return {
      ...next,
      lastUser: {
        ts: event.time,
        seq: String(event.seq),
        text: firstText.text.slice(0, COMMAND_HEAD_CHARS),
      },
    }
  })

  return next
}

const receiptSchema = z.object({ ts: z.number(), callId: z.string(), commandHead: z.string() })
const callRecordSchema = z.object({
  callId: z.string(),
  name: z.string(),
  commandHead: z.string(),
  eligible: z.boolean(),
})

/** Validates persisted state before it seeds a fold (plain-JSON shape). */
export const progressRebuildStateSchema: ZodType<ProgressRebuildState> = z.object({
  goal: z.object({
    current: z.unknown(),
    seenGoalIds: z.array(z.unknown()),
    failure: z.union([z.string(), z.null()]),
  }),
  todos: z.array(z.object({ content: z.string(), status: z.string() })).nullable(),
  verified: z.array(receiptSchema).max(VERIFIED_RING_CAP),
  callIndex: z.array(callRecordSchema).max(CALL_INDEX_CAP),
  lastUser: z.object({ ts: z.number(), seq: z.string(), text: z.string() }).nullable(),
}) as unknown as ZodType<ProgressRebuildState>

/**
 * The registered projection unit (§3.1): host-only key `progress-rebuild`,
 * no wire face, stateVersion 1.
 */
export const progressRebuildProjection: ProjectionDefinition<
  'progress-rebuild',
  ProgressRebuildState
> = {
  key: 'progress-rebuild',
  stateSchema: progressRebuildStateSchema,
  init: (_header: SessionHeader, _inheritedEventCount: SessionLogOffset): ProgressRebuildState => ({
    goal: { current: null, seenGoalIds: [], failure: null },
    todos: null,
    verified: [],
    callIndex: [],
    lastUser: null,
  }),
  apply: applyProgressRebuild,
  stateVersion: 1,
}
