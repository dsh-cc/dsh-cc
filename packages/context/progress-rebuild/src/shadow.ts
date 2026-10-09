/**
 * Per-session shadow state and the pure event reducer (design §3.2 + pins
 * 1-4). Process-lifetime only: no session readers, no backfill.
 *
 * @module @dsh-cc/progress-rebuild/shadow
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseExitMarker, proofClass, receiptLabel } from './receipts.ts'

/** One todo entry, verbatim shape of the `todo/write` snapshot. */
export interface ShadowTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One verified execution receipt (newest kept in a ring capped at 20). */
export interface VerifiedReceipt {
  /** Event timestamp (unix epoch ms). */
  ts: number
  /** Short human label derived from the proof class. */
  label: string
  /** The bash command that produced the receipt. */
  command: string
}

/** Shadow snapshot of the current goal. */
export interface ShadowGoal {
  objective: string
  phase: string
  /** `false` for paused/blocked goals. */
  active: boolean
}

/** The per-session shadow state. */
export interface ShadowState {
  goal?: ShadowGoal
  todos: ShadowTodo[]
  /** Newest last; ring-capped at {@link VERIFIED_CAP}. */
  verified: VerifiedReceipt[]
  /** Pending bash command heads by callId (tool/call → tool/result pairing). */
  pendingBash: Map<string, string>
  lastUserTs?: number
  /** First 200 chars of the last REAL user message. */
  lastUserText?: string
}

/** Ring cap on kept receipts. */
export const VERIFIED_CAP = 20

/** Text bound for `lastUserText`. */
export const LAST_USER_MAX_CHARS = 200

/** An empty shadow (fresh process, no events seen). */
export function createShadow(): ShadowState {
  return { todos: [], verified: [], pendingBash: new Map() }
}

/** Clone the cheap parts of a shadow for the reducer's copy-on-write path. */
function clone(shadow: ShadowState): ShadowState {
  return {
    ...shadow,
    todos: shadow.todos.slice(),
    verified: shadow.verified.slice(),
    pendingBash: new Map(shadow.pendingBash),
  }
}

/** Join the text blocks of a message content array. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Apply one session event to a shadow, returning the next state. Pure: the
 * input shadow is never mutated. Unknown event types are ignored; the
 * allowlist (design §3.2, pin 4) means only `source.kind === 'user'`
 * `user/message` events touch `lastUser*` — every injected kind is inert by
 * construction.
 */
export function applyEvent(shadow: ShadowState, event: SessionEvent): ShadowState {
  const next = clone(shadow)
  switch (event.type as string) {
    case 'goal/change': {
      // Pin 3: discriminate on `operation` BEFORE touching `.goal` — the
      // `clear` tombstone carries NO `goal` member.
      const data = event.data as {
        operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'
        goal?: { objective: string; phase: string }
      }
      switch (data.operation) {
        case 'create':
        case 'edit':
        case 'resume':
          if (data.goal) next.goal = { objective: data.goal.objective, phase: data.goal.phase, active: true }
          break
        case 'pause':
          if (next.goal) next.goal = { ...next.goal, active: false }
          break
        case 'block':
          if (next.goal) next.goal = { objective: next.goal.objective, phase: 'blocked', active: false }
          break
        case 'complete':
        case 'clear':
          delete next.goal
          break
      }
      return next
    }
    case 'todo/write': {
      // Whole-list snapshot: later writes REPLACE, never patch.
      const data = event.data as { todos?: ShadowTodo[] }
      next.todos = Array.isArray(data.todos) ? data.todos.slice() : []
      return next
    }
    case 'tool/call': {
      // Pin 2: `arguments` is a raw JSON string; only bash calls are tracked.
      const data = event.data as { callId: string; name: string; arguments: string }
      if (data.name === 'bash') {
        try {
          const command = (JSON.parse(data.arguments) as { command?: unknown }).command
          if (typeof command === 'string') next.pendingBash.set(String(data.callId), command)
        } catch {
          // Malformed arguments: not a receipt, ignore.
        }
      }
      return next
    }
    case 'tool/result': {
      const data = event.data as {
        message: { source: { callId: string }; isError?: boolean; content: readonly { type: string; text?: string }[] }
      }
      const command = next.pendingBash.get(String(data.message.source.callId))
      next.pendingBash.delete(String(data.message.source.callId))
      if (command === undefined) return next
      // Fail-closed: infrastructure failures and any result without a parsed
      // exit-code 0 marker are NOT verified (pin 1).
      if (data.message.isError === true) return next
      if (parseExitMarker(textOf(data.message.content)) !== 0) return next
      if (proofClass(command) === undefined) return next
      next.verified = [...next.verified, { ts: event.time, label: receiptLabel(command), command }].slice(-VERIFIED_CAP)
      return next
    }
    case 'completion-gate/receipt': {
      // Tolerant-absent preferred source (D1): shape not yet fixed in-repo;
      // accept any event with a truthy label-ish field.
      const data = event.data as { label?: unknown; summary?: unknown; ok?: unknown }
      const label = typeof data.label === 'string' ? data.label : typeof data.summary === 'string' ? data.summary : undefined
      if (label === undefined) return next
      if (data.ok === false) return next
      next.verified = [...next.verified, { ts: event.time, label, command: '' }].slice(-VERIFIED_CAP)
      return next
    }
    case 'user/message': {
      // Pin 4: ALLOWLIST — only real user prompts (kind 'user') update
      // lastUser; every injected kind (compact-checkpoint, compaction-micro,
      // compaction-cost-gate, cc-shell-glue, memory, advisor, turn-rules,
      // plugin, progress-rebuild itself, …) is ignored by construction.
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind !== 'user') return next
      const text = textOf((event.data as { content: readonly { type: string; text?: string }[] }).content)
      next.lastUserTs = event.time
      next.lastUserText = text.slice(0, LAST_USER_MAX_CHARS)
      return next
    }
    default:
      return next
  }
}

/** Render the `[x]` / `[ ]` status prefix for a todo line. */
export function todoMark(todo: ShadowTodo): string {
  return todo.status === 'completed' ? '[x]' : '[ ]'
}
