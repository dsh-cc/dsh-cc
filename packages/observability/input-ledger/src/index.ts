/**
 * Per-step input ledger — the single schema source plus the pure sink and
 * reader core for the context-engineering input-governance program.
 *
 * Every row is a content-free composition record: counts, UTF-8 byte sizes,
 * short local fingerprints, section names and source-kind strings. No prompt
 * or message text, no tool arguments, no file paths inside content. The
 * guarantee is structural — the row types carry no text field — and pinned by
 * a fixture over credential-shaped input (see `tests/privacy.spec.ts`).
 *
 * No cordis context is required: docs 5/8 consume these functions offline.
 * Row-emitting observers (`system-prompt/assemble`, `llm/stream`,
 * `agent/pre-step`) are wired by the preset, not by this core.
 *
 * @module @dsh-cc/input-ledger
 */

export * from './readers.ts'
export * from './rows.ts'
export * from './sink.ts'
