/**
 * Path-segment escaping for session ids.
 *
 * Copied verbatim from `packages/observability/config-snapshot/src/encode.ts`
 * (itself copied from the pinned harness package
 * `@deepseek-ai/dsh-session-persistence-jsonl`, format.ts:188-214) per the
 * design doc §4.1: the source is not exported at that package's root and a
 * `src/` deep import trips the repo's `check:deep-src-imports` gate —
 * deliberate duplication, never a cross-package import.
 *
 * @module @dsh-cc/vwa-evidence/encode
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
