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

/**
 * Mechanical-check layer status (§17.1) — locally declared (cycle-break §3:
 * vwa-evidence never imports @dsh-cc/vwa-argument; the union mirrors the
 * review schema's MechanicalStatus).
 */
export type MechanicalStatus = 'pass' | 'fail' | 'not-run' | 'inapplicable'

/** Semantic check-layer verdict (review schema union). */
export type Verdict = 'pass' | 'fail' | 'needs-review' | 'not-run'

/** One claim's lane-2 assessment as carried by a v2 row (review schema shape). */
export interface AssessmentEntry {
  claimId: string
  supportGrade: 'A' | 'B' | 'C' | 'U'
  opposition: 'not-checked' | 'none-found' | 'material' | 'decisive'
  disposition: 'supported' | 'contested' | 'underdetermined' | 'refuted'
  reviewState: 'current' | 'stale' | 'not-run' | 'incomplete'
  reviewRunIds: string[]
  rationale: string[]
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

/** One v2 claim entry: multi-source (§16.1) — spans/sources may be empty. */
export interface ReceiptClaim {
  claimId: string
  spans: [number, number][]
  sources: { sourceId: string; snapshotHash: string; evidenceIds: string[] }[]
  assessment: AssessmentEntry
}

/**
 * Receipt row v:2 (§16.1) — same session ledger, discriminated by `v:2`.
 * `NumberEntry`/`GateEntry` are the exact v1 types (no drifted duplicates).
 */
export interface ReceiptV2 {
  v: 2
  receiptId: string
  ts: number
  sessionId: string
  projectId: string
  projectRevision: number
  artifactId: string
  artifactPath: string
  artifactHash: string
  graphHash: string
  policyHash: string
  reviewerConfigHash: string
  claims: ReceiptClaim[]
  numbers: NumberEntry[]
  gates: GateEntry[]
  checks: { mechanical: MechanicalStatus; evidence: Verdict; argument: Verdict; audit: Verdict }
  metrics: { mappedAtomicClaims: number; extractedAtomicClaims: number; reviewedCoreClaims: number; coreClaims: number }
  reviewRunIds: string[]
  pendingRunIds?: string[]
  findingCounts: { blocker: number; major: number; minor: number }
  report: { path: string; hash: string }
  provenance: { inputs: { sourceId: string; revisionHash: string }[]; parentHash: string }
  delivery: 'draft' | 'reviewed' | 'delivered-unverified' | 'delivered-reviewed'
  overall: 'pass' | 'fail' | 'abstained'
  nudge: { round: number }
}

/** The session-ledger discriminated union, typed by the `v` field (§16.1). */
export type AnyReceiptRow = ReceiptRow | ReceiptV2

/** receiptHash = SHA256(stableJson(row)); never stored in the row itself (§16.1). */
export function receiptHashOf(row: ReceiptV2): string {
  return sha256Hex(stableJson(row))
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
  // v1 read-back path (§16.1): v2 rows are skipped, never mistaken for the
  // v1 row just appended — the LAST v:1 line must match artifactHash.
  const rows = (await readJsonl<unknown>(ledgerPath)).filter(isV1Row)
  const last = rows.at(-1)
  if (last === undefined) return { ok: false, detail: 'ledger empty after append' }
  if (last.artifactHash !== row.artifactHash) {
    return { ok: false, detail: 'last line artifactHash mismatch after append' }
  }
  return { ok: true, row: last }
}

export interface WriteReceiptV2Result {
  /** True only when the appended line read back with the same receiptId AND receiptHash. */
  ok: boolean
  row?: ReceiptV2
  /** receiptHash of the read-back row when it parsed; useful for parentHash chaining. */
  receiptHash?: string
  detail?: string
}

/**
 * Append one v:2 row, then read back: the write is only claimable when the
 * last v:2 row with this receiptId re-hashes to the written receiptHash
 * (§16.1: both (receiptId, receiptHash) are compared; a write failure is
 * never presented as if the receipt exists). Historical v1 bytes are not
 * altered. Best-effort: never throws.
 */
export async function writeReceiptV2(ledgerPath: string, row: ReceiptV2): Promise<WriteReceiptV2Result> {
  const expectedHash = receiptHashOf(row)
  try {
    await appendJsonl(ledgerPath, JSON.parse(stableJson(row)), { repairTail: true })
  } catch {
    // appendJsonl swallows write errors internally; the read-back below
    // still decides. A throw here (e.g. parent dir unwritable) is decisive.
    return { ok: false, detail: 'append failed' }
  }
  let rows: unknown[]
  try {
    rows = await readJsonl<unknown>(ledgerPath)
  } catch (error: unknown) {
    return { ok: false, detail: `read-back failed: ${String(error)}` }
  }
  const mine = rows.filter(isV2Row).filter(candidate => candidate.receiptId === row.receiptId)
  const last = mine.at(-1)
  if (last === undefined) return { ok: false, detail: 'row not present after append' }
  const readBackHash = receiptHashOf(last)
  if (readBackHash !== expectedHash) {
    return { ok: false, receiptHash: readBackHash, detail: 'read-back receiptHash mismatch' }
  }
  return { ok: true, row: last, receiptHash: readBackHash }
}

/** Narrowing guard: v:1 rows only (§16.1 — v1 readers skip v2 rows). */
export function isV1Row(row: unknown): row is ReceiptRow {
  return typeof row === 'object' && row !== null && (row as { v?: unknown }).v === 1
}

/** Narrowing guard: v:2 rows only. */
export function isV2Row(row: unknown): row is ReceiptV2 {
  return typeof row === 'object' && row !== null && (row as { v?: unknown }).v === 2
}

/**
 * Nudge budget projection (§4.1/§16.2): counts `nudge.round > 0` rows from
 * BOTH versions — two packages share one budget, so v2 rounds consume it too.
 */
export function nudgeBudgetConsumed(rows: readonly AnyReceiptRow[]): number {
  return rows.filter(row => typeof row?.nudge?.round === 'number' && row.nudge.round > 0).length
}

/**
 * Last-matching-row staleness (§4.1), v:1 faces only (§16.1: v2 rows are
 * skipped by the v1 staleness reader — a v2 row never clears v1 staleness).
 * No v:1 row at all counts as stale (never verified).
 */
export function staleAgainst(
  rows: readonly AnyReceiptRow[],
  artifactPath: string,
  currentHash: string,
): boolean {
  const matching = rows.filter(isV1Row).filter(row => row?.artifactPath === artifactPath)
  const last = matching.at(-1)
  return !(last !== undefined && last.artifactHash === currentHash)
}

/**
 * Latest successfully read-back v2 receiptHash for a path, or '' (§16.1
 * parentHash chaining). Hashes are recomputed from the rows, never stored.
 */
export function lastV2ReceiptHash(rows: readonly AnyReceiptRow[], artifactPath: string): string {
  const matching = rows.filter(isV2Row).filter(row => row.artifactPath === artifactPath)
  const last = matching.at(-1)
  return last === undefined ? '' : receiptHashOf(last)
}
