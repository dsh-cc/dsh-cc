/** Complete task inputs and the same dependency identity used at execution and delivery. */
import { buildReverseIndex, dependencyDigest, dependencyEntries, type ReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { RULES, RUBRIC_VERSION } from './review-contract.ts'
import type { ReviewTask } from './review-plan.ts'
import { ReviewContextError } from './review-call.ts'
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
  // CSV/TSV: cross-line consistency — the first two non-empty lines have
  // the same field count when split by the same delimiter. Prose with
  // commas fails this check; empty first fields still pass.
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length >= 2) {
    const delimiter = lines[0]!.includes('\t') ? '\t' : ','
    const firstFields = lines[0]!.split(delimiter)
    const secondFields = lines[1]!.split(delimiter)
    if (firstFields.length >= 2 && firstFields.length === secondFields.length) return true
  }
  return false
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
  // Design shape: candidates are the envelope with the measured source entry
  // swapped in. When the base is the full envelope, the sources live in
  // base.context; without a scaffold the base IS the context object.
  const cand = (sourceEntries: unknown[]) =>
    baseCtx === undefined ? { ...base, sources: sourceEntries } : { ...base, context: { ...baseCtx, sources: sourceEntries } }
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
    ...(input.task.stage === 'sources' && input.readSnapshot ? { text: input.readSnapshot(source.id) ?? '' } : {}),
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
    // The sources stage plans exactly one source per task, so this loop
    // normally fits a single entry. Sibling texts are stripped from each
    // measurement base; if a hypothetical multi-source envelope still
    // overshoots after per-entry fitting, the caller's total-length check
    // (review-call) fails safely with CONTEXT_TOO_LARGE.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (entry.text === undefined) continue
      const text = entry.text
      // Base envelope with every inlined text (this one and siblings)
      // removed; explicit undefined keys are dropped by stableJson.
      const withoutThis = entries
        .filter((_, j) => j !== i)
        .map((e) => (e.text === undefined ? e : { ...e, text: undefined, windowing: undefined }))
      const contextWithoutText = { ...restContext, sources: withoutThis }
      const envelopeWithoutText = input.measureScaffold
        ? { ...input.measureScaffold, context: contextWithoutText }
        : contextWithoutText
      // Measure the full candidate first (structured data is never windowed).
      const fullCandidate =
        input.measureScaffold
          ? { ...input.measureScaffold, context: { ...restContext, sources: [entry] } }
          : { ...restContext, sources: [entry] }
      if (stableJson(fullCandidate).length > input.maxContextChars) {
        if (isStructuredData(text)) {
          throw new ReviewContextError(
            `Source ${entry.id} is structured data (JSON/JSONL/CSV/XML) and exceeds the review context limit. ` +
              `Windowing is not applied to structured data. Register a distilled companion source with ` +
              `lineage.parentSourceIds: ["${entry.id}"] to proceed.`,
          )
        }
        const fitted = fitSourceText(text, envelopeWithoutText, input.maxContextChars, entry)
        entries[i] = { ...entry, text: fitted.text, ...(fitted.windowing ? { windowing: fitted.windowing } : {}) }
      }
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
