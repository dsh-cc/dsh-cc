/**
 * Pure orchestration pipeline (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.5, receipt §4.1).
 *
 * extract (§4.2) -> verify (§4.2) -> gates (§4.3) -> coverage/overall ->
 * receipt row for ONE artifact. NO cordis ctx, NO agent types — the
 * turn-stopping wiring (window anchoring, artifact-set derivation, ledger
 * location, nudge limits) is P2b's job; this module composes the pure core
 * and exposes a `writeReceipt` convenience (appendJsonl + mandatory
 * read-back, §4.1).
 *
 * @module @dsh-cc/vwa-evidence/pipeline
 */

import { relative } from 'node:path'
import type { Executor, GateOptions } from './gates.ts'
import { runGates } from './gates.ts'
import { extractClaims } from './marker.ts'
import { sha256Hex, type ClaimEntry, type GateEntry, type NumberEntry, type ReceiptRow } from './receipt.ts'
import { verifyClaim } from './verify.ts'
import { writeReceipt } from './receipt.ts'

export interface EvaluateOptions {
  sessionId: string
  artifactPath: string
  /** Original artifact text (the hash is computed over its UTF-8 bytes). */
  text: string
  workspaceRoot: string
  exec: Executor
  gates?: GateOptions
  /** Chain head linkage; '' at v1 until P2b wires ledger chaining (§4.1). */
  parentHash?: string
  now?: number
}

export interface EvaluationResult {
  row: ReceiptRow
  /** marked-ok claims / detected claims; null when no claims detected. */
  coverage: number | null
  overall: 'pass' | 'fail' | 'abstained'
}

/**
 * Evaluate one artifact: extract claims and number facts, mechanically
 * verify every marker, run the three gates, then compute coverage and
 * overall per §4.1/§8:
 * - any out-of-bounds claim or failed gate  -> `fail`
 * - no detected claims AND no failed gate   -> `abstained`
 * - otherwise                               -> `pass`
 * Coverage = claims with legal markers that pass read-back / detected
 * claims (§8, first-release threshold >= 0.9 applied upstream in P2b).
 */
export async function evaluateArtifact(opts: EvaluateOptions): Promise<EvaluationResult> {
  const { claims, numbers } = extractClaims(opts.text)
  const claimRows: ClaimEntry[] = []
  for (const claim of claims) {
    const specsPerMarker = claim.markers.filter(m => m.parsed).map(m => m.specs)
    const parsedFlags = claim.markers.map(m => m.parsed)
    const outcome = await verifyClaim(specsPerMarker, parsedFlags, opts.workspaceRoot)
    const entry: ClaimEntry = { span: claim.span, text: claim.text, status: outcome.status }
    if (outcome.status === 'marked-ok' && claim.markers[0] !== undefined) {
      const first = claim.markers[0]?.specs[0]
      if (first !== undefined) {
        entry.sourceId = first.sourceId
        entry.sourceSpan = [first.lineStart, first.lineEnd]
      }
    }
    if (outcome.detail !== undefined && outcome.status !== 'unmarked') {
      entry.text = `${claim.text} [${outcome.detail}]`
    }
    claimRows.push(entry)
  }
  const gateRows: GateEntry[] = await runGates([opts.artifactPath], opts.workspaceRoot, opts.exec, opts.gates)
  const anyFail = gateRows.some(g => g.status === 'fail')
  const anyOutOfBounds = claimRows.some(c => c.status === 'out-of-bounds')
  let overall: ReceiptRow['overall']
  if (anyFail || anyOutOfBounds) overall = 'fail'
  else if (claimRows.length === 0) overall = 'abstained'
  else overall = 'pass'
  const markedOk = claimRows.filter(c => c.status === 'marked-ok').length
  const coverage = claimRows.length > 0 ? markedOk / claimRows.length : null
  const numberRows: NumberEntry[] = numbers.map(n => ({
    span: n.span,
    ref: n.ref,
    paramsHash: 'v1-placeholder:dc-specialization-is-lane-3',
    rowCount: 0,
    caliber: 'number:v1',
  }))
  const row: ReceiptRow = {
    v: 1,
    ts: opts.now ?? Date.now(),
    sessionId: opts.sessionId,
    artifactId: relative(opts.workspaceRoot, opts.artifactPath).split('\\').join('/'),
    artifactPath: opts.artifactPath,
    artifactHash: sha256Hex(opts.text),
    claims: claimRows,
    numbers: numberRows,
    gates: gateRows,
    provenance: { inputs: [], parentHash: opts.parentHash ?? '' },
    overall,
    nudge: { round: 0 },
  }
  // Canonical key order pinned by tests; row stored as-is (JSON.stringify
  // in appendJsonl uses insertion order, tests pin stableJson separately).
  return { row, coverage, overall }
}

export { writeReceipt }
