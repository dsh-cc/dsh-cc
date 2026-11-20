/** Check, application, and profile validators (plan §5.5, §5.6, §9). */

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
  OPENING_PATTERNS,
  OUTCOMES,
  OUTLINE_STATUSES,
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

// --------------------------------------------------------------------- check

export function validateCheck(input) {
  return validate(() => {
    const o = readObject(
      input,
      'check',
      [
        'schemaVersion',
        'kind',
        'id',
        'runId',
        'beforeHash',
        'afterHash',
        'mechanicalStatus',
        'semanticStatus',
        'changes',
        'semanticReviewId',
      ],
      ['outline'],
    )
    const changes = mapArray(o.changes, 'check.changes', (entry, path) => {
      const c = readObject(entry, path, ['type', 'before', 'after', 'disposition', 'reason'])
      const disposition = readEnum(c.disposition, `${path}.disposition`, DISPOSITIONS)
      const reason = readString(c.reason, `${path}.reason`, { nullable: true })
      if (disposition !== 'pending' && reason === null) {
        invalid(`${path}.reason: required for a ${disposition} disposition`)
      }
      if (disposition === 'pending' && reason !== null) invalid(`${path}.reason: must be null while pending`)
      return {
        type: readEnum(c.type, `${path}.type`, CHANGE_TYPES),
        before: readStringArray(c.before, `${path}.before`),
        after: readStringArray(c.after, `${path}.after`),
        disposition,
        reason,
      }
    })
    const check = {
      schemaVersion: readLiteral(o.schemaVersion, 'check.schemaVersion', 1),
      kind: readLiteral(o.kind, 'check.kind', 'check'),
      id: readUuid(o.id, 'check.id'),
      runId: readUuid(o.runId, 'check.runId'),
      beforeHash: readHash(o.beforeHash, 'check.beforeHash'),
      afterHash: readHash(o.afterHash, 'check.afterHash'),
      mechanicalStatus: readEnum(o.mechanicalStatus, 'check.mechanicalStatus', MECHANICAL_STATUSES),
      semanticStatus: readEnum(o.semanticStatus, 'check.semanticStatus', SEMANTIC_STATUSES),
      changes,
      semanticReviewId:
        o.semanticReviewId === null ? null : readUuid(o.semanticReviewId, 'check.semanticReviewId'),
    }
    // Optional: old and profile-less runs carry no outline (design §6).
    if (o.outline !== undefined) check.outline = validateOutline(o.outline)
    return check
  })
}

/** Mechanical outline verdict: a pure function of the after body (design §6). */
function validateOutline(input) {
  const o = readObject(input, 'check.outline', ['status', 'missingRequiredSections', 'orderViolations'])
  return {
    status: readEnum(o.status, 'check.outline.status', OUTLINE_STATUSES),
    missingRequiredSections: readStringArray(o.missingRequiredSections, 'check.outline.missingRequiredSections'),
    orderViolations: mapArray(o.orderViolations, 'check.outline.orderViolations', (entry, path) => {
      const v = readObject(entry, path, ['section', 'declaredOrder', 'actualOrder'])
      return {
        section: readString(v.section, `${path}.section`),
        declaredOrder: readInteger(v.declaredOrder, `${path}.declaredOrder`, { min: 1 }),
        actualOrder: readInteger(v.actualOrder, `${path}.actualOrder`, { min: 1 }),
      }
    }),
  }
}

// --------------------------------------------------------------- application

export function validateApplication(input) {
  return validate(() => {
    const o = readObject(input, 'application', [
      'schemaVersion',
      'kind',
      'id',
      'runId',
      'proposalId',
      'intent',
      'beforeHash',
      'afterHash',
      'appliedAt',
    ])
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'application.schemaVersion', 1),
      kind: readLiteral(o.kind, 'application.kind', 'application'),
      id: readUuid(o.id, 'application.id'),
      runId: readUuid(o.runId, 'application.runId'),
      proposalId: readUuid(o.proposalId, 'application.proposalId'),
      intent: readEnum(o.intent, 'application.intent', PROPOSAL_INTENTS),
      beforeHash: readHash(o.beforeHash, 'application.beforeHash'),
      afterHash: readHash(o.afterHash, 'application.afterHash'),
      appliedAt: readIso(o.appliedAt, 'application.appliedAt'),
    }
  })
}

// ------------------------------------------------------------------- profile

export function validateProfile(input) {
  return validate(() => {
    const o = readObject(
      input,
      'profile',
      ['schemaVersion', 'id', 'description', 'applicableLanguages', 'rules', 'protectedTerms'],
      ['structure'],
    )
    const rules = mapArray(o.rules, 'profile.rules', (entry, path) => {
      const r = readObject(entry, path, ['id', 'instruction', 'rationale', 'severity'])
      return {
        id: readString(r.id, `${path}.id`),
        instruction: readString(r.instruction, `${path}.instruction`),
        rationale: readString(r.rationale, `${path}.rationale`),
        severity: readEnum(r.severity, `${path}.severity`, ['advisory', 'required']),
      }
    })
    readUnique(
      rules.map((r) => r.id),
      'profile.rules',
      'rule id',
    )
    const profile = {
      schemaVersion: readLiteral(o.schemaVersion, 'profile.schemaVersion', 1),
      id: readString(o.id, 'profile.id'),
      description: readString(o.description, 'profile.description'),
      applicableLanguages: readStringArray(o.applicableLanguages, 'profile.applicableLanguages'),
      rules,
      protectedTerms: readStringArray(o.protectedTerms, 'profile.protectedTerms'),
    }
    // Optional skeleton; profiles without it behave exactly as before (design §6).
    if (o.structure !== undefined) profile.structure = validateStructure(o.structure)
    return profile
  })
}

/** Optional document skeleton: ordered section hints plus an opening pattern. */
function validateStructure(input) {
  const o = readObject(input, 'profile.structure', ['sections'], ['openingPattern', 'audienceVariantNote'])
  const sections = mapArray(o.sections, 'profile.structure.sections', (entry, path) => {
    const s = readObject(entry, path, ['id', 'headingHint', 'required', 'order'])
    return {
      id: readString(s.id, `${path}.id`),
      headingHint: readString(s.headingHint, `${path}.headingHint`),
      required: readBoolean(s.required, `${path}.required`),
      order: readInteger(s.order, `${path}.order`, { min: 1 }),
    }
  })
  readUnique(
    sections.map((section) => section.id),
    'profile.structure.sections',
    'section id',
  )
  let previous = 0
  sections.forEach((section, index) => {
    const increasing = index === 0 ? section.order === 1 : section.order > previous
    if (!increasing) {
      invalid(
        `profile.structure.sections: order must start at 1 and strictly increase (section "${section.id}" declares ${section.order})`,
      )
    }
    previous = section.order
  })
  const structure = {}
  if (o.openingPattern !== undefined) {
    structure.openingPattern = readEnum(o.openingPattern, 'profile.structure.openingPattern', OPENING_PATTERNS)
  }
  structure.sections = sections
  if (o.audienceVariantNote !== undefined) {
    structure.audienceVariantNote = readString(o.audienceVariantNote, 'profile.structure.audienceVariantNote')
  }
  return structure
}
