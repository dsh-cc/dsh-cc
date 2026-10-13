/**
 * Receipt schema and write contract (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.1).
 *
 * Versioned v:1 JSONL rows under `<dshHome>/vwa-receipts/<encodeSegment(sessionId)>.jsonl`.
 * Canonical serialization = stable-key JSON (sorted keys, no whitespace —
 * LOCAL helper, same idiom as completion-gate's receipts.ts, never imported
 * across packages). Writes go through sidecar-io `appendJsonl` with
 * `repairTail` (swallows errors, tolerates torn tails), so a write is only
 * claimable after write-then-read-back: the LAST line must parse and match
 * `artifactHash`. Reads use `readJsonl` (skips unparseable lines).
 *
 * `artifactHash` = SHA-256 of the artifact's UTF-8 bytes. Same path with
 * changed content makes the old receipt stale.
 *
 * @module @dsh-cc/vwa-evidence/receipt
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { appendJsonl, readJsonl } from '@dsh-cc/sidecar-io'
import { encodeSegment } from './encode.ts'

/** Claim status per §4.1. */
export type ClaimStatus = 'marked-ok' | 'unmarked' | 'invalid-marker' | 'out-of-bounds'

/** One detected claim (span = UTF-16 code-unit indices into the artifact). */
export interface ClaimEntry {
  span: [number, number]
  text: string
  status: ClaimStatus
  sourceId?: string
  sourceSpan?: [number, number]
}

/**
 * One (a)-family (numbers with units/percentages) detection. `paramsHash`
 * is a v1 PLACEHOLDER — DC/number receipt specialization (calibration,
 * row counts, cross-checks) is lane-3 scope (§7); the field documents the
 * eventual shape without computing anything yet.
 */
export interface NumberEntry {
  span: [number, number]
  ref: string
  paramsHash: string
  rowCount: number
  caliber: string
  crossCheck?: boolean
}

/** Gate status union per §4.3. */
export type GateStatus = 'pass' | 'fail' | 'abstained' | 'missing'

/** One gate result. `missing` (gate did not run) requires detail. */
export interface GateEntry {
  gate: 'link' | 'style' | 'exec'
  status: GateStatus
  detail?: string
}

/** Receipt row v:1 — all fields required except where marked optional (§4.1). */
export interface ReceiptRow {
  v: 1
  ts: number
  sessionId: string
  artifactId: string
  artifactPath: string
  artifactHash: string
  claims: ClaimEntry[]
  numbers: NumberEntry[]
  gates: GateEntry[]
  provenance: { inputs: { sourceId: string; revisionHash: string }[]; parentHash: string }
  overall: 'pass' | 'fail' | 'abstained'
  nudge: { round: number }
}

/** Canonical JSON: sorted keys recursively, no whitespace (pinned by tests). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** SHA-256 hex digest of a UTF-8 string — the artifact hash (§4.1). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Ledger path for one session: `<dshHome>/vwa-receipts/<encodeSegment(sessionId)>.jsonl` (§4.1). */
export function receiptLedgerPath(dshHome: string, sessionId: string): string {
  return join(dshHome, 'vwa-receipts', `${encodeSegment(sessionId)}.jsonl`)
}

export interface WriteReceiptResult {
  /** True only when the appended line was read back and its artifactHash matched. */
  ok: boolean
  row?: ReceiptRow
  detail?: string
}

/**
 * Append one receipt row, then read the ledger back: the write is only
 * claimable ("receipt present") when the LAST parseable line carries the
 * row's artifactHash — appendJsonl swallows errors, so the read-back is
 * mandatory (§4.1). Best-effort: never throws.
 */
export async function writeReceipt(ledgerPath: string, row: ReceiptRow): Promise<WriteReceiptResult> {
  await appendJsonl(ledgerPath, JSON.parse(stableJson(row)), { repairTail: true })
  const rows = await readJsonl<ReceiptRow>(ledgerPath)
  const last = rows.at(-1)
  if (last === undefined) return { ok: false, detail: 'ledger empty after append' }
  if (last.artifactHash !== row.artifactHash) {
    return { ok: false, detail: 'last line artifactHash mismatch after append' }
  }
  return { ok: true, row: last }
}

/** Rows of the session ledger whose nudge actually fired (§4.1 budget projection). */
export function nudgeBudgetConsumed(rows: readonly ReceiptRow[]): number {
  return rows.filter(row => typeof row?.nudge?.round === 'number' && row.nudge.round > 0).length
}

/**
 * Last-matching-row staleness (§4.1): an artifact at `artifactPath` is stale
 * against the ledger unless the LAST row for that path carries exactly the
 * current content hash. No row at all counts as stale (never verified).
 * Callers combine this with write-then-read-back success.
 */
export function staleAgainst(
  rows: readonly ReceiptRow[],
  artifactPath: string,
  currentHash: string,
): boolean {
  const matching = rows.filter(row => row?.artifactPath === artifactPath)
  const last = matching.at(-1)
  return !(last !== undefined && last.artifactHash === currentHash)
}
