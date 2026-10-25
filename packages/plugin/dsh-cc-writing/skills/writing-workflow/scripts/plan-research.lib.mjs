/** Plan, research, and context validators (plan §5.4). */

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

// ---------------------------------------------------------------------- plan

const SECTION_FIELDS = [
  'id',
  'title',
  'questionIds',
  'purpose',
  'claim',
  'premises',
  'assumptions',
  'evidenceRefs',
  'dependsOn',
  'readerTakeaway',
  'lengthWeight',
]

export function validatePlan(input) {
  return validate(() => {
    const o = readObject(input, 'plan', ['schemaVersion', 'kind', 'runId', 'descriptive', 'thesis', 'questions', 'sections'])
    const questions = mapArray(o.questions, 'plan.questions', (entry, path) =>
      readIdPattern(entry, path, QUESTION_ID_RE, 'q[1-9][0-9]*'),
    )
    readUnique(questions, 'plan.questions', 'question id')
    const questionSet = new Set(questions)
    const sections = mapArray(o.sections, 'plan.sections', (entry, path) => {
      const s = readObject(entry, path, SECTION_FIELDS)
      const questionIds = mapArray(s.questionIds, `${path}.questionIds`, (id, at) =>
        readIdPattern(id, at, QUESTION_ID_RE, 'q[1-9][0-9]*'),
      )
      readUnique(questionIds, `${path}.questionIds`, 'question id')
      for (const id of questionIds) {
        if (!questionSet.has(id)) invalid(`${path}.questionIds: "${id}" is not listed in plan.questions`)
      }
      return {
        id: readIdPattern(s.id, `${path}.id`, SECTION_ID_RE, 's[1-9][0-9]*'),
        title: readString(s.title, `${path}.title`),
        questionIds,
        purpose: readEnum(s.purpose, `${path}.purpose`, PURPOSES),
        claim: readString(s.claim, `${path}.claim`),
        premises: readStringArray(s.premises, `${path}.premises`),
        assumptions: readStringArray(s.assumptions, `${path}.assumptions`),
        evidenceRefs: readStringArray(s.evidenceRefs, `${path}.evidenceRefs`),
        dependsOn: mapArray(s.dependsOn, `${path}.dependsOn`, (id, at) =>
          readIdPattern(id, at, SECTION_ID_RE, 's[1-9][0-9]*'),
        ),
        readerTakeaway: readString(s.readerTakeaway, `${path}.readerTakeaway`),
        lengthWeight: readInteger(s.lengthWeight, `${path}.lengthWeight`, { min: 1, max: 100 }),
      }
    })
    readArray(sections, 'plan.sections')
    if (sections.length === 0) invalid('plan.sections: expected at least one section')
    const sectionIds = readUnique(
      sections.map((s) => s.id),
      'plan.sections',
      'section id',
    )
    // Earlier-only dependencies also make the graph acyclic by construction.
    sections.forEach((section, index) => {
      for (const dependency of section.dependsOn) {
        if (!sectionIds.slice(0, index).includes(dependency)) {
          invalid(`plan.sections[${index}].dependsOn: "${dependency}" must reference an earlier section`)
        }
      }
    })
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'plan.schemaVersion', 1),
      kind: readLiteral(o.kind, 'plan.kind', 'plan'),
      runId: readUuid(o.runId, 'plan.runId'),
      descriptive: readBoolean(o.descriptive, 'plan.descriptive'),
      thesis: readString(o.thesis, 'plan.thesis'),
      questions,
      sections,
    }
  })
}

// ------------------------------------------------------------------ research

export function validateResearch(input) {
  return validate(() => {
    const o = readObject(input, 'research', ['schemaVersion', 'kind', 'runId', 'questions', 'sources', 'searches'])
    const questions = mapArray(o.questions, 'research.questions', (entry, path) => {
      const q = readObject(entry, path, ['id', 'answer', 'evidenceRefs', 'gaps'])
      return {
        id: readString(q.id, `${path}.id`),
        answer: readString(q.answer, `${path}.answer`),
        evidenceRefs: readStringArray(q.evidenceRefs, `${path}.evidenceRefs`),
        gaps: readStringArray(q.gaps, `${path}.gaps`),
      }
    })
    readUnique(
      questions.map((q) => q.id),
      'research.questions',
      'id',
    )
    const sources = mapArray(o.sources, 'research.sources', (entry, path) => {
      const s = readObject(entry, path, ['id', 'path', 'hash', 'origin', 'retrievedAt', 'limitations'])
      return {
        id: readIdPattern(s.id, `${path}.id`, SOURCE_ID_RE, 'src[1-9][0-9]*'),
        path: readString(s.path, `${path}.path`),
        hash: readHash(s.hash, `${path}.hash`),
        origin: readEnum(s.origin, `${path}.origin`, ['local', 'web']),
        retrievedAt: readIso(s.retrievedAt, `${path}.retrievedAt`, { nullable: true }),
        limitations: readStringArray(s.limitations, `${path}.limitations`),
      }
    })
    const sourceIds = readUnique(
      sources.map((s) => s.id),
      'research.sources',
      'source id',
    )
    const sourceIdSet = new Set(sourceIds)
    const searches = mapArray(o.searches, 'research.searches', (entry, path) => {
      const s = readObject(entry, path, ['query', 'scope', 'outcome', 'sourceIds'])
      const ids = mapArray(s.sourceIds, `${path}.sourceIds`, (id, at) => readString(id, at))
      for (const id of ids) {
        if (!sourceIdSet.has(id)) invalid(`${path}.sourceIds: "${id}" is not a listed source`)
      }
      return {
        query: readString(s.query, `${path}.query`),
        scope: readString(s.scope, `${path}.scope`),
        outcome: readEnum(s.outcome, `${path}.outcome`, ['found', 'not-found', 'error']),
        sourceIds: ids,
      }
    })
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'research.schemaVersion', 1),
      kind: readLiteral(o.kind, 'research.kind', 'research'),
      runId: readUuid(o.runId, 'research.runId'),
      questions,
      sources,
      searches,
    }
  })
}

// ------------------------------------------------------------------- context

export function validateContext(input) {
  return validate(() => {
    const o = readObject(input, 'context', ['schemaVersion', 'kind', 'runId', 'planHash', 'sections'])
    const sections = mapArray(o.sections, 'context.sections', (entry, path) => {
      const s = readObject(entry, path, ['sectionId', 'actualSummary', 'establishedClaims', 'openQuestions'])
      return {
        sectionId: readIdPattern(s.sectionId, `${path}.sectionId`, SECTION_ID_RE, 's[1-9][0-9]*'),
        actualSummary: readString(s.actualSummary, `${path}.actualSummary`),
        establishedClaims: readStringArray(s.establishedClaims, `${path}.establishedClaims`),
        openQuestions: readStringArray(s.openQuestions, `${path}.openQuestions`),
      }
    })
    // "one entry per plan section id" is checked by the caller that holds the plan.
    readUnique(
      sections.map((s) => s.sectionId),
      'context.sections',
      'sectionId',
    )
    return {
      schemaVersion: readLiteral(o.schemaVersion, 'context.schemaVersion', 1),
      kind: readLiteral(o.kind, 'context.kind', 'context'),
      runId: readUuid(o.runId, 'context.runId'),
      planHash: readHash(o.planHash, 'context.planHash'),
      sections,
    }
  })
}

