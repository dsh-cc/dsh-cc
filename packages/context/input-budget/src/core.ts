/**
 * The pure core of the per-step input budget governor — plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"Budget model",
 * §"Defer queue" and §"Observe mode".
 *
 * Everything here is a function of its arguments: messages + settings + defer
 * queue + the `gateSeq` clock in, a decision batch + row fields + the new queue
 * + the next `gateSeq` out. There is no cordis context, no module state and no
 * clock read, so the whole algorithm is unit-testable without a runtime. The
 * `agent/pre-step` listener that owns the per-session `gateSeq` and the queue
 * lives in the slice-5 wiring, not here; the `enabled` setting is that
 * listener's short-circuit, not a knob of this core.
 *
 * Budget arithmetic mirrors the Lean model
 * `specs/lean/input-admission-arithmetic/Model.lean` exactly:
 * `available(budget, used) = budget - used` (saturating), `fits` admits when
 * `bytes <= available`, `oversize` when `budget < bytes`. Protected classes are
 * never charged and never trimmed — the arithmetic face of "never touched".
 *
 * @module @dsh-cc/input-budget/core
 */

import { clampLabel } from '@dsh-cc/input-ledger'
import type { GovernorTrim, TrimAction } from '@dsh-cc/input-ledger'
import { BUDGETED_CLASSES, INPUT_CLASSES, classifyKind, type InputClass } from './classes.ts'

/** The governor knobs this core reads, as resolved by the settings surface. */
export interface GovernorSettings {
  /** `'observe'` records decisions only; `'enforce'` acts on them. */
  mode: 'observe' | 'enforce'
  'enter-budget-bytes': number
  'advisory-budget-bytes': number
  'memory-budget-bytes': number
  'defer-ttl-steps': number
}

/** Structural face of one content block (only `type: 'text'` blocks carry bytes). */
export interface GovernedContentBlock {
  readonly type?: string
  readonly text?: string
}

/**
 * Structural face of one enter-batch message. Deliberately minimal: the
 * governor reads a source kind and text-block bytes, nothing else, so a
 * harness `UserMessage` satisfies it without importing harness types.
 */
export interface GovernedMessage {
  readonly role?: string
  readonly content?: unknown
  readonly source?: { readonly kind?: string }
}

/** One trimmed message waiting in the defer backlog, stamped with `gateSeq`s. */
export interface DeferredEntry<T extends GovernedMessage = GovernedMessage> {
  readonly message: T
  /** The `gateSeq` of the invocation that trimmed (enqueued) this entry. */
  readonly enqueuedAtSeq: number
  /** The `gateSeq` of the last invocation that evaluated this entry. */
  readonly lastOfferedSeq: number
}

/** The batch-level inputs of one gate invocation. */
export interface GovernInput<T extends GovernedMessage = GovernedMessage> {
  /** The claimed enter batch for this step, in arrival order. */
  messages: readonly T[]
  /** Resolved governor settings (hot-read by the listener). */
  settings: GovernorSettings
  /** This session's defer backlog; absent on a fresh session or in observe mode. */
  backlog?: readonly DeferredEntry<T>[]
  /** The last `gateSeq` this session consumed; absent/0 before the first gate call. */
  gateSeq?: number
}

/** The `GovernorRow` fields this package owns (doc 3 owns the row schema). */
export interface GovernorDecision {
  mode: 'observe' | 'enforce'
  /** UTF-8 bytes per class of the decision batch (all five keys, always). */
  bytesByClass: Record<string, number>
  /** Trim decisions in the order the algorithm took them. */
  trimmed: GovernorTrim[]
  /** Backlog entries offered to admission this invocation (0 in observe mode). */
  offeredBacklog: number
  /** The enter budget could not be met within trimmable classes. */
  hardOver: boolean
}

/** One gate invocation's outcome. */
export interface GovernResult<T extends GovernedMessage = GovernedMessage> {
  /** The decision batch: admitted backlog entries, then surviving fresh messages. */
  messages: T[]
  decision: GovernorDecision
  /** The defer backlog this invocation leaves behind (empty in observe mode). */
  backlog: DeferredEntry<T>[]
  /** The next `gateSeq` to hand to the following invocation. */
  gateSeq: number
}

/** A fresh message plus its class, size and disposition. */
interface FreshEntry<T extends GovernedMessage> {
  readonly message: T
  readonly class: InputClass
  readonly bytes: number
  disposition: 'admit' | 'defer' | 'drop-oversize'
}

/** Outcome of the backlog walk: what was admitted, what stays queued. */
interface BacklogAdmission<T extends GovernedMessage> {
  admitted: FreshEntry<T>[]
  queued: DeferredEntry<T>[]
  used: Map<InputClass, number>
}

/**
 * The class budget a message of `cls` is judged against, or undefined when the
 * class is never trimmed. Memory and advisory each carry their own budget: a
 * 12 KiB memory entry is judged against `memory-budget-bytes`, never against
 * the advisory limit.
 */
export function classBudgetOf(cls: InputClass, settings: GovernorSettings): number | undefined {
  if (cls === 'memory') return settings['memory-budget-bytes']
  if (cls === 'advisory') return settings['advisory-budget-bytes']
  return undefined
}

/** Remaining room in one class budget (saturating, matching Lean's `Nat` subtraction). */
export function available(budget: number, used: number): number {
  return Math.max(0, budget - used)
}

/** Lean `Formal.fits`: the message fits when it is within the room left after `used`. */
export function fits(budget: number, used: number, bytes: number): boolean {
  return bytes <= available(budget, used)
}

/** Lean `Formal.oversize`: a message bigger than its whole class budget never fits. */
export function oversize(budget: number, bytes: number): boolean {
  return budget < bytes
}

/**
 * UTF-8 byte size of one message: text blocks only, the same measurement the
 * input ledger records, so a governor row and a ledger row agree byte for byte.
 * Non-text blocks and a non-array `content` contribute nothing.
 */
export function messageBytes(message: GovernedMessage | undefined): number {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let bytes = 0
  for (const block of content as readonly GovernedContentBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      bytes += Buffer.byteLength(block.text, 'utf8')
    }
  }
  return bytes
}

/** Source kind of one message; empty when the producer declared none. */
export function sourceKindOf(message: GovernedMessage | undefined): string {
  const kind = message?.source?.kind
  return typeof kind === 'string' ? kind : ''
}

/** Classify one message: class plus its byte size. */
function classify<T extends GovernedMessage>(message: T): FreshEntry<T> {
  return {
    message,
    class: classifyKind(sourceKindOf(message)),
    bytes: messageBytes(message),
    disposition: 'admit',
  }
}

/** One `GovernorRow.trimmed` element; kind strings are label-capped like the ledger's. */
function trimRow(message: GovernedMessage, bytes: number, action: TrimAction): GovernorTrim {
  const kind = sourceKindOf(message)
  return { kind: clampLabel(kind.length > 0 ? kind : 'unlabelled'), bytes, action }
}

/** Normalize the clock: an absent or malformed `gateSeq` restarts at 0. */
function seqOf(gateSeq: number | undefined): number {
  return typeof gateSeq === 'number' && Number.isFinite(gateSeq) ? Math.max(0, Math.trunc(gateSeq)) : 0
}

/** Add `bytes` to one class's running total. */
function bump(usage: Map<InputClass, number>, cls: InputClass, bytes: number): void {
  usage.set(cls, (usage.get(cls) ?? 0) + bytes)
}

/**
 * Step 1 of the defer algorithm: age the backlog. An entry older than
 * `defer-ttl-steps` gate invocations (strictly greater, so a TTL of 3 keeps an
 * entry across invocations `seq`, `seq+1`, `seq+2`) is dropped `drop-expired`.
 */
function ageBacklog<T extends GovernedMessage>(
  queue: readonly DeferredEntry<T>[],
  seq: number,
  ttl: number,
  rows: GovernorTrim[],
): DeferredEntry<T>[] {
  const kept: DeferredEntry<T>[] = []
  for (const entry of queue) {
    if (seq - entry.enqueuedAtSeq > ttl) {
      rows.push(trimRow(entry.message, messageBytes(entry.message), 'drop-expired'))
      continue
    }
    kept.push(entry)
  }
  return kept
}

/**
 * Step 2 of the defer algorithm: admit the backlog FIFO while the HEAD's own
 * class budget has room. Each entry is judged against its own class budget
 * (memory against `memory-budget-bytes`, advisory against
 * `advisory-budget-bytes`), with this invocation's admitted bytes as `used`.
 *
 * An entry whose bytes alone exceed its class budget can never fit — possible
 * only when the hot-read budgets shrank after enqueue — so it is dropped
 * `drop-oversize` instead of blocking the queue forever. Every surviving entry
 * is offered to this invocation, so its `lastOfferedSeq` advances to `seq`.
 */
function admitBacklog<T extends GovernedMessage>(
  queue: readonly DeferredEntry<T>[],
  seq: number,
  settings: GovernorSettings,
  rows: GovernorTrim[],
): BacklogAdmission<T> {
  const admitted: FreshEntry<T>[] = []
  const used = new Map<InputClass, number>()
  let index = 0
  for (; index < queue.length; index += 1) {
    const entry = queue[index]
    if (entry === undefined) break
    const item = classify(entry.message)
    const budget = classBudgetOf(item.class, settings)
    if (budget === undefined) {
      // Defensive: only budgeted classes are ever enqueued. Protected content is
      // admitted rather than dropped, because losing it is the worse failure.
      admitted.push(item)
      continue
    }
    if (oversize(budget, item.bytes)) {
      rows.push(trimRow(item.message, item.bytes, 'drop-oversize'))
      continue
    }
    if (!fits(budget, used.get(item.class) ?? 0, item.bytes)) break
    admitted.push(item)
    bump(used, item.class, item.bytes)
  }
  const queued = queue
    .slice(index)
    .map((entry) => ({ message: entry.message, enqueuedAtSeq: entry.enqueuedAtSeq, lastOfferedSeq: seq }))
  return { admitted, queued, used }
}

/**
 * Record one fresh trim: the row it emits and the disposition it takes.
 * A message whose bytes alone exceed its own class budget is dropped
 * `drop-oversize` and never enqueued — defer-then-drop would record a
 * deferral that could never succeed.
 */
function trimFresh<T extends GovernedMessage>(
  item: FreshEntry<T>,
  budget: number,
  rows: GovernorTrim[],
): void {
  if (oversize(budget, item.bytes)) {
    item.disposition = 'drop-oversize'
    rows.push(trimRow(item.message, item.bytes, 'drop-oversize'))
    return
  }
  item.disposition = 'defer'
  rows.push(trimRow(item.message, item.bytes, 'defer'))
}

/**
 * Run one gate invocation.
 *
 * Order of operations (plan doc §"Defer queue"): age the backlog, admit the
 * backlog FIFO against per-class budgets, then classify and trim the fresh
 * batch — memory class first (its own budget), then advisory, then the enter
 * budget as a last resort that only ever trims advisory and then memory. If the
 * enter budget cannot be met within the trimmable classes, nothing further is
 * trimmed, protected classes are untouched, and `hardOver` records the
 * overflow.
 *
 * Observe mode runs the identical fresh-batch computation and records the same
 * rows, but keeps no defer queue, simulates no backlog, emits no
 * `drop-expired`, and returns the incoming batch untouched. Because its
 * returned backlog is empty, an observe→enforce flip starts with an empty
 * queue — the flip boundary of the plan doc, enforced by construction.
 */
export function govern<T extends GovernedMessage>(input: GovernInput<T>): GovernResult<T> {
  const seq = seqOf(input.gateSeq) + 1
  const settings = input.settings
  const enforce = settings.mode === 'enforce'
  const rows: GovernorTrim[] = []

  const offeredBacklog = enforce ? (input.backlog ?? []).length : 0
  const survivors = enforce
    ? ageBacklog(input.backlog ?? [], seq, settings['defer-ttl-steps'], rows)
    : []
  const admission = enforce
    ? admitBacklog(survivors, seq, settings, rows)
    : { admitted: [], queued: [], used: new Map<InputClass, number>() }

  const fresh = input.messages.map(classify)
  const usage = new Map<InputClass, number>(admission.used)
  let total = 0
  for (const item of admission.admitted) {
    total += item.bytes
  }
  for (const item of fresh) {
    bump(usage, item.class, item.bytes)
    total += item.bytes
  }

  // Budget model steps 3–4: per-class budgets, memory first then advisory,
  // trimming the oldest message of the class until the class is within budget.
  for (const cls of BUDGETED_CLASSES) {
    const budget = classBudgetOf(cls, settings)
    if (budget === undefined) continue
    for (const item of fresh) {
      if ((usage.get(cls) ?? 0) <= budget) break
      if (item.class !== cls || item.disposition !== 'admit') continue
      usage.set(cls, (usage.get(cls) ?? 0) - item.bytes)
      total -= item.bytes
      trimFresh(item, budget, rows)
    }
  }

  // Budget model step 5: the enter budget trims advisory, then memory, further.
  // Trimmable classes are exhausted first; when even an empty trimmable set
  // cannot reach the budget, nothing further is trimmed and the overflow is
  // recorded (`hardOver`) instead of silently dropping protected content.
  if (total > settings['enter-budget-bytes']) {
    const candidates: FreshEntry<T>[] = []
    for (const cls of ['advisory', 'memory'] as const) {
      for (const item of fresh) {
        if (item.class === cls && item.disposition === 'admit') candidates.push(item)
      }
    }
    let projected = total
    const removable: FreshEntry<T>[] = []
    for (const item of candidates) {
      if (projected <= settings['enter-budget-bytes']) break
      projected -= item.bytes
      removable.push(item)
    }
    if (projected <= settings['enter-budget-bytes']) {
      for (const item of removable) {
        total -= item.bytes
        trimFresh(item, classBudgetOf(item.class, settings) ?? item.bytes, rows)
      }
    }
  }

  const hardOver = total > settings['enter-budget-bytes']

  // Admitted backlog entries lead the batch (they are older), then the
  // surviving fresh messages in arrival order — no other reordering.
  const decisionMessages: T[] = []
  for (const item of admission.admitted) decisionMessages.push(item.message)
  for (const item of fresh) {
    if (item.disposition === 'admit') decisionMessages.push(item.message)
  }

  const bytesByClass: Record<string, number> = {}
  for (const cls of INPUT_CLASSES) bytesByClass[cls] = 0
  for (const message of decisionMessages) {
    const cls = classifyKind(sourceKindOf(message))
    bytesByClass[cls] = (bytesByClass[cls] ?? 0) + messageBytes(message)
  }

  const backlog: DeferredEntry<T>[] = []
  if (enforce) {
    for (const entry of admission.queued) backlog.push(entry)
    for (const item of fresh) {
      if (item.disposition !== 'defer') continue
      backlog.push({ message: item.message, enqueuedAtSeq: seq, lastOfferedSeq: seq })
    }
  }

  return {
    messages: enforce ? decisionMessages : [...input.messages],
    decision: {
      mode: settings.mode,
      bytesByClass,
      trimmed: rows,
      offeredBacklog,
      hardOver,
    },
    backlog,
    gateSeq: seq,
  }
}
