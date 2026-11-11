/**
 * Own-version reader for the ACP session surface.
 *
 * The implementation lives in `@dsh-cc/version-info` (one owner, one
 * `FALLBACK_VERSION` for `scripts/release.mjs`). The earlier local copy drifted
 * four releases behind `package.json` because the release script never rewrote
 * it; the shared constant is now the only one, so that class of drift cannot
 * recur.
 *
 * @module @dsh-cc/acp/version
 */

export { FALLBACK_VERSION, readOwnVersion } from '@dsh-cc/version-info'
