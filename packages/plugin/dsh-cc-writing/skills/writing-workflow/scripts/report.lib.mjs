/**
 * Editorial report rendering (plan §11). Derived data only: it repeats run
 * metadata, hashes, stage coverage, findings, changes, and limitations.
 */

import { join } from 'node:path'
import { atomicWrite } from './files.lib.mjs'
import { currentCheck, currentReviews, projection, runRelative } from './state.lib.mjs'
import { existsSync, readFileSync } from 'node:fs'

const LIMITATIONS = [
  'Mechanical checks establish file identity and preservation properties only; structural and semantic findings remain model judgments.',
  'An agent can edit these local files; they are not tamper-proof evidence receipts.',
  'Chinese numerals, implicit causality, and paraphrased quotation are not detected mechanically.',
]

function list(items, empty = 'None.') {
  return items.length === 0 ? empty : items.map((item) => `- ${item}`).join('\n')
}

function findingLines(reviews) {
  const lines = []
  for (const stage of ['structure', 'language', 'semantics']) {
    const current = reviews[stage]
    if (current === undefined) continue
    for (const finding of current.review.findings) {
      lines.push(
        `[${stage}] ${finding.severity} ${finding.category} (${finding.status}): ${finding.explanation}` +
          (finding.quote === '' ? '' : ` — "${finding.quote}"`) +
          (finding.resolution === null ? '' : ` — resolution: ${finding.resolution}`),
      )
    }
  }
  return lines
}

function changesOf(proposals) {
  const lines = []
  for (const proposal of proposals) {
    if (proposal.intent === 'structure') continue
    lines.push(`${proposal.intent}: ${proposal.edits.length} edit(s)`)
  }
  return lines
}

function loadProposals(ctx) {
  const proposals = []
  for (const entry of ctx.run.artifactPaths) {
    if (entry.kind !== 'proposal') continue
    const abs = join(ctx.runAbs, runRelative(ctx, entry.path))
    if (!existsSync(abs)) continue
    try {
      proposals.push(JSON.parse(readFileSync(abs, 'utf8')))
    } catch {
      /* the report states what it could read; status reports broken artifacts */
    }
  }
  return proposals
}

function vwaLine(ctx) {
  if (ctx.run.vwa === null) return 'VWA evidence review: not performed.'
  const vwa = ctx.run.vwa
  return [
    'VWA evidence review: linked through the VWA adapter; VWA status is owned by the VWA receipts.',
    `- project: ${vwa.projectId}`,
    `- authorRevision: ${vwa.authorRevision}`,
    `- artifactId: ${vwa.artifactId ?? 'null'}`,
    `- review runId: ${vwa.runId ?? 'null'}`,
    `- taskId: ${vwa.taskId ?? 'null'}`,
    `- reportPath: ${vwa.reportPath ?? 'null'}`,
  ].join('\n')
}

function planHash(ctx) {
  const plan = projection(ctx, 'plan')
  return ctx.run.planHash !== null && plan !== null ? ctx.run.planHash : (ctx.run.planHash ?? 'null')
}

/**
 * Render and atomically write editorial-report.md. `outcome` is the report
 * label: checked-no-major-findings, findings-present, incomplete, or blocked.
 */
export function renderReport(ctx, outcome, extra = {}) {
  const { run, brief } = ctx
  const reviews = currentReviews(ctx)
  const check = currentCheck(ctx)
  const proposals = loadProposals(ctx)
  const completedStages = Object.keys(reviews)
  const findings = findingLines(reviews)
  const structural = proposals.filter((proposal) => proposal.intent === 'structure').map((p) => `${p.id}: ${p.edits.length} edit(s)`)
  const rejected = reviews.structure === undefined ? [] : reviews.structure.review.findings.filter((f) => f.status === 'rejected').map((f) => f.explanation)
  const protectedChanges = check === null ? [] : check.changes.map((change) => `${change.type}: ${change.disposition}${change.reason ? ` (${change.reason})` : ''}`)
  const semanticOutcome = check === null ? 'semantic review: not run' : `semantic status: ${check.semanticStatus}`
  const models = run.model === null ? 'Model identifier: not exposed.' : `Model identifier: ${run.model}`
  const usage = run.usage === null ? 'Observed usage: not exposed.' : `Observed usage: \`${JSON.stringify(run.usage)}\``

  const lines = [
    '# Editorial report',
    '',
    `- Editorial outcome: ${outcome}`,
    `- Operation: ${brief.operation}`,
    `- Task: ${brief.question}`,
    `- Audience: ${brief.audience}`,
    `- Language: ${brief.language}`,
    `- Profile: ${brief.profile}`,
    `- Adopted defaults: ${brief.defaultsApplied.length === 0 ? 'none' : brief.defaultsApplied.join('; ')}`,
    `- Run phase: ${run.phase} / outcome: ${run.outcome}`,
    '',
    '## Body identity',
    '',
    `- Body path: \`${brief.bodyPath}\``,
    `- Body SHA-256: \`${run.bodyHash ?? 'null'}\``,
    `- Brief SHA-256: \`${ctx.briefHash}\``,
    `- Plan SHA-256: \`${planHash(ctx)}\``,
    `- Accepted baseline SHA-256: \`${run.acceptedBodyHash}\``,
    '',
    '## Completed stages',
    '',
    list(completedStages.map((stage) => `${stage} review (coverage complete)`), 'No stage reached completion.'),
    '',
    `- Counters: structuralRound ${run.structuralRound}/${brief.repairRounds}, languagePass ${run.languagePass}/2 ` +
      `(${run.languageIntentsUsed.length === 0 ? 'no intents used' : run.languageIntentsUsed.join(', ')}), ` +
      `semanticRepairUsed ${run.semanticRepairUsed}.`,
    '',
    '## Findings',
    '',
    list(findings, 'No recorded findings.'),
    '',
    '## Structural changes',
    '',
    list(structural, 'No structural proposals applied.'),
    '',
    `Rejected suggestions: ${rejected.length === 0 ? 'none.' : rejected.join('; ')}`,
    '',
    '## Language changes',
    '',
    list(changesOf(proposals), 'No language proposals applied.'),
    '',
    '## Protected items and semantics',
    '',
    list(protectedChanges, 'No mechanical differences recorded.'),
    '',
    `- ${semanticOutcome}`,
    '',
    `## Coverage limitations`,
    '',
    list(extra.limitations ?? LIMITATIONS),
    '',
    '## VWA status',
    '',
    vwaLine(ctx),
    '',
    '## Model and usage',
    '',
    `- ${models}`,
    `- ${usage}`,
    '',
  ]
  if (extra.reason) lines.splice(3, 0, `- Reason: ${extra.reason}`)
  const markdown = `${lines.join('\n')}\n`
  const rel = `${ctx.runRel}/editorial-report.md`
  atomicWrite(join(ctx.runAbs, 'editorial-report.md'), Buffer.from(markdown, 'utf8'))
  return { reportPath: rel, outcome }
}
