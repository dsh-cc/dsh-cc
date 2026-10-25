/** Brief and run metadata validators (plan §5.2, §5.3). */

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
  isPlainObject,
  validate,
} from './schema.lib.mjs'

// --------------------------------------------------------------------- brief

const BRIEF_FIELDS = [
  'schemaVersion',
  'kind',
  'runId',
  'operation',
  'question',
  'audience',
  'language',
  'bodyPath',
  'companionPath',
  'profile',
  'targetLength',
  'requiredQuestions',
  'sourceScope',
  'evidenceMode',
  'allowBodyChanges',
  'repairRounds',
  'protectedTerms',
  'styleOverrides',
  'defaultsApplied',
]

export function validateBrief(input) {
  return validate(() => {
    const o = readObject(input, 'brief', BRIEF_FIELDS)
    const scope = readObject(o.sourceScope, 'brief.sourceScope', ['localPaths', 'webAllowed', 'description'])
    const targetLength =
      o.targetLength === null
        ? null
        : (() => {
            const t = readObject(o.targetLength, 'brief.targetLength', ['min', 'max'])
            const min = readInteger(t.min, 'brief.targetLength.min', { min: 1 })
            const max = readInteger(t.max, 'brief.targetLength.max', { min: 1 })
            if (min > max) invalid('brief.targetLength: min must be <= max')
            return { min, max }
          })()
    const requiredQuestions = mapArray(o.requiredQuestions, 'brief.requiredQuestions', (entry, path) => {
      const q = readObject(entry, path, ['id', 'text'])
      return {
        id: readIdPattern(q.id, `${path}.id`, QUESTION_ID_RE, 'q[1-9][0-9]*'),
        text: readString(q.text, `${path}.text`),
      }
    })
    readUnique(
      requiredQuestions.map((q) => q.id),
      'brief.requiredQuestions',
      'id',
    )
    if (!requiredQuestions.some((q) => q.id === 'q1')) invalid('brief.requiredQuestions: q1 is required')
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'brief.schemaVersion', 1),
      kind: readLiteral(o.kind, 'brief.kind', 'brief'),
      runId: readUuid(o.runId, 'brief.runId'),
      operation: readEnum(o.operation, 'brief.operation', OPERATIONS),
      question: readString(o.question, 'brief.question'),
      audience: readString(o.audience, 'brief.audience'),
      language: readEnum(o.language, 'brief.language', LANGUAGES),
      bodyPath: readString(o.bodyPath, 'brief.bodyPath'),
      companionPath: readString(o.companionPath, 'brief.companionPath'),
      profile: readEnum(o.profile, 'brief.profile', PROFILES),
      targetLength,
      requiredQuestions,
      sourceScope: {
        localPaths: readStringArray(scope.localPaths, 'brief.sourceScope.localPaths'),
        webAllowed: readBoolean(scope.webAllowed, 'brief.sourceScope.webAllowed'),
        description: readString(scope.description, 'brief.sourceScope.description'),
      },
      evidenceMode: readEnum(o.evidenceMode, 'brief.evidenceMode', EVIDENCE_MODES),
      allowBodyChanges: readBoolean(o.allowBodyChanges, 'brief.allowBodyChanges'),
      repairRounds: readInteger(o.repairRounds, 'brief.repairRounds', { min: 0, max: 3 }),
      protectedTerms: readStringArray(o.protectedTerms, 'brief.protectedTerms'),
      styleOverrides: readStringArray(o.styleOverrides, 'brief.styleOverrides'),
      defaultsApplied: readStringArray(o.defaultsApplied, 'brief.defaultsApplied'),
    }
  })
}

// ----------------------------------------------------------------------- run

const RUN_FIELDS = [
  'schemaVersion',
  'kind',
  'runId',
  'briefHash',
  'phase',
  'outcome',
  'bodyHash',
  'planHash',
  'replaceExisting',
  'structuralRound',
  'languagePass',
  'languageIntentsUsed',
  'semanticRepairUsed',
  'acceptedBodyHash',
  'appliedProposals',
  'artifactPaths',
  'vwa',
  'usage',
  'createdAt',
  'updatedAt',
  'model',
]

/** repairRounds comes from the brief; the default covers the widest legal brief (3). */
export function validateRun(input, { repairRounds = 3 } = {}) {
  return validate(() => {
    const o = readObject(input, 'run', RUN_FIELDS)
    const appliedProposals = mapArray(o.appliedProposals, 'run.appliedProposals', (entry, path) => {
      const p = readObject(entry, path, ['proposalId', 'intent', 'beforeHash', 'afterHash', 'appliedAt'])
      return {
        proposalId: readUuid(p.proposalId, `${path}.proposalId`),
        intent: readEnum(p.intent, `${path}.intent`, PROPOSAL_INTENTS),
        beforeHash: readHash(p.beforeHash, `${path}.beforeHash`),
        afterHash: readHash(p.afterHash, `${path}.afterHash`),
        appliedAt: readIso(p.appliedAt, `${path}.appliedAt`),
      }
    })
    const artifactPaths = mapArray(o.artifactPaths, 'run.artifactPaths', (entry, path) => {
      const a = readObject(entry, path, ['path', 'hash', 'kind'])
      return {
        path: readString(a.path, `${path}.path`),
        hash: readHash(a.hash, `${path}.hash`),
        kind: readString(a.kind, `${path}.kind`),
      }
    })
    const languageIntentsUsed = mapArray(o.languageIntentsUsed, 'run.languageIntentsUsed', (entry, path) =>
      readEnum(entry, path, LANGUAGE_INTENTS),
    )
    readUnique(languageIntentsUsed, 'run.languageIntentsUsed', 'intent')
    const languagePass = readInteger(o.languagePass, 'run.languagePass', { min: 0, max: 2 })
    if (languageIntentsUsed.length > languagePass) {
      invalid('run.languageIntentsUsed: cannot list more intents than applied language passes')
    }
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'run.schemaVersion', 1),
      kind: readLiteral(o.kind, 'run.kind', 'run'),
      runId: readUuid(o.runId, 'run.runId'),
      briefHash: readHash(o.briefHash, 'run.briefHash'),
      phase: readEnum(o.phase, 'run.phase', PHASES),
      outcome: readEnum(o.outcome, 'run.outcome', OUTCOMES),
      bodyHash: readHash(o.bodyHash, 'run.bodyHash', { nullable: true }),
      planHash: readHash(o.planHash, 'run.planHash', { nullable: true }),
      replaceExisting: readBoolean(o.replaceExisting, 'run.replaceExisting'),
      structuralRound: readInteger(o.structuralRound, 'run.structuralRound', { min: 0, max: repairRounds }),
      languagePass,
      languageIntentsUsed,
      semanticRepairUsed: readBoolean(o.semanticRepairUsed, 'run.semanticRepairUsed'),
      // Spec §5.3 does not list this field as nullable: a baseline hash is always recorded.
      acceptedBodyHash: readHash(o.acceptedBodyHash, 'run.acceptedBodyHash'),
      appliedProposals,
      artifactPaths,
      vwa:
        o.vwa === null
          ? null
          : (() => {
              const v = readObject(o.vwa, 'run.vwa', [
                'projectId',
                'authorRevision',
                'artifactId',
                'runId',
                'taskId',
                'reportPath',
              ])
              return {
                projectId: readString(v.projectId, 'run.vwa.projectId'),
                authorRevision: readInteger(v.authorRevision, 'run.vwa.authorRevision'),
                artifactId: readString(v.artifactId, 'run.vwa.artifactId', { nullable: true }),
                runId: readString(v.runId, 'run.vwa.runId', { nullable: true }),
                taskId: readString(v.taskId, 'run.vwa.taskId', { nullable: true }),
                reportPath: readString(v.reportPath, 'run.vwa.reportPath', { nullable: true }),
              }
            })(),
      // Host-exposed usage fields are opaque; only the object envelope is checked.
      usage:
        o.usage === null
          ? null
          : (() => {
              if (!isPlainObject(o.usage)) invalid('run.usage: expected an object or null')
              return o.usage
            })(),
      createdAt: readIso(o.createdAt, 'run.createdAt'),
      updatedAt: readIso(o.updatedAt, 'run.updatedAt'),
      model: readString(o.model, 'run.model', { nullable: true }),
    }
  })
}

