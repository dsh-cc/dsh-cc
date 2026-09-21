/**
 * Burst labeling (design doc §3.5). Pure decision: every matching edit runs
 * verification; when a previous verify for the same rule is within the
 * debounce window, the appended block is labeled so the model can never
 * mistake an overlapped run for a green one. The per-rule timestamp map
 * lives in the Phase 1 runner.
 *
 * @module
 */

/** The exact burst label appended inside the verify block. */
export function burstLabel(_ruleKey: string, now: number, lastRunAt: number | undefined, debounceMs: number): string | undefined {
  if (lastRunAt === undefined) return undefined
  const elapsed = now - lastRunAt
  if (elapsed >= debounceMs) return undefined
  return `[auto-verify] burst — result may overlap edits from ${elapsed}ms ago`
}

/** Alias kept for block text composition: same decision, label string only. */
export const verifyBlockLabel = burstLabel
