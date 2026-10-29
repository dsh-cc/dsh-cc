/**
 * Reader report rendering (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §19): deterministic Markdown/JSON from a FIXED 7-part template, the fixed
 * honesty wordings, and the §17.1 mechanical mapping (D17). Split from
 * report.ts for the repo file-size cap; the service lives in report.ts.
 *
 * @module @dsh-cc/vwa-argument/report-render
 */

import { sha256Hex, stableJson } from './schema.ts'
import { buildReverseIndex } from './dependencies.ts'
import { POLICY_VERSION } from './policy.ts'
import { RUBRIC_VERSION } from './review-runner.ts'
import { computeCoreSet } from './review-plan.ts'
import type {
  AdjudicationRecord,
  Assessment,
  Finding,
  Hash,
  Id,
  MechanicalStatus,
  ProjectSnapshot,
  ReviewFailure,
  ReviewRecord,
  ReviewStage,
  StageProgress,
  Verdict,
} from './types.ts'

/** Required §19 honesty wordings (fixed strings, disclosed verbatim). */
export const HONESTY = {
  noEvidence: 'No verified evidence yet',
  notChecked: 'Not checked',
  notFound: 'Not found within the following scope',
  noGap: 'No gap registered; completeness of evidence cannot be inferred from this.',
  legacy: 'semantic: not-run (legacy)',
  checksCompleted: 'checks completed according to the listed evidence and review rules',
  externallyClaimed: 'externally claimed, not verified by the runtime',
} as const

/** The §19 fixed 7-part template (part titles in fixed order). */
export const REPORT_TEMPLATE = [
  'Overview and analysis scope',
  'Checks (mechanical / evidence / argument / audit)',
  'Core conclusions',
  'Explanation cards',
  'Unresolved disputes and evidence gaps',
  'Sources and lineage',
  'Review configuration, cost, adjudications, and binding',
] as const

export type GateEntry = {
  gate: string
  status: 'pass' | 'fail' | 'abstained' | 'missing'
  detail?: string
  /** exec gate: number of executable code fences in the artifact. */
  fenceCount?: number
  /** style gate: whether a runnable ruleset is loaded. */
  rulesetLoaded?: boolean
}

/** §17.1/D17 mechanical mapping over the raw gate entries. */
export function mapMechanical(gates: GateEntry[]): MechanicalStatus {
  if (gates.length === 0) return 'not-run'
  const mapped = new Map<string, 'pass' | 'fail' | 'not-run' | 'inapplicable'>()
  for (const gate of gates) {
    if (gate.gate === 'style') {
      // Style abstained with NO runnable ruleset → not-run, disclosed (§17.1).
      mapped.set(
        'style',
        gate.status === 'abstained' && gate.rulesetLoaded !== true
          ? 'not-run'
          : gate.status === 'fail'
            ? 'fail'
            : gate.status === 'pass'
              ? 'pass'
              : 'not-run',
      )
      continue
    }
    if (gate.gate === 'exec') {
      // Exec with no executable fence → inapplicable (§17.1).
      mapped.set(
        'exec',
        (gate.fenceCount ?? 0) === 0
          ? 'inapplicable'
          : gate.status === 'fail'
            ? 'fail'
            : gate.status === 'pass'
              ? 'pass'
              : 'not-run',
      )
      continue
    }
    // The link gate and any used exec gate are REQUIRED — missing/abstained is never a pass.
    mapped.set(gate.gate, gate.status === 'pass' ? 'pass' : gate.status === 'fail' ? 'fail' : 'not-run')
  }
  const values = [...mapped.values()]
  if (values.includes('fail')) return 'fail'
  if (values.includes('not-run')) return 'not-run'
  return values.every((value) => value === 'inapplicable') ? 'inapplicable' : 'pass'
}

export interface ReportInput {
  snapshot: ProjectSnapshot
  artifactId: Id
  artifactHash: Hash
  checks: { mechanical: MechanicalStatus; evidence: Verdict; argument: Verdict; audit: Verdict }
  assessments: Assessment[]
  findings: Finding[]
  /** Feature 3 §4.3: machine-deferred disagreements pending human adjudication. */
  deferredDisagreements?: import('./delivery-check.ts').DeferredDisagreement[]
  adjudications: AdjudicationRecord[]
  reviewRunIds: Id[]
  metrics: { mappedAtomicClaims: number; extractedAtomicClaims: number; reviewedCoreClaims: number; coreClaims: number }
  cost: { inputTokens: number; outputTokens: number; calls: number; modelId: string }
  gates: GateEntry[]
  /** True when the current-run v2 receipt exists (D20: otherwise the legacy disclosure). */
  hasV2Receipt: boolean
  hasLegacyReceipt: boolean
  bindingDigest: Hash
  reportVersion: string
  artifactText?: string
  eligibleCandidate?: boolean
  coreClaimIds?: Id[]
  /** Feature D §D.2.1/§D.2.2: stage progress + failure detail (absent in legacy frozen inputs). */
  stageProgress?: Record<ReviewStage, StageProgress>
  failures?: ReviewFailure[]
}

function escape(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function coreAssessments(input: ReportInput): Assessment[] {
  const index = buildReverseIndex(input.snapshot)
  const artifactText = input.artifactText ?? ''
  const core = computeCoreSet({
    index,
    artifactText,
    artifactId: input.artifactId,
    requiredQuestionTexts: input.snapshot.contract.requiredQuestions.map((question) => question.text),
  })
  for (const id of input.coreClaimIds ?? []) core.add(id)
  return input.assessments.filter((assessment) => core.has(assessment.claimId))
}

function statusOf(input: ReportInput): string {
  if (input.eligibleCandidate || input.hasV2Receipt)
    return 'reviewed candidate (receipt status is provided by the delivery summary)'
  if (input.hasLegacyReceipt) return HONESTY.legacy
  // Feature D §D.2.4: partially reviewed (some stage has completed tasks)
  // is distinct from "never started" (draft).
  if (input.stageProgress && Object.values(input.stageProgress).some((p) => p.completed > 0))
    return 'review-in-progress'
  return 'draft'
}

/** §19 parts 1–7, in fixed order. Same input → byte-identical output. */
export function renderReportMarkdown(input: ReportInput): string {
  const lines: string[] = []
  // Part 1 — title, version, status, goal questions, analysis scope.
  lines.push('# VWA Reader Report', '')
  lines.push(`reportVersion: ${input.reportVersion} · policy ${POLICY_VERSION} · rubric ${RUBRIC_VERSION}`, '')
  lines.push(`Status: ${statusOf(input)}`, '')
  const deferred = input.deferredDisagreements ?? []
  if (deferred.length) lines.push(`machine-deferred: ${deferred.length} pending`, '')
  lines.push(
    'Experimental semantic review: human-calibrated extraction recall is not yet available; gold-set version: humanities-scorer@1 (synthetic development cases only).',
    '',
  )
  lines.push(`Goal question: ${input.snapshot.contract.question}`, '')
  for (const question of input.snapshot.contract.requiredQuestions) {
    lines.push(`Required question ${question.id}: ${question.text}`)
  }
  lines.push('')
  lines.push(
    `Analysis scope: subject "${escape(input.snapshot.contract.question)}", planned corpus ${input.snapshot.contract.plannedCorpus.join(', ') || HONESTY.notChecked}, mode ${input.snapshot.contract.mode}.`,
    '',
  )
  // Part 2 — the four check layers + anything not executed.
  lines.push('## 2. Checks (mechanical / evidence / argument / audit)', '')
  lines.push('| layer | result |', '| --- | --- |')
  lines.push(`| mechanical | ${input.checks.mechanical} |`)
  lines.push(`| evidence | ${input.checks.evidence} |`)
  lines.push(`| argument | ${input.checks.argument} |`)
  lines.push(`| audit | ${input.checks.audit} |`, '')
  const notExecuted: string[] = []
  if (input.checks.mechanical === 'not-run') notExecuted.push('mechanical gates not run')
  if (input.checks.evidence === 'not-run') notExecuted.push('evidence review not run')
  if (input.checks.argument === 'not-run') notExecuted.push('argument review not run')
  if (input.checks.audit === 'not-run') notExecuted.push('full-text audit not run')
  if (notExecuted.length > 0) lines.push(`Not executed: ${notExecuted.join('; ')}.`, '')
  for (const gate of input.gates)
    lines.push(`Gate ${gate.gate}: ${gate.status}${gate.detail ? ` — ${escape(gate.detail)}` : ''}`)
  // Feature D §D.2.3: stage-level review progress, between the checks table
  // and the findings list. The "### Failures" block is rendered only when
  // there are failures (an empty failures table carries no information).
  if (input.stageProgress) {
    lines.push('## Review progress', '')
    lines.push('| stage | completed | failed | not run | last task |', '| --- | --- | --- | --- | --- |')
    for (const [stage, progress] of Object.entries(input.stageProgress)) {
      const categories = [
        progress.channelErrors > 0 ? `channel ${progress.channelErrors}` : '',
        progress.schemaErrors > 0 ? `schema ${progress.schemaErrors}` : '',
        progress.budgetErrors > 0 ? `budget ${progress.budgetErrors}` : '',
      ].filter(Boolean)
      lines.push(
        `| ${stage} | ${progress.completed}/${progress.total} | ${progress.failed}${categories.length ? ` (${categories.join(', ')})` : ''} | ${progress.notRun} | ${progress.lastRunStatus ?? '—'} |`,
      )
    }
    lines.push('')
    if (input.failures?.length) {
      lines.push('### Failures', '', '| stage | targets | error | detail |', '| --- | --- | --- | --- |')
      for (const failure of input.failures)
        lines.push(
          `| ${failure.stage} | ${escape(failure.targetIds.join(', '))} | ${failure.errorCode} | ${escape(failure.errorDetail?.message ?? '')} |`,
        )
      lines.push('')
    }
  }
  // Part 3 — core conclusion table.
  lines.push('## 3. Core conclusions', '')
  lines.push('| ID | claim | support | dispute | review freshness |', '| --- | --- | --- | --- | --- |')
  for (const assessment of coreAssessments(input)) {
    const claim = input.snapshot.claims.find((c) => c.id === assessment.claimId)
    lines.push(
      `| ${assessment.claimId} | ${escape(claim?.text ?? '')} | ${assessment.supportGrade} | ${assessment.disposition} | ${assessment.reviewState} |`,
    )
  }
  lines.push('')
  // Part 4 — explanation card per core conclusion (fixed fields).
  lines.push('## 4. Explanation cards', '')
  for (const assessment of coreAssessments(input)) lines.push(...cardLines(input, assessment))
  // Part 5 — unresolved disputes and gaps, ordered by impact.
  lines.push('## 5. Unresolved disputes and evidence gaps', '')
  appendDisputes(lines, input)
  appendDeferredDisagreements(lines, input)
  // Part 6 — sources and lineage.
  lines.push('## 6. Sources and lineage', '')
  appendSources(lines, input)
  // Part 7 — configuration, cost, adjudications, binding, historical limits.
  lines.push('## 7. Review configuration, cost, adjudications, and binding', '')
  appendConfiguration(lines, input)
  return `${lines.join('\n')}\n`
}

function cardLines(input: ReportInput, assessment: Assessment): string[] {
  const claim = input.snapshot.claims.find((c) => c.id === assessment.claimId)
  const issues = input.snapshot.issues.filter(
    (issue) => issue.targetId === assessment.claimId || issue.relatedClaimIds.includes(assessment.claimId),
  )
  const gaps = issues.filter((issue) => issue.gap !== undefined)
  const searches = input.snapshot.searches.filter((search) => search.targetIds.includes(assessment.claimId))
  const groupIds = input.snapshot.groups
    .filter((group) => group.targetClaimId === assessment.claimId)
    .map((group) => group.id)
  const evidence = input.snapshot.evidence.filter((ev) =>
    input.snapshot.groups.some((group) => groupIds.includes(group.id) && group.evidenceIds.includes(ev.id)),
  )
  const quotes = evidence.slice(0, 3).map((ev) => `"${ev.quote}" (${ev.originalLocation})`)
  const lines = [`### Conclusion ${assessment.claimId}`, '']
  lines.push(`- conclusion: ${escape(claim?.text ?? '')}`)
  lines.push(
    `- supported scope: ${escape(claim?.scope.subject ?? '')} (corpus: ${claim?.scope.corpus.join(', ') || HONESTY.notChecked})`,
  )
  const noneFound = searches.filter((search) => search.finding === 'none-found').map((search) => `"${search.query}"`)
  let evidenceLine: string
  if (quotes.length === 0 && assessment.supportGrade === 'U') evidenceLine = HONESTY.noEvidence
  else if (quotes.length === 0) evidenceLine = HONESTY.notChecked
  else evidenceLine = quotes.join('; ')
  if (noneFound.length > 0)
    evidenceLine += `${evidenceLine === HONESTY.notChecked ? '' : ';'} ${HONESTY.notFound}: ${noneFound.join(', ')}`
  lines.push(`- evidence: ${evidenceLine}`)
  lines.push(`- reasoning summary: ${assessment.rationale.join('; ') || HONESTY.notChecked}`)
  for (const argument of input.snapshot.arguments.filter((a) => a.conclusionClaimId === assessment.claimId)) {
    const premises = argument.premiseClaimIds.map((id) => {
      const c = input.snapshot.claims.find((c) => c.id === id)
      const a = input.assessments.find((a) => a.claimId === id)
      return `${escape(c?.text ?? id)} [${a?.supportGrade ?? 'not checked'}]`
    })
    lines.push(`  - premises: ${premises.join('; ') || 'direct evidence group'}`)
    lines.push(`  - warrant (${argument.scheme}): ${escape(argument.warrant)}`)
    if (argument.assumptions.length) lines.push(`  - assumptions: ${escape(argument.assumptions.join('; '))}`)
    if (argument.limitations.length) lines.push(`  - inference limits: ${escape(argument.limitations.join('; '))}`)
  }
  const competing = issues
    .map((issue) => `${issue.kind} (${issue.resolution}): ${escape(issue.description)}`)
    .join('; ')
  lines.push(`- competing explanations / counter-evidence: ${competing || HONESTY.notChecked}`)
  lines.push(
    `- missing evidence: ${gaps.map((issue) => `needed: ${escape(issue.gap!.needed)}; if unresolved: ${escape(issue.gap!.ifUnresolved)}`).join('; ') || HONESTY.noGap}`,
  )
  lines.push(
    `- next steps: ${gaps.map((i) => escape(i.gap!.nextAction)).join('; ') || (assessment.reviewState === 'current' ? 'No pending action registered; reassess if the material changes.' : `Complete review for ${assessment.claimId} (${assessment.reviewState}).`)}`,
  )
  lines.push(
    `- limits of applicability: ${claim?.scope.exclusions.length ? escape(claim.scope.exclusions.join('; ')) : HONESTY.notChecked}`,
  )
  lines.push(`- reviewer / rule version: ${POLICY_VERSION} / ${RUBRIC_VERSION}`)
  lines.push('')
  return lines
}

function appendDisputes(lines: string[], input: ReportInput): void {
  const order = { decisive: 0, material: 1, 'not-checked': 2, 'none-found': 3 } as const
  const disputes = input.assessments
    .filter((assessment) => assessment.disposition === 'contested' || assessment.disposition === 'refuted')
    .sort((a, b) => order[a.opposition] - order[b.opposition])
  if (disputes.length === 0 && input.findings.length === 0) {
    lines.push(HONESTY.noGap, '')
    return
  }
  for (const dispute of disputes) {
    lines.push(
      `- ${dispute.claimId}: ${dispute.disposition} (opposition: ${dispute.opposition}, grade ${dispute.supportGrade})`,
    )
  }
  for (const finding of input.findings) {
    const adjudication = input.adjudications.find((a) => a.findingId === finding.id)
    const note =
      adjudication?.decision === 'reject'
        ? '; human-rejected, historical'
        : adjudication
          ? `; human-accepted (prevailing run ${adjudication.overrides.runId}` +
            `${adjudication.overrides.supersededRunId ? `, ~~run ${adjudication.overrides.supersededRunId} superseded — verdict retained for audit~~` : ''})`
          : ''
    lines.push(
      `- finding ${finding.code} (${finding.severity}${note}) on ${finding.targetIds.join(', ') || 'artifact'}: ${escape(finding.explanation)}`,
    )
  }
  lines.push('')
}

function appendDeferredDisagreements(lines: string[], input: ReportInput): void {
  const deferred = input.deferredDisagreements ?? []
  if (deferred.length === 0) return
  lines.push('### Pending adjudication (machine-deferred)', '')
  lines.push(`machine-deferred: ${deferred.length} pending`, '')
  for (const entry of deferred) {
    const conflicts = (entry.conflicts ?? [])
      .map((conflict) => `run ${conflict.runId} = ${conflict.verdict}`)
      .join(', ')
    lines.push(
      `- finding ${entry.id} on ${entry.targetIds.join(', ') || 'artifact'}${entry.runId ? ` (detected by run ${entry.runId})` : ''}: ` +
        `${conflicts || 'conflicting verdicts not readable from the selected records'}. ` +
        `Pending human adjudication (/vwa adjudicate ${entry.targetIds[0] ?? '<target>'} ...).`,
    )
  }
  lines.push('')
}

function appendSources(lines: string[], input: ReportInput): void {
  for (const source of input.snapshot.sources) {
    lines.push(
      `- ${source.id}: "${escape(source.title)}" (${source.publication}, ${source.originalLocator}) — snapshot hash ${source.snapshotHash.slice(0, 12)}…, acquisition ${source.acquisition.kind}${source.origin === 'user-provided' ? ` (${HONESTY.externallyClaimed})` : ''}, lineage ${source.lineage.relation}${source.lineage.parentSourceIds.length ? ` from ${source.lineage.parentSourceIds.join(', ')}` : ''}`,
    )
  }
  if (input.snapshot.sources.length === 0) lines.push(`- ${HONESTY.noEvidence}`)
  const inaccessible = input.snapshot.searches.flatMap((search) => search.inaccessible)
  lines.push(
    `- inaccessible materials: ${inaccessible.length > 0 ? escape(inaccessible.join('; ')) : HONESTY.notChecked}`,
  )
  lines.push('')
}

function appendConfiguration(lines: string[], input: ReportInput): void {
  lines.push(
    `- review configuration: rubric ${RUBRIC_VERSION}, mode ${input.snapshot.contract.mode}, model ${input.cost.modelId}${input.cost.modelId === 'unpinned' ? ' (model version not pinned)' : ''}`,
  )
  lines.push(
    `- cost: calls ${input.cost.calls}, input tokens ${input.cost.inputTokens}, output tokens ${input.cost.outputTokens}`,
  )
  for (const adjudication of input.adjudications) {
    const superseded = adjudication.overrides.supersededRunId
      ? `; superseded run ${adjudication.overrides.supersededRunId} (same-slot verdict struck through, retained)`
      : ''
    lines.push(
      `- human adjudication ${adjudication.adjudicationId}: ${adjudication.decision} of finding ${adjudication.findingId} — ${escape(adjudication.reason)}${superseded}`,
    )
  }
  lines.push(
    `- binding hashes: artifact ${input.artifactHash.slice(0, 12)}…, binding digest ${input.bindingDigest.slice(0, 12)}…`,
  )
  lines.push(
    `- ${HONESTY.checksCompleted}. Receipt, delivery, and signature status are provided by the separate delivery summary and are not written back into this report.`,
  )
  if (input.hasLegacyReceipt && !input.hasV2Receipt)
    lines.push(`- legacy receipts: ${HONESTY.legacy}; semantic guarantees are not upgraded.`)
  lines.push('')
}

/** §19 JSON variant: the same input, stableJson (deterministic). */
export function renderReportJson(input: ReportInput): string {
  return stableJson({ ...input, template: REPORT_TEMPLATE, honesty: HONESTY })
}

/** Verdict of one layer from the records of its stage family (§17.1). */
export function stageVerdict(records: ReviewRecord[], stages: string[]): Verdict {
  const relevant = records.filter(
    (record): record is import('./types.ts').SemanticReviewRecord =>
      record.stage !== 'extract' && stages.includes(record.stage),
  )
  if (relevant.length === 0) return 'not-run'
  if (
    relevant.some(
      (record) =>
        record.response?.targets?.some((t) => t.checks.some((c) => c.result === 'fail')) ||
        record.response?.findings?.some((f) => f.code !== 'REVIEWER_DISAGREEMENT' && f.severity !== 'minor'),
    )
  )
    return 'fail'
  if (
    relevant.some(
      (record) =>
        record.status !== 'completed' ||
        record.response?.targets?.some((t) =>
          t.checks.some((c) => c.result === 'needs-review' || c.result === 'not-run'),
        ) ||
        record.response?.findings?.some((f) => f.code === 'REVIEWER_DISAGREEMENT'),
    )
  )
    return 'needs-review'
  if (relevant.every((record) => record.status === 'completed')) return 'pass'
  return 'needs-review'
}

export function reportHashOf(text: string): Hash {
  return sha256Hex(text)
}
