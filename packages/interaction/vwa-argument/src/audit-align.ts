/**
 * F4.3/F4.4 align-stage helpers (design
 * docs/plans/2026-10-23-vwa-audit-extract-output-budget.md): chunked align
 * dispatch with work-queue truncation bisect, the chunk merge, and the
 * runtime-owned AUDIT finding derivation. Kept out of audit.ts so the runner
 * file stays under the check:size cap.
 *
 * @module @dsh-cc/vwa-argument/audit-align
 */
import { randomUUID } from 'node:crypto'
import { AuditInvalidError, type AlignEnvelope } from './audit-input.ts'
import { validateAlignment } from './audit.ts'
import {
  ReviewTruncatedError,
  parseReviewResponse,
  validateTaskResponse,
  type ReviewTaskContract,
} from './review-adapter.ts'
import type { Finding, Id, Scope, Span } from './types.ts'

type AlignResponse = import('./types.ts').AlignResponse

/** The slice of a derivation the align stage needs (audit.ts derives the rest). */
export interface AlignDerivation {
  extractedId: Id
  item: {
    span: Span
    exactText: string
    atomicClaims: { text: string; kind: string; importance: string; scope?: Scope }[]
    isQuotation: boolean
  }
  originalSpan: Span
}

/**
 * F4.3: dispatch derivations in chunks of `maxChunkItems`, each chunk's
 * envelope = the shared align envelope with `items` restricted to the chunk.
 * F4.4: a truncated chunk (>1 item) is re-split odd-first and its halves jump
 * the queue — each split is a NEW call (own reservation, no retry-pool charge).
 */
export async function dispatchAlignChunks<D extends AlignDerivation>(args: {
  dispatch: (
    prompt: string,
    envelope: unknown,
    schema: object,
    parse: (raw: string) => unknown,
  ) => Promise<{ raw: unknown; inputTokens: number; outputTokens: number }>
  alignPrompt: string
  schema: object
  envelope: Omit<AlignEnvelope, 'items'> & Record<string, unknown>
  derivations: D[]
  maxChunkItems: number
  claimIds: Id[]
  withCaller: boolean
  taskSpec: ReviewTaskContract
}): Promise<{ responses: AlignResponse[]; inputTokens: number; outputTokens: number }> {
  const { dispatch, alignPrompt, schema, envelope, derivations, claimIds } = args
  const chunks: D[][] = []
  for (let i = 0; i < derivations.length; i += args.maxChunkItems) chunks.push(derivations.slice(i, i + args.maxChunkItems))
  if (chunks.length === 0) chunks.push([]) // pre-Fix-4 behavior: one align dispatch even with no items
  const responses: AlignResponse[] = []
  let inputTokens = 0,
    outputTokens = 0
  const queue = [...chunks]
  while (queue.length > 0) {
    const chunk = queue.shift()!
    const chunkEnvelope: AlignEnvelope & Record<string, unknown> = {
      ...envelope,
      items: chunk.map((d) => ({
        extractedId: d.extractedId,
        span: d.item.span,
        quote: d.item.exactText,
        atomicClaims: d.item.atomicClaims.map((c) => ({
          text: c.text,
          kind: c.kind,
          importance: c.importance,
          ...(c.scope === undefined ? {} : { scope: c.scope }),
        })),
        isQuotation: d.item.isQuotation,
      })),
    }
    try {
      const chunkRaw = await dispatch(alignPrompt, chunkEnvelope, schema, (raw) => {
        const response = parseReviewResponse(raw)
        if (response.stage !== 'align') throw new AuditInvalidError('expected an align response')
        validateAlignment(response, chunk, claimIds)
        if (args.withCaller) validateTaskResponse(response, args.taskSpec)
        return response
      })
      responses.push(chunkRaw.raw as AlignResponse)
      inputTokens += chunkRaw.inputTokens
      outputTokens += chunkRaw.outputTokens
    } catch (error) {
      if (error instanceof ReviewTruncatedError && chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2)
        queue.unshift(chunk.slice(0, mid), chunk.slice(mid))
        continue
      }
      throw error
    }
  }
  return { responses, inputTokens, outputTokens }
}

/**
 * F4.3 merge contract: stage/rubricVersion asserted identical, alignment
 * concatenated (the caller reorders by derivation and the full-set
 * `validateAlignment` gate re-runs in mergeAlignChunks), targets merged PER
 * (targetId, ruleId) keeping the WORST verdict (fail > needs-review > pass >
 * not-run; ties keep the first chunk's entry), findings concatenated
 * (runtime-owned AUDIT codes are appended by {@link runtimeAuditFindings},
 * never merged from model output).
 *
 * Why per-rule and worst-wins: every chunk is required to check the same
 * artifact target against all AUDIT rules, so duplicate (targetId, ruleId)
 * pairs are the NORMAL case. A plain per-target "last chunk wins" merge would
 * let a later chunk's `pass` erase an earlier chunk's `fail` — the persisted
 * checks would then contradict the findings (which are kept from every chunk).
 */
export function mergeAlignChunks(
  chunks: AlignResponse[],
  derivations: { extractedId: Id }[],
  claimIds: readonly Id[],
): AlignResponse {
  const first = chunks[0]!
  for (const chunk of chunks.slice(1)) {
    if (chunk.stage !== first.stage || chunk.rubricVersion !== first.rubricVersion)
      throw new AuditInvalidError('align chunk stage/rubricVersion mismatch')
  }
  const merged: AlignResponse = {
    ...first,
    alignment: chunks.flatMap((chunk) => chunk.alignment),
    targets: mergeChunkTargets(chunks),
    findings: chunks.flatMap((chunk) => chunk.findings),
  }
  // Final coherence gate over the whole set (each chunk validated only its own).
  validateAlignment(merged, derivations, claimIds)
  return merged
}

/** Verdict severity: the merge never lets a milder verdict replace a harsher one. */
const VERDICT_SEVERITY: Record<AlignResponse['targets'][number]['checks'][number]['result'], number> = {
  fail: 3,
  'needs-review': 2,
  pass: 1,
  'not-run': 0,
}

/**
 * Merge per-chunk target checks into one entry per (targetId, ruleId), keeping
 * the harsher verdict (first occurrence wins on ties, so the retained
 * rationale is deterministic). The ruleId union keeps the merged response
 * schema-valid and `validateTaskResponse`-clean (one check per rule per
 * target, which is exactly what a single-call align response must satisfy).
 *
 * The merged entry is built FRESH as `{ targetId, checks }` rather than
 * spreading a chunk's target: `ResponseTarget` is
 * `additionalProperties: false` with exactly those two properties
 * (review.schema.json), so there is no per-target field the spread would need
 * to preserve — and building fresh keeps a future schema addition a
 * conscious decision instead of a silent last-chunk-wins value.
 */
function mergeChunkTargets(chunks: AlignResponse[]): AlignResponse['targets'] {
  const targets = new Map<Id, Map<string, AlignResponse['targets'][number]['checks'][number]>>()
  for (const chunk of chunks) {
    for (const target of chunk.targets) {
      let checks = targets.get(target.targetId)
      if (checks === undefined) {
        checks = new Map()
        targets.set(target.targetId, checks)
      }
      for (const check of target.checks) {
        const previous = checks.get(check.ruleId)
        if (previous === undefined || VERDICT_SEVERITY[check.result] > VERDICT_SEVERITY[previous.result])
          checks.set(check.ruleId, check)
      }
    }
  }
  return [...targets.entries()].map(([targetId, checks]) => ({
    targetId,
    checks: [...checks.values()],
  }))
}

/** §11.4 runtime-owned AUDIT codes: model output carrying them is dropped. */
const RUNTIME_OWNED_AUDIT_CODES = new Set(['AUDIT_NEW_CLAIM', 'AUDIT_STRONGER', 'AUDIT_BROADER'])

/**
 * The three AUDIT codes are RUNTIME-OWNED: derived from the (merged)
 * alignment, never model output. Model-returned entries are dropped here —
 * the outcome path pairs AUDIT_NEW_CLAIM spans with 'new' atomics BY ORDER
 * (extraction order), so a model-echoed entry would shift spans onto the
 * wrong proposal.
 */
export function runtimeAuditFindings(
  alignResponse: AlignResponse,
  derivations: AlignDerivation[],
  artifactId: Id,
): Finding[] {
  const findings: Finding[] = alignResponse.findings.filter((f) => !RUNTIME_OWNED_AUDIT_CODES.has(f.code))
  for (const entry of alignResponse.alignment) {
    if (entry.relation !== 'new') continue
    const derivation = derivations.find((d) => d.extractedId === entry.extractedId)!
    for (const atomic of derivation.item.atomicClaims) {
      findings.push({
        id: `finding_${randomUUID()}`,
        code: 'AUDIT_NEW_CLAIM',
        targetIds: [artifactId],
        severity: 'major', // fixed major (§11.4); maps to AUDIT-01
        explanation: `Extracted claim maps to no author claim: ${atomic.text}`,
        evidenceIds: [],
        artifactSpans: [derivation.originalSpan],
        repair: 'add-evidence',
      })
    }
  }
  for (const entry of alignResponse.alignment) {
    if (entry.relation !== 'stronger' && entry.relation !== 'broader') continue
    const derivation = derivations.find((d) => d.extractedId === entry.extractedId)!
    findings.push({
      id: `finding_${randomUUID()}`,
      code: entry.relation === 'stronger' ? 'AUDIT_STRONGER' : 'AUDIT_BROADER',
      targetIds: [...entry.claimIds],
      severity: 'major', // fixed major (§11.4); maps to AUDIT-02
      explanation: `Extracted claim is ${entry.relation} than the mapped author claim: ${entry.rationale}`,
      evidenceIds: [],
      artifactSpans: [derivation.originalSpan],
      repair: entry.relation === 'stronger' ? 'qualify' : 'narrow-claim',
    })
  }
  return findings
}
