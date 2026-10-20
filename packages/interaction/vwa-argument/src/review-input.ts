/** Complete task inputs and the same dependency identity used at execution and delivery. */
import { buildReverseIndex, dependencyDigest, dependencyEntries, type ReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { RULES, RUBRIC_VERSION } from './review-contract.ts'
import type { ReviewTask } from './review-plan.ts'
import { ReviewContextError } from './review-call.ts'
import { isDelimitedData } from './structured-data.ts'
import type { Hash, Id, ProjectSnapshot, ReviewRecord, SourceEnvelopeEntry, SourceWindowing } from './types.ts'

const ORDER = ['sources', 'support', 'claims', 'arguments', 'extract', 'align']
export function taskDependencyIds(index: ReverseIndex, task: ReviewTask): Id[] {
  const ids = new Set(task.targetIds)
  for (const ref of task.targetRefs) {
    const group = index.groups.get(ref.id)
    if (group) ids.add(group.targetClaimId)
    const arg = index.arguments.get(ref.id)
    if (arg) ids.add(arg.conclusionClaimId)
    const issue = index.issues.get(ref.id)
    if (issue) {
      ids.add(issue.targetId)
      issue.relatedClaimIds.forEach((id) => ids.add(id))
    }
    const source = index.sources.get(ref.id)
    if (source) {
      for (const ev of index.evidence.values()) {
        if (ev.sourceId !== source.id) continue
        ids.add(ev.id)
        for (const g of index.groups.values()) if (g.evidenceIds.includes(ev.id)) ids.add(g.targetClaimId)
      }
    }
  }
  return [...ids].sort()
}
export function upstreamRecords(index: ReverseIndex, task: ReviewTask, records: ReviewRecord[]): ReviewRecord[] {
  const ids = new Set(dependencyEntries(index, taskDependencyIds(index, task)).map((e) => e.id))
  return records
    .filter((r) => ORDER.indexOf(r.stage) < ORDER.indexOf(task.stage) && r.targetRefs.some((ref) => ids.has(ref.id)))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
}
/** Hash of a record's semantic content only; run metadata (runId, timestamps, token counts) excluded. */
export function semanticRecordHash(r: ReviewRecord): Hash {
  return sha256Hex(
    stableJson({
      stage: r.stage,
      targetRefs: r.targetRefs,
      dependencyDigest: r.dependencyDigest,
      contractHash: r.contractHash,
      policyHash: r.policyHash,
      reviewerConfigHash: r.reviewerConfigHash,
      promptHash: r.promptHash,
      inputHash: r.inputHash,
      status: r.status,
      response: r.response,
    }),
  )
}
/** Collapse records that are semantically identical (e.g. original + reused copy). */
export function deduplicateBySemanticHash(records: ReviewRecord[]): ReviewRecord[] {
  const seen = new Set<Hash>()
  return records.filter((r) => {
    const hash = semanticRecordHash(r)
    if (seen.has(hash)) return false
    seen.add(hash)
    return true
  })
}
export function taskDependencyDigest(index: ReverseIndex, task: ReviewTask, records: ReviewRecord[]): Hash {
  return sha256Hex(
    stableJson({
      graph: dependencyDigest(index, taskDependencyIds(index, task)),
      task: task.envelope,
      upstream: deduplicateBySemanticHash(upstreamRecords(index, task, records))
        .map((r) => semanticRecordHash(r))
        .sort(),
    }),
  )
}
const MIN_SOURCE_WINDOW = 2000 // chars; below this, windowing is useless

/** Conservative structured-data detection: windowing is never applied to structured data (E.2.1). */
export function isStructuredData(text: string): boolean {
  const trimmed = text.trimStart()
  // JSON: starts with { or [
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true
  // JSONL: first line parses as JSON
  const firstLine = trimmed.split('\n')[0] ?? ''
  try {
    JSON.parse(firstLine)
    return true
  } catch {
    /* not JSONL */
  }
  // XML: starts with <?xml or <
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) return true
  // Compare logical records; quoted delimiters and newlines are field content.
  // Try both formats independently: a tab inside a CSV field is not a TSV hint.
  return isDelimitedData(trimmed, ',') || isDelimitedData(trimmed, '\t')
}

/**
 * Measured head+tail windowing of a source text against the serialized
 * envelope (E.2.2). Every return path is measured, never estimated.
 */
export function fitSourceText(
  text: string,
  envelopeWithoutText: unknown,
  maxContextChars: number,
  // Real source entry (persisted fields + text); candidates must measure the
  // actual entry shape, not a bare { text } stand-in.
  entry?: unknown,
): { text: string; windowing?: SourceWindowing } {
  const base = envelopeWithoutText as Record<string, unknown>
  const baseCtx = (base as { context?: Record<string, unknown> }).context
  const siblings = (baseCtx ?? base).sources
  // The base contains sibling sources; each candidate adds the measured
  // target without dropping those siblings. A scaffold nests them in context.
  const cand = (sourceEntries: unknown[]) => {
    const sources = [...(Array.isArray(siblings) ? siblings : []), ...sourceEntries]
    return baseCtx === undefined ? { ...base, sources } : { ...base, context: { ...baseCtx, sources } }
  }
  const marker = (head: number, tail: number) => '\n\n[... ' + (text.length - head - tail) + ' chars omitted ...]\n\n'
  const entryWith = (windowText: string, windowing?: SourceWindowing) =>
    ({ ...(entry as object), text: windowText, ...(windowing ? { windowing } : {}) })
  // Measure the full envelope with the complete text first.
  if (stableJson(cand([entryWith(text)])).length <= maxContextChars) {
    return { text } // fits without windowing
  }
  // Compute the window from the remaining budget.
  const baseSize = stableJson(base).length
  const overhead = 300 // omission marker + windowing metadata (conservative)
  const availableForSource = maxContextChars - baseSize - overhead
  if (availableForSource < MIN_SOURCE_WINDOW) {
    throw new ReviewContextError('envelope overhead leaves insufficient room for source text')
  }
  const headChars = Math.floor(availableForSource / 2)
  const tailChars = availableForSource - headChars
  const windowed = text.slice(0, headChars) + marker(headChars, tailChars) + text.slice(-tailChars)
  // Measure the serialized envelope with the windowed text.
  const windowedSize = stableJson(
    cand([entryWith(windowed, { totalChars: text.length, headChars, tailChars })]),
  ).length
  if (windowedSize <= maxContextChars) {
    return { text: windowed, windowing: { totalChars: text.length, headChars, tailChars } }
  }
  // JSON escaping expanded the text beyond the raw char estimate.
  // Shrink by the overshoot and retry once.
  const overshoot = windowedSize - maxContextChars
  const shrunkAvailable = availableForSource - overshoot - 500 // safety margin
  if (shrunkAvailable < MIN_SOURCE_WINDOW) {
    throw new ReviewContextError('envelope overhead leaves insufficient room for source text after JSON escaping')
  }
  const shrunkHead = Math.floor(shrunkAvailable / 2)
  const shrunkTail = shrunkAvailable - shrunkHead
  const shrunkWindowed = text.slice(0, shrunkHead) + marker(shrunkHead, shrunkTail) + text.slice(-shrunkTail)
  // Measure the shrunk candidate too — the safety margin may not cover
  // pathological escaping (e.g., text that is 100% newlines).
  const shrunkCandidate = cand([entryWith(shrunkWindowed, { totalChars: text.length, headChars: shrunkHead, tailChars: shrunkTail })])
  if (stableJson(shrunkCandidate).length > maxContextChars) {
    throw new ReviewContextError('envelope overhead leaves insufficient room for source text even after shrinking')
  }
  return {
    text: shrunkWindowed,
    windowing: { totalChars: text.length, headChars: shrunkHead, tailChars: shrunkTail },
  }
}

export function reviewContext(input: {
  snapshot: ProjectSnapshot
  task: ReviewTask
  records: ReviewRecord[]
  readSnapshot?(id: Id): string | undefined
  maxContextChars?: number
  /** Full-envelope scaffolding (stage, runId, contract, ...) so measurement covers the whole envelope. */
  measureScaffold?: Record<string, unknown>
}): unknown {
  const index = buildReverseIndex(input.snapshot)
  const ids = new Set(dependencyEntries(index, taskDependencyIds(index, input.task)).map((e) => e.id))
  const evidence = input.snapshot.evidence.filter((e) => ids.has(e.id))
  const sources = input.snapshot.sources.filter((s) => ids.has(s.id))
  const entries: SourceEnvelopeEntry[] = sources.map((source) => ({
    ...source,
    // A sources task reviews one target. Dependency sources retain metadata
    // and evidence slices; their full texts belong to their own reviews.
    ...(input.task.stage === 'sources' && input.task.targetIds.includes(source.id) && input.readSnapshot
      ? { text: input.readSnapshot(source.id) ?? '' }
      : {}),
  }))
  const restContext = {
    evidence: evidence.map((e) => {
      const text = input.readSnapshot?.(e.sourceId)
      return {
        ...e,
        quote: text === undefined ? e.quote : text.slice(e.span.start, e.span.end),
        context: text === undefined ? '' : text.slice(e.contextSpan.start, e.contextSpan.end),
      }
    }),
    claims: input.snapshot.claims.filter((c) => ids.has(c.id)),
    issues: input.snapshot.issues.filter((i) => ids.has(i.id)),
    searches: input.snapshot.searches.filter((s) => ids.has(s.id)),
    // Persisted reuse copies remain available for provenance, but must not
    // consume model context repeatedly under the same semantic cache key.
    currentReviews: deduplicateBySemanticHash(upstreamRecords(index, input.task, input.records)),
  }
  if (input.task.stage === 'sources' && input.readSnapshot && input.maxContextChars !== undefined) {
    const envelopeWith = (sources: SourceEnvelopeEntry[]) => {
      const context = { ...restContext, sources }
      return input.measureScaffold ? { ...input.measureScaffold, context } : context
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (entry.text === undefined) continue
      const text = entry.text
      // Related-source metadata and all evidence slices count toward both
      // the full-text check and every candidate measured during fitting.
      const envelopeWithoutText = envelopeWith(entries.filter((_, j) => j !== i))
      if (stableJson(envelopeWith(entries)).length > input.maxContextChars) {
        if (isStructuredData(text)) {
          throw new ReviewContextError(
            `Source ${entry.id} is structured data (JSON/JSONL/CSV/XML) and exceeds the review context limit. ` +
              `Windowing is not applied to structured data. Register a distilled companion source with ` +
              `lineage.parentSourceIds: ["${entry.id}"] and cite it instead of the original in claim scope or evidence. ` +
              `The original remains metadata in the companion review; its own review is still refused.`,
          )
        }
        const fitted = fitSourceText(text, envelopeWithoutText, input.maxContextChars, entry)
        entries[i] = { ...entry, text: fitted.text, ...(fitted.windowing ? { windowing: fitted.windowing } : {}) }
      }
    }
    if (stableJson(envelopeWith(entries)).length > input.maxContextChars) {
      throw new ReviewContextError('envelope overhead leaves insufficient room for source text')
    }
  }
  return {
    sources: entries,
    ...restContext,
  }
}
export function taskEnvelope(input: {
  stage: string
  runId: Id
  task: ReviewTask
  snapshot: ProjectSnapshot
  records: ReviewRecord[]
  maxOutputTokens: number
  readSnapshot?(id: Id): string | undefined
  maxContextChars?: number
}): unknown {
  const scaffold = {
    stage: input.stage,
    runId: input.runId,
    taskId: input.task.taskId,
    rubricVersion: RUBRIC_VERSION,
    requiredRules: input.task.requiredRules,
    ruleDefinitions: Object.fromEntries(input.task.requiredRules.map((r) => [r.ruleId, RULES[r.ruleId]])),
    contract: input.snapshot.contract,
    targets: input.task.targetRefs,
    dependencies: input.task.envelope,
    budget: { maxOutputTokens: input.maxOutputTokens },
  }
  return {
    ...scaffold,
    context: reviewContext({ ...input, measureScaffold: scaffold }),
  }
}
