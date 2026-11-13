/**
 * The explicit class map of the per-step input budget governor — plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"Classes (explicit
 * membership only)".
 *
 * Membership is explicit and closed. A kind that is not listed below is
 * `passthrough`, which is never trimmed and never deferred. That inversion is
 * the safety story of the whole gate: an unenumerated producer — a late
 * plugin, a future package, a harness-only kind — keeps flowing untouched
 * instead of being silently classed as deferrable. The r1 blind-review fold
 * turned the original "unknown → advisory" inversion around for exactly this
 * reason: it would have trimmed `agent-instructions` workspace rules and hook
 * `additionalContext` as they currently flow.
 *
 * `cc-shell-glue` sits in `passthrough` in v1 as an **algorithmic rule**, not
 * an annotation: `mcpReadyNotice` commits its once-per-session latch BEFORE
 * returning the notice, so an enforced trim, defer or oversize drop of a glue
 * notice would be a silent one-shot miss.
 *
 * @module @dsh-cc/input-budget/classes
 */

/** The five classes of the per-step input gate. */
export type InputClass = 'governance' | 'task' | 'memory' | 'advisory' | 'passthrough'

/** Every class, in the design table's order (also the row key order). */
export const INPUT_CLASSES: readonly InputClass[] = Object.freeze([
  'governance',
  'task',
  'memory',
  'advisory',
  'passthrough',
] as const)

/** The classes carrying a byte budget; every other class is counted only. */
export const BUDGETED_CLASSES: readonly InputClass[] = Object.freeze(['memory', 'advisory'] as const)

/** Never trimmed, never deferred: policy and instruction content the model must see. */
export const GOVERNANCE_KINDS: readonly string[] = Object.freeze([
  'turn-rules',
  'edit-recovery-hint',
  'completion-gate',
  'permission-rules',
  'agent-instructions',
  'hooks-claude-code',
  'compact-checkpoint',
  'moa-escalation',
] as const)

/**
 * Never trimmed, never deferred: user turns, lifecycle wakes and delivery
 * wakes. Losing one of these loses work product or a settlement.
 */
export const TASK_KINDS: readonly string[] = Object.freeze([
  'user',
  'progress-rebuild',
  'moa',
  'subagent-settled',
  'cc-subagent-children',
  'vwa-evidence',
  'cc-workflow-completion',
] as const)

/** Trimmed/deferred FIFO under its own `memory-budget-bytes` (recall bodies). */
export const MEMORY_KINDS: readonly string[] = Object.freeze(['memory'] as const)

/** Trimmed/deferred FIFO under `advisory-budget-bytes`. */
export const ADVISORY_KINDS: readonly string[] = Object.freeze([
  'advisor',
  'retry-attendant',
  'compaction-micro',
  'compaction-cost-gate',
] as const)

/**
 * Never trimmed, never deferred. `cc-shell-glue` first (the v1 hard rule),
 * then named host kinds, then every unknown kind by construction.
 */
export const PASSTHROUGH_KINDS: readonly string[] = Object.freeze([
  'cc-shell-glue',
  'command-preset',
  'side-query',
  'tool-web-fetch',
  'tool-registry',
  'developer',
  'plan-mode',
  'runtime-context',
  'skill-invocation',
  'subagent-instructions',
  'system-prompt',
] as const)

/** Merge the per-class kind lists into one lookup table. */
function buildTable(
  lists: Readonly<Record<InputClass, readonly string[]>>,
): Readonly<Record<string, InputClass>> {
  const table: Record<string, InputClass> = {}
  for (const cls of INPUT_CLASSES) {
    for (const kind of lists[cls]) table[kind] = cls
  }
  return Object.freeze(table)
}

/** One lookup table keyed by the exact `source.kind` string. */
export const KIND_CLASSES: Readonly<Record<string, InputClass>> = buildTable({
  governance: GOVERNANCE_KINDS,
  task: TASK_KINDS,
  memory: MEMORY_KINDS,
  advisory: ADVISORY_KINDS,
  passthrough: PASSTHROUGH_KINDS,
})

/**
 * Class of one source-kind string. Anything not explicitly listed — including
 * an absent or empty kind — is `passthrough`, so unknown producers are never
 * trimmed and never deferred.
 *
 * @param kind - the message's `source.kind`, or undefined when unlabelled.
 */
export function classifyKind(kind: string | undefined): InputClass {
  if (typeof kind !== 'string' || kind.length === 0) return 'passthrough'
  return KIND_CLASSES[kind] ?? 'passthrough'
}

/** Whether a class carries a byte budget (only `memory` and `advisory` do). */
export function isBudgeted(cls: InputClass): boolean {
  return cls === 'memory' || cls === 'advisory'
}
