// Conformance fixture for the context-engineering input-governance arithmetic.
//
// This is a model-local reference implementation, NOT production code: the
// `@dsh-cc/input-budget` package does not exist yet. When the feature lands, the
// adapter must be re-pointed at its real trim/dedupe projections and this
// fixture removed.
//
// Semantics mirror Model.lean exactly: only memory/advisory are budgeted, a
// message is admitted iff it fits the remaining budget, an oversize message can
// never fit, and the dedupe window uses the strict `gap < window` comparison.

export type MessageClass = 'governance' | 'task' | 'memory' | 'advisory' | 'passthrough'

const BUDGETED: ReadonlySet<MessageClass> = new Set<MessageClass>(['memory', 'advisory'])

export function budgeted(cls: MessageClass): boolean {
  return BUDGETED.has(cls)
}

export function charged(cls: MessageClass, bytes: number): number {
  return budgeted(cls) ? bytes : 0
}

export function available(budget: number, used: number): number {
  return budget - used
}

export function fits(budget: number, used: number, bytes: number): boolean {
  return bytes <= available(budget, used)
}

export function oversize(budget: number, bytes: number): boolean {
  return budget < bytes
}

export function withinWindow(now: number, lastAdmitted: number, window: number): boolean {
  return now - lastAdmitted < window
}
