/**
 * Pinned copy of the context-crusher marker grammar (§5.6: "the executor
 * reads the crusher's actual marker from packages/context/context-crusher/src/
 * and pins it in a test; do not guess the marker string").
 *
 * Source of truth: packages/context/context-crusher/src/marker.ts
 * `buildMarker(tokensBefore, tokensAfter, hash)` produces
 * `[dsh-cc compressed <n>→<m> tokens. Original: ccr://<16-hex>]`.
 * Duplicating the tiny parser here keeps compaction consumers from taking a
 * runtime dependency on the crusher package; the framing spec pins the two
 * spellings against each other.
 *
 * @module @dsh-cc/tool-use-summary/crusher-marker
 */

/** Extracts a `ccr://<hash16>` handle from the marker. */
export const CCR_HASH_RE = /^[0-9a-f]{16}$/

/** Parse a crusher marker line into its parts, or null when not a marker. */
export function parseMarker(line: string): { tokensBefore: number; tokensAfter: number; hash: string } | null {
  const m = /^\[dsh-cc compressed (\d+)→(\d+) tokens\. Original: ccr:\/\/([0-9a-f]{16})\]$/.exec(line)
  if (m === null) return null
  return { tokensBefore: Number(m[1]), tokensAfter: Number(m[2]), hash: m[3] ?? '' }
}
