/** Review and proposal validators (plan §5.5, §5.6). */

import {
  CATEGORIES,
  CHANGE_TYPES,
  DISPOSITIONS,
  EVIDENCE_MODES,
  FINDING_STATUSES,
  LANGUAGE_INTENTS,
  LANGUAGES,
  MECHANICAL_STATUSES,
  OPERATIONS,
  OUTCOMES,
  PHASES,
  PROFILES,
  PROPOSAL_INTENTS,
  PURPOSES,
  QUESTION_ID_RE,
  SECTION_ID_RE,
  SEMANTIC_STATUSES,
  SEVERITIES,
  SOURCE_ID_RE,
  STAGES,
  invalid,
  mapArray,
  readArray,
  readBoolean,
  readEnum,
  readHash,
  readIdPattern,
  readInteger,
  readIso,
  readLiteral,
  readObject,
  readString,
  readStringArray,
  readUnique,
  readUuid,
  validate,
} from './schema.lib.mjs'

// -------------------------------------------------------------------- review

export function validateReview(input) {
  return validate(() => {
    const o = readObject(input, 'review', [
      'schemaVersion',
      'kind',
      'id',
      'runId',
      'stage',
      'bodyHash',
      'beforeHash',
      'planHash',
      'coverage',
      'coverageRanges',
      'crossSectionConsistency',
      'reverseOutline',
      'findings',
    ])
    const stage = readEnum(o.stage, 'review.stage', STAGES)
    const beforeHash = readHash(o.beforeHash, 'review.beforeHash', { nullable: true })
    // Structure and language reviews compare against the plan, never a pre-language body.
    if (stage === 'semantics') {
      if (beforeHash === null) invalid('review.beforeHash: required for a semantics review')
    } else if (beforeHash !== null) {
      invalid(`review.beforeHash: must be null for a ${stage} review`)
    }
    const coverageRanges = mapArray(o.coverageRanges, 'review.coverageRanges', (entry, path) => {
      const r = readObject(entry, path, ['start', 'end'])
      const start = readInteger(r.start, `${path}.start`)
      const end = readInteger(r.end, `${path}.end`)
      if (end <= start) invalid(`${path}: end must be greater than start`)
      return { start, end }
    })
    coverageRanges.forEach((range, index) => {
      if (index > 0 && range.start < coverageRanges[index - 1].end) {
        invalid(`review.coverageRanges[${index}]: ranges must be ordered and nonoverlapping`)
      }
    })
    const reverseOutline = mapArray(o.reverseOutline, 'review.reverseOutline', (entry, path) => {
      const r = readObject(entry, path, ['start', 'end', 'quote', 'summary', 'role', 'sectionId'])
      const start = readInteger(r.start, `${path}.start`)
      const end = readInteger(r.end, `${path}.end`)
      if (end < start) invalid(`${path}: end must be >= start`)
      return {
        start,
        end,
        quote: readString(r.quote, `${path}.quote`),
        summary: readString(r.summary, `${path}.summary`),
        role: readString(r.role, `${path}.role`),
        sectionId:
          r.sectionId === null
            ? null
            : readIdPattern(r.sectionId, `${path}.sectionId`, SECTION_ID_RE, 's[1-9][0-9]*'),
      }
    })
    const findings = mapArray(o.findings, 'review.findings', (entry, path) => {
      const f = readObject(entry, path, [
        'id',
        'category',
        'severity',
        'start',
        'end',
        'quote',
        'explanation',
        'suggestedAction',
        'protectedMeaning',
        'status',
        'resolution',
      ])
      const start = readInteger(f.start, `${path}.start`)
      const end = readInteger(f.end, `${path}.end`)
      if (end < start) invalid(`${path}: end must be >= start`)
      const status = readEnum(f.status, `${path}.status`, FINDING_STATUSES)
      const resolution = readString(f.resolution, `${path}.resolution`, { nullable: true })
      if (status === 'rejected' && resolution === null) invalid(`${path}.resolution: required when status is rejected`)
      if (status === 'open' && resolution !== null) invalid(`${path}.resolution: must be null when status is open`)
      return {
        id: readUuid(f.id, `${path}.id`),
        category: readEnum(f.category, `${path}.category`, CATEGORIES),
        severity: readEnum(f.severity, `${path}.severity`, SEVERITIES),
        start,
        end,
        quote: readString(f.quote, `${path}.quote`, { nonempty: false }),
        explanation: readString(f.explanation, `${path}.explanation`),
        suggestedAction: readString(f.suggestedAction, `${path}.suggestedAction`),
        protectedMeaning: readStringArray(f.protectedMeaning, `${path}.protectedMeaning`),
        status,
        resolution,
      }
    })
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'review.schemaVersion', 1),
      kind: readLiteral(o.kind, 'review.kind', 'review'),
      id: readUuid(o.id, 'review.id'),
      runId: readUuid(o.runId, 'review.runId'),
      stage,
      bodyHash: readHash(o.bodyHash, 'review.bodyHash'),
      beforeHash,
      planHash: readHash(o.planHash, 'review.planHash', { nullable: true }),
      coverage: readEnum(o.coverage, 'review.coverage', ['complete', 'partial']),
      coverageRanges,
      crossSectionConsistency: readBoolean(o.crossSectionConsistency, 'review.crossSectionConsistency'),
      reverseOutline,
      findings,
    }
  })
}

// ------------------------------------------------------------------ proposal

export function validateProposal(input) {
  return validate(() => {
    const o = readObject(input, 'proposal', ['schemaVersion', 'kind', 'id', 'runId', 'bodyHash', 'findingIds', 'intent', 'edits'])
    const findingIds = mapArray(o.findingIds, 'proposal.findingIds', (entry, path) => readUuid(entry, path))
    readUnique(findingIds, 'proposal.findingIds', 'finding id')
    const edits = mapArray(o.edits, 'proposal.edits', (entry, path) => {
      const e = readObject(entry, path, ['start', 'end', 'before', 'after', 'reason'])
      const start = readInteger(e.start, `${path}.start`)
      const end = readInteger(e.end, `${path}.end`)
      if (end < start) invalid(`${path}: end must be >= start`)
      const before = readString(e.before, `${path}.before`, { nonempty: false })
      const insertion = start === end
      if (insertion && before !== '') invalid(`${path}.before: an insertion has start=end and before=""`)
      if (!insertion && before === '') invalid(`${path}.before: a replacement or deletion needs nonempty before`)
      return { start, end, before, after: readString(e.after, `${path}.after`, { nonempty: false }), reason: readString(e.reason, `${path}.reason`) }
    })
    const ordered = [...edits].sort((a, b) => a.start - b.start)
    const insertionOffsets = new Set()
    ordered.forEach((edit, index) => {
      if (edit.start === edit.end) {
        if (insertionOffsets.has(edit.start)) invalid(`proposal.edits: duplicate insertion at offset ${edit.start}`)
        insertionOffsets.add(edit.start)
      }
      if (index > 0 && edit.start < ordered[index - 1].end) {
        invalid(`proposal.edits: edits overlap at offset ${edit.start}`)
      }
    })
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'proposal.schemaVersion', 1),
      kind: readLiteral(o.kind, 'proposal.kind', 'proposal'),
      id: readUuid(o.id, 'proposal.id'),
      runId: readUuid(o.runId, 'proposal.runId'),
      bodyHash: readHash(o.bodyHash, 'proposal.bodyHash'),
      findingIds,
      intent: readEnum(o.intent, 'proposal.intent', PROPOSAL_INTENTS),
      edits,
    }
  })
}

