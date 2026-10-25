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

// --------------------------------------------------------------------- check

export function validateCheck(input) {
  return validate(() => {
    const o = readObject(input, 'check', [
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
    ])
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
    return {
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
  })
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
    const o = readObject(input, 'profile', ['schemaVersion', 'id', 'description', 'applicableLanguages', 'rules', 'protectedTerms'])
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
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'profile.schemaVersion', 1),
      id: readString(o.id, 'profile.id'),
      description: readString(o.description, 'profile.description'),
      applicableLanguages: readStringArray(o.applicableLanguages, 'profile.applicableLanguages'),
      rules,
      protectedTerms: readStringArray(o.protectedTerms, 'profile.protectedTerms'),
    }
  })
}
