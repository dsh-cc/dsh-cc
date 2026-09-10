/**
 * Marker contract for crushed tool results.
 *
 * PINNED CONTRACT: the marker literal is appended to every compressed tool
 * result and the `context_retrieve` tool description references the same
 * `ccr://<hash>` spelling. A test pins the wording ↔ description pairing.
 *
 * @module @dsh-cc/context-crusher/marker
 */

/** Extracts a `ccr://<hash16>` handle from the marker. */
export const CCR_HASH_RE = /^[0-9a-f]{16}$/

/**
 * Build the provenance marker appended to compressed text.
 * @param tokensBefore - tokenMeter token estimate of the original.
 * @param tokensAfter - tokenMeter token estimate of the compressed form (marker excluded).
 * @param hash - the 16-hex content handle of the stored original.
 * @returns e.g. `[dsh-cc compressed 41230→6180 tokens. Original: ccr://a1b2c3d4e5f60708]`
 */
export function buildMarker(tokensBefore: number, tokensAfter: number, hash: string): string {
  return `[dsh-cc compressed ${tokensBefore}→${tokensAfter} tokens. Original: ccr://${hash}]`
}

/**
 * Parse a marker back into its parts.
 * @param line - the marker text.
 * @returns `{tokensBefore, tokensAfter, hash}`, or `null` when not a marker.
 */
export function parseMarker(line: string): { tokensBefore: number; tokensAfter: number; hash: string } | null {
  const m = /^\[dsh-cc compressed (\d+)→(\d+) tokens\. Original: ccr:\/\/([0-9a-f]{16})\]$/.exec(line)
  if (m === null) return null
  return { tokensBefore: Number(m[1]), tokensAfter: Number(m[2]), hash: m[3] ?? '' }
}
