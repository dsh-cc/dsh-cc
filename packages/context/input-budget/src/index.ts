/**
 * Per-step input budget governor — the class map, the pure governor core, the
 * pipeline seam, the settings surface and the `agent/pre-step` listener for the
 * context-engineering input-governance program (plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md`).
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
 * without cordis; {@linkcode apply} mounts the listener a preset row runs, and
 * {@linkcode buildGovernorRow} is the seam the ledger emission plugs into.
 *
 * @module @dsh-cc/input-budget
 */

export * from './classes.ts'
export * from './core.ts'
export * from './listener.ts'
export * from './pipeline.ts'
export { apply, name } from './plugin.ts'
export * from './row.ts'
export * from './settings.ts'
