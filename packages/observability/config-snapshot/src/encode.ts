/**
 * Path-segment escaping for session ids.
 *
 * Copied verbatim from the pinned harness package
 * `@deepseek-ai/dsh-session-persistence-jsonl` (`session-persistence-jsonl/src/format.ts:188-214`)
 * per the design doc §3.3: the source is not exported at that package's root,
 * and a `src/` deep import trips the repo's `check:deep-imports` gate —
 * deliberate duplication, never a cross-package import.
 *
 * @see docs/plans/2026-10-09-session-config-snapshot-event.md §3.3
 * @module @dsh-cc/config-snapshot/encode
 */

/**
 * Encode an arbitrary string as a single safe path segment, injectively over ALL JS (UTF-16)
 * strings — including lone surrogates. A {@link SessionId} is an unvalidated branded string,
 * so this neutralizes `../`, absolute paths, NUL, and separators before any filesystem use.
 * Safe code units remain literal; every other unit, including `~`, becomes
 * `~XXXX`. Operating on code units preserves lone surrogates, while special-
 * casing `.` and `..` prevents traversal by an otherwise safe whole segment.
 *
 * @param raw - the string to encode; must be non-empty (throws on `''`).
 * @returns the escaped single path segment, decodable back to `raw`.
 */
export { encodeSegment } from '@dsh-cc/sidecar-io'
