/**
 * Effect-digest projection for M2 retry dedup (design doc
 * docs/plans/2026-10-09-verify-before-retry.md §3.3): sha256 over the
 * stable-JSON of `{tool, effect}` truncated to 16 hex chars. The digest is
 * over EFFECT FIELDS ONLY, never full arguments — bash `description` (a
 * model-authored, per-call field) must not change the identity of a retry.
 *
 * @module
 */

import { createHash } from 'node:crypto'

/** Effect-fields projection per tool (§3.3): shell → command+workdir, write/edit → their payload, else all args. */
export function effectFields(tool: string, execArguments: unknown): Record<string, unknown> {
  const args = typeof execArguments === 'object' && execArguments !== null ? execArguments as Record<string, unknown> : {}
  if (tool === 'bash' || tool === 'pwsh') return pick(args, ['command', 'workdir'])
  if (tool === 'write') return pick(args, ['file_path', 'content'])
  if (tool === 'edit') return pick(args, ['file_path', 'old_string', 'new_string'])
  return { ...args }
}

/** 16-hex digest key over stable-JSON of `{tool, effect}`. */
export function digestKey(tool: string, execArguments: unknown): string {
  const canonical = stableJson({ tool, effect: effectFields(tool, execArguments) })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** Pick the listed keys (present ones only) from an args record. */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in args) out[key] = args[key]
  }
  return out
}

/** Recursive key-sorting JSON stringify (handles non-object values; mcp-client/tools.ts:404-408 precedent). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`).join(',')}}`
}
