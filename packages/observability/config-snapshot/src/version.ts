/**
 * Own-version reader for the config-snapshot sidecar.
 *
 * The implementation now lives in `@dsh-cc/version-info` (one owner, one
 * `FALLBACK_VERSION` for `scripts/release.mjs` to rewrite) — the earlier
 * per-package copy is retired. This module re-exports it so the capture code
 * and its fixtures keep their import path.
 *
 * @module @dsh-cc/config-snapshot/version
 */

export { FALLBACK_VERSION, readOwnVersion } from '@dsh-cc/version-info'
