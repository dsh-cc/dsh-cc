/**
 * Per-step input ledger — the single schema source plus the pure sink and
 * reader core, the three row-emitting observers, and the reference-counted
 * mount for the context-engineering input-governance program.
 *
 * Every row is a content-free composition record: counts, UTF-8 byte sizes,
 * short local fingerprints, section names and source-kind strings. No prompt
 * or message text, no tool arguments, no file paths inside content. The
 * guarantee is structural — the row types carry no text field — and pinned by
 * a fixture over credential-shaped input (see `tests/privacy.spec.ts`).
 *
 * The sink and readers require no cordis context: docs 5/8 consume them
 * offline. The observers (`system-prompt/assemble`, `llm/stream`,
 * `agent/pre-step`) are registered by {@linkcode mountInputLedger}, which the
 * preset row calls.
 *
 * @module @dsh-cc/input-ledger
 */

export * from './mount.ts'
export * from './observe.ts'
export * from './readers.ts'
export * from './rows.ts'
export * from './settings.ts'
export * from './sink.ts'
