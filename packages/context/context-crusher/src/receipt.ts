/**
 * Receipt schema and canonical renderer for the evidence-preserving reducer.
 * @module @dsh-cc/context-crusher/receipt
 */

import z from '@deepseek-ai/schemastery'

/** One failing test entry: identifier plus a verbatim evidence quote. */
export interface ReceiptFailure {
  readonly name: string
  readonly evidence: string
}

/**
 * The cheap-lane extraction receipt (plan §3.3). Every `evidence` /
 * `key_output` string must be a verbatim substring of the (possibly
 * truncated) source view; `verifyReceipt` enforces that.
 */
export interface Receipt {
  readonly v: 1
  readonly cmd: string
  readonly exit: { readonly ok: boolean; readonly code?: number | undefined }
  readonly failures: ReceiptFailure[]
  readonly key_output: string[]
  readonly counts?: { readonly pass: number; readonly fail: number; readonly skip: number } | undefined
}

/** schemastery has no `.optional()` method — union with `undefined` instead. */
const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** schemastery schema for the receipt shape (types only; see parseReceipt for key-set checks). */
export const ReceiptSchema: z<Receipt> = z.object({
  v: z.const(1),
  cmd: z.string(),
  exit: z.object({ ok: z.boolean(), code: opt(z.number().step(1)) }),
  failures: z.array(z.object({ name: z.string(), evidence: z.string() })),
  key_output: z.array(z.string()).max(8),
  counts: opt(z.object({ pass: z.number(), fail: z.number(), skip: z.number() })),
})

/** Exact allowed key sets per object level (unknown keys are rejected, not stripped). */
const ROOT_KEYS = ['v', 'cmd', 'exit', 'failures', 'key_output']
const ROOT_OPTIONAL_KEYS = ['counts']
const EXIT_KEYS = ['ok']
const EXIT_OPTIONAL_KEYS = ['code']
const FAILURE_KEYS = ['name', 'evidence']
const COUNTS_KEYS = ['pass', 'fail', 'skip']

/** Every present key must be in `allowed ∪ optional`; absent optional keys are fine. */
function exactKeys(obj: object, allowed: readonly string[], optional: readonly string[] = []): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k) || optional.includes(k))
}

/**
 * Parse and validate a raw receipt. Returns the receipt, or `null` when any
 * check fails: schema types, the 8-entry `key_output` cap, or the explicit
 * exact-key-set check at every object level (schemastery `z.object` keeps
 * unknown keys rather than stripping them, so rejection is explicit here).
 */
export function parseReceipt(raw: unknown): Receipt | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!exactKeys(r, ROOT_KEYS, ROOT_OPTIONAL_KEYS)) return null
  try {
    ReceiptSchema(r as unknown as Receipt)
  } catch {
    return null
  }
  const receipt = r as unknown as Receipt
  if (!exactKeys(receipt.exit, EXIT_KEYS, EXIT_OPTIONAL_KEYS)) return null
  for (const f of receipt.failures) {
    if (!exactKeys(f, FAILURE_KEYS)) return null
  }
  if (receipt.counts !== undefined && !exactKeys(receipt.counts, COUNTS_KEYS)) return null
  return receipt
}

/**
 * Canonical few-line rendering (plan §3.5): deterministic, receipt body only.
 * The caller appends the pinned `buildMarker(...)` line — never included here.
 */
export function renderReceipt(r: Receipt): string {
  const lines = [`cmd: ${r.cmd}`]
  const code = r.exit.code === undefined ? '' : ` code ${r.exit.code}`
  lines.push(`exit: ${r.exit.ok ? 'ok' : 'failed'}${code}`)
  for (const f of r.failures) lines.push(`FAIL ${f.name}: ${f.evidence}`)
  for (const q of r.key_output) lines.push(`key: ${q}`)
  if (r.counts) lines.push(`counts: pass=${r.counts.pass} fail=${r.counts.fail} skip=${r.counts.skip}`)
  return lines.join('\n')
}
