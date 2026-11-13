/**
 * Per-step input budget governor — the class map, the pure governor core and
 * the settings surface for the context-engineering input-governance program
 * (plan doc `docs/plans/2026-11-12-per-step-input-budget-governor.md`).
 *
 * One gate over the final per-step enter batch, arbitrating producer content by
 * class: `governance`/`task`/`passthrough` are never trimmed and never
 * deferred, `memory` and `advisory` are trimmed FIFO against their own byte
 * budgets, and trimmed messages wait in a deterministic defer backlog aged by a
 * monotonic per-session gate invocation counter. Ships observe-first: in
 * observe mode the batch is returned untouched and only the decisions are
 * recorded, on the same row fields enforce mode uses.
 *
 * The core is a pure function of its arguments (`govern`), so it is testable
 * without cordis. The `agent/pre-step` listener, the preset row and the ledger
 * emission live in the later wiring slices; this package supplies no plugin
 * entry yet.
 *
 * @module @dsh-cc/input-budget
 */

export * from './classes.ts'
export * from './core.ts'
export * from './settings.ts'
