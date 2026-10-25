/** Strict validator contract tests (plan §5, §12 step 1). */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isIso8601Utc,
  isSha256Hex,
  isUuidV4,
  validateApplication,
  validateBrief,
  validateCheck,
  validateContext,
  validatePlan,
  validateProposal,
  validateProfile,
  validateResearch,
  validateReview,
  validateRun,
} from '../skills/writing-workflow/scripts/contracts.lib.mjs'

const uuid = () => randomUUID()
const hash = (char = 'a') => char.repeat(64)
const clone = <T>(value: T): T => structuredClone(value)

function expectInvalid(result: { ok: boolean }, pattern?: RegExp) {
  expect(result.ok).toBe(false)
  const failure = result as unknown as { code: string; message: string; details: unknown }
  expect(failure.code).toBe('INVALID_INPUT')
  expect(typeof failure.message).toBe('string')
  expect(failure.details).toBeTypeOf('object')
  if (pattern) expect(failure.message).toMatch(pattern)
}

// --------------------------------------------------------------- fixtures

const brief = () => ({
  schemaVersion: 1,
  kind: 'brief',
  runId: uuid(),
  operation: 'write',
  question: 'Why does the cache miss?',
  audience: 'Backend engineers',
  language: 'en',
  bodyPath: 'docs/articles/cache.md',
  companionPath: 'docs/articles/cache.writing',
  profile: 'technical',
  targetLength: null,
  requiredQuestions: [
    { id: 'q1', text: 'Why does the cache miss?' },
    { id: 'q2', text: 'What fixes it?' },
  ],
  sourceScope: { localPaths: ['docs/sources/cache.md'], webAllowed: false, description: 'local docs only' },
  evidenceMode: 'ordinary',
  allowBodyChanges: true,
  repairRounds: 1,
  protectedTerms: ['HTTP/2'],
  styleOverrides: [],
  defaultsApplied: ['targetLength'],
})

const run = () => ({
  schemaVersion: 1,
  kind: 'run',
  runId: uuid(),
  briefHash: hash('b'),
  phase: 'initialized',
  outcome: 'active',
  bodyHash: null,
  planHash: null,
  replaceExisting: false,
  structuralRound: 0,
  languagePass: 0,
  languageIntentsUsed: [],
  semanticRepairUsed: false,
  acceptedBodyHash: hash('a'),
  appliedProposals: [],
  artifactPaths: [{ path: 'runs/x/brief.json', hash: hash('c'), kind: 'brief' }],
  vwa: null,
  usage: null,
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:01Z',
  model: null,
})

const plan = () => ({
  schemaVersion: 1,
  kind: 'plan',
  runId: uuid(),
  descriptive: false,
  thesis: 'The cache misses because keys collide.',
  questions: ['q1', 'q2'],
  sections: [
    {
      id: 's1',
      title: 'Background',
      questionIds: ['q1'],
      purpose: 'background',
      claim: 'Caches depend on stable keys.',
      premises: ['Keys are hashed.'],
      assumptions: ['Traffic is steady.'],
      evidenceRefs: ['src1'],
      dependsOn: [],
      readerTakeaway: 'Keys decide reuse.',
      lengthWeight: 40,
    },
    {
      id: 's2',
      title: 'Fix',
      questionIds: ['q2'],
      purpose: 'recommendation',
      claim: 'Normalize the key before hashing.',
      premises: [],
      assumptions: [],
      evidenceRefs: [],
      dependsOn: ['s1'],
      readerTakeaway: 'Normalize keys first.',
      lengthWeight: 60,
    },
  ],
})

const research = () => ({
  schemaVersion: 1,
  kind: 'research',
  runId: uuid(),
  questions: [{ id: 'q1', answer: 'Keys collide after normalization.', evidenceRefs: ['src1'], gaps: ['No load test.'] }],
  sources: [
    {
      id: 'src1',
      path: 'docs/sources/cache.md',
      hash: hash('d'),
      origin: 'local',
      retrievedAt: null,
      limitations: ['Single vendor report.'],
    },
  ],
  searches: [{ query: 'cache key collision', scope: 'local docs', outcome: 'found', sourceIds: ['src1'] }],
})

const review = (stage: 'structure' | 'language' | 'semantics' = 'structure') => ({
  schemaVersion: 1,
  kind: 'review',
  id: uuid(),
  runId: uuid(),
  stage,
  bodyHash: hash('e'),
  beforeHash: stage === 'semantics' ? hash('f') : null,
  planHash: hash('b'),
  coverage: 'complete',
  coverageRanges: [{ start: 0, end: 12 }],
  crossSectionConsistency: true,
  reverseOutline: [{ start: 0, end: 12, quote: 'Keys decide reuse.', summary: 'Background.', role: 'background', sectionId: 's1' }],
  findings: [
    {
      id: uuid(),
      category: 'order',
      severity: 'minor',
      start: 0,
      end: 12,
      quote: 'Keys decide reuse.',
      explanation: 'The fix arrives before the premise.',
      suggestedAction: 'Move the recommendation after the evidence.',
      protectedMeaning: ['Keys decide reuse.'],
      status: 'open' as string,
      resolution: null as string | null,
    },
  ],
})

const proposal = () => ({
  schemaVersion: 1,
  kind: 'proposal',
  id: uuid(),
  runId: uuid(),
  bodyHash: hash('e'),
  findingIds: [uuid()],
  intent: 'clarity',
  edits: [
    { start: 0, end: 5, before: 'hello', after: 'hi', reason: 'shorter' },
    { start: 20, end: 20, before: '', after: ' (see above)', reason: 'cross-reference' },
  ],
})

const check = () => ({
  schemaVersion: 1,
  kind: 'check',
  id: uuid(),
  runId: uuid(),
  beforeHash: hash('e'),
  afterHash: hash('f'),
  mechanicalStatus: 'changed',
  semanticStatus: 'not-run',
  changes: [{ type: 'number', before: ['5'], after: ['6'], disposition: 'pending', reason: null }],
  semanticReviewId: null,
})

const application = () => ({
  schemaVersion: 1,
  kind: 'application',
  id: uuid(),
  runId: uuid(),
  proposalId: uuid(),
  intent: 'clarity',
  beforeHash: hash('e'),
  afterHash: hash('f'),
  appliedAt: '2026-10-25T00:00:02Z',
})

const profile = () => ({
  schemaVersion: 1,
  id: 'technical',
  description: 'Technical articles.',
  applicableLanguages: ['en', 'zh'],
  rules: [{ id: 'early-answer', instruction: 'Answer early.', rationale: 'Readers scan.', severity: 'required' }],
  protectedTerms: ['HTTP/2'],
})

// ------------------------------------------------------------------ valid

describe('valid artifacts', () => {
  it('accepts a brief and normalizes it', () => {
    const result = validateBrief(brief())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.kind).toBe('brief')
      expect(result.value.requiredQuestions.map((q: { id: string }) => q.id)).toEqual(['q1', 'q2'])
      expect(result.value.targetLength).toBeNull()
    }
  })
  it('accepts a run', () => {
    expect(validateRun(run()).ok).toBe(true)
  })
  it('accepts a plan with ordered dependencies', () => {
    expect(validatePlan(plan()).ok).toBe(true)
  })
  it('accepts research with local sources', () => {
    expect(validateResearch(research()).ok).toBe(true)
  })
  it('accepts context with unique section ids', () => {
    const ctx = {
      schemaVersion: 1,
      kind: 'context',
      runId: uuid(),
      planHash: hash('b'),
      sections: [
        { sectionId: 's1', actualSummary: 'Caches hash keys.', establishedClaims: ['Keys are hashed.'], openQuestions: [] },
        { sectionId: 's2', actualSummary: 'Normalize keys.', establishedClaims: [], openQuestions: ['Which normalizer?'] },
      ],
    }
    expect(validateContext(ctx).ok).toBe(true)
  })
  it('accepts structure, language, and semantics reviews', () => {
    for (const stage of ['structure', 'language', 'semantics'] as const) expect(validateReview(review(stage)).ok).toBe(true)
  })
  it('accepts a proposal with a replacement and an insertion', () => {
    expect(validateProposal(proposal()).ok).toBe(true)
  })
  it('accepts a pending check', () => {
    expect(validateCheck(check()).ok).toBe(true)
  })
  it('accepts an application record', () => {
    expect(validateApplication(application()).ok).toBe(true)
  })
  it('accepts a profile without a kind field', () => {
    expect(validateProfile(profile()).ok).toBe(true)
  })
  it('exports the shared format helpers', () => {
    expect(isUuidV4(uuid())).toBe(true)
    expect(isUuidV4('not-a-uuid')).toBe(false)
    expect(isSha256Hex(hash())).toBe(true)
    expect(isSha256Hex(hash('A'))).toBe(false)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isIso8601Utc('2026-10-25T00:00:00Z')).toBe(true)
    expect(isIso8601Utc('2026-10-25T00:00:00+08:00')).toBe(false)
  })
})

// ---------------------------------------------------------------- negative

describe('invalid artifacts', () => {
  it('rejects an unknown top-level property', () => {
    expectInvalid(validateBrief({ ...brief(), extra: true }), /unknown property "extra"/)
  })
  it('rejects an unknown nested property', () => {
    const b = brief()
    b.sourceScope = { ...b.sourceScope, sneaky: 1 } as never
    expectInvalid(validateBrief(b), /sourceScope: unknown property "sneaky"/)
  })
  it('rejects a missing required property', () => {
    const b = brief() as Record<string, unknown>
    delete b.audience
    expectInvalid(validateBrief(b), /missing required property "audience"/)
  })
  it('rejects wrong enums and literals', () => {
    expectInvalid(validateBrief({ ...brief(), profile: 'poetry' }), /profile: expected one of/)
    expectInvalid(validateBrief({ ...brief(), schemaVersion: 2 }), /schemaVersion/)
    expectInvalid(validateRun({ ...run(), phase: 'draft' }), /phase: expected one of/)
    expectInvalid(validateRun({ ...run(), outcome: 'done' }), /outcome: expected one of/)
  })
  it('rejects malformed question ids and missing q1', () => {
    expectInvalid(validateBrief({ ...brief(), requiredQuestions: [{ id: 'q0', text: 'x' }] }), /q\[1-9\]/)
    expectInvalid(validateBrief({ ...brief(), requiredQuestions: [{ id: 'q2', text: 'x' }] }), /q1 is required/)
  })
  it('rejects duplicate question ids', () => {
    const b = brief()
    b.requiredQuestions = [
      { id: 'q1', text: 'a' },
      { id: 'q1', text: 'b' },
    ]
    expectInvalid(validateBrief(b), /duplicate id "q1"/)
  })
  it('rejects targetLength with min above max and min of 0', () => {
    expectInvalid(validateBrief({ ...brief(), targetLength: { min: 500, max: 100 } }), /min must be <= max/)
    expectInvalid(validateBrief({ ...brief(), targetLength: { min: 0, max: 100 } }), /targetLength.min/)
  })
  it('rejects a bad runId and a bad hash', () => {
    expectInvalid(validateBrief({ ...brief(), runId: '00000000-0000-1000-8000-000000000000' }), /UUID v4/)
    expectInvalid(validateRun({ ...run(), briefHash: 'ABC' }), /64-character lowercase hex/)
  })
  it('rejects a run whose structural counter exceeds the budget', () => {
    expectInvalid(validateRun({ ...run(), structuralRound: 2 }, { repairRounds: 1 }), /structuralRound/)
    expectInvalid(validateRun({ ...run(), languagePass: 3 }), /languagePass/)
    expectInvalid(validateRun({ ...run(), languageIntentsUsed: ['clarity', 'clarity'], languagePass: 2 }), /duplicate intent/)
    expectInvalid(validateRun({ ...run(), languageIntentsUsed: ['clarity', 'concision-style'] }), /more intents/)
  })
  it('rejects a run vwa object with unknown properties', () => {
    expectInvalid(
      validateRun({
        ...run(),
        vwa: { projectId: 'prj_1', authorRevision: 1, artifactId: null, runId: null, taskId: null, reportPath: null, extra: 1 },
      }),
      /vwa: unknown property "extra"/,
    )
  })
  it('rejects bad section ids and duplicate sections', () => {
    const p = plan()
    p.sections[0].id = 's0'
    expectInvalid(validatePlan(p), /s\[1-9\]/)
    const p2 = plan()
    p2.sections[1].id = 's1'
    expectInvalid(validatePlan(p2), /duplicate section id/)
  })
  it('rejects dependency cycles and forward references', () => {
    const p = plan()
    p.sections[0].dependsOn = ['s2']
    expectInvalid(validatePlan(p), /must reference an earlier section/)
    const self = plan()
    self.sections[0].dependsOn = ['s1']
    expectInvalid(validatePlan(self), /must reference an earlier section/)
  })
  it('rejects unknown question references and bad lengthWeight', () => {
    const p = plan()
    p.sections[0].questionIds = ['q9']
    expectInvalid(validatePlan(p), /not listed in plan.questions/)
    const w = plan()
    w.sections[0].lengthWeight = 101
    expectInvalid(validatePlan(w), /lengthWeight/)
    const empty = plan()
    empty.sections[0].claim = ''
    expectInvalid(validatePlan(empty), /claim/)
  })
  it('rejects an empty section list', () => {
    expectInvalid(validatePlan({ ...plan(), sections: [] }), /at least one section/)
  })
  it('rejects research with a bad source id and dangling search reference', () => {
    const r = research()
    r.sources[0].id = 'source1'
    expectInvalid(validateResearch(r), /src\[1-9\]/)
    const dangling = research()
    dangling.searches[0].sourceIds = ['src9']
    expectInvalid(validateResearch(dangling), /not a listed source/)
    expectInvalid(validateResearch({ ...research(), sources: [], searches: research().searches }), /not a listed source/)
  })
  it('rejects a research outcome outside the enum', () => {
    const r = research()
    r.searches[0].outcome = 'maybe'
    expectInvalid(validateResearch(r), /outcome: expected one of/)
  })
  it('rejects context with duplicate or bad section ids', () => {
    const ctx = {
      schemaVersion: 1,
      kind: 'context',
      runId: uuid(),
      planHash: hash('b'),
      sections: [{ sectionId: 's1', actualSummary: 'x', establishedClaims: [], openQuestions: [] }],
    }
    expect(validateContext(ctx).ok).toBe(true)
    expectInvalid(validateContext({ ...ctx, sections: [...ctx.sections, ...ctx.sections] }), /duplicate sectionId/)
    expectInvalid(validateContext({ ...ctx, sections: [{ ...ctx.sections[0], sectionId: 'one' }] }), /sectionId/)
  })
  it('rejects beforeHash on a structure or language review', () => {
    expectInvalid(validateReview({ ...review('structure'), beforeHash: hash('f') }), /must be null for a structure review/)
    expectInvalid(validateReview({ ...review('language'), beforeHash: hash('f') }), /must be null for a language review/)
    expectInvalid(validateReview({ ...review('semantics'), beforeHash: null }), /required for a semantics review/)
  })
  it('rejects derived finding statuses', () => {
    const r = review()
    r.findings[0].status = 'addressed'
    expectInvalid(validateReview(r), /status: expected one of/)
  })
  it('requires a resolution on rejected findings and forbids one on open findings', () => {
    const rejected = review()
    rejected.findings[0].status = 'rejected'
    expectInvalid(validateReview(rejected), /resolution: required/)
    const open = review()
    open.findings[0].resolution = 'fixed'
    expectInvalid(validateReview(open), /must be null when status is open/)
    rejected.findings[0].resolution = 'withdrawn: misread the plan'
    expect(validateReview(rejected).ok).toBe(true)
  })
  it('rejects an unknown category and coverage overlaps', () => {
    const r = review()
    r.findings[0].category = 'style'
    expectInvalid(validateReview(r), /category: expected one of/)
    const overlap = review()
    overlap.coverageRanges = [
      { start: 0, end: 10 },
      { start: 5, end: 20 },
    ]
    expectInvalid(validateReview(overlap), /ordered and nonoverlapping/)
    const unordered = review()
    unordered.coverageRanges = [
      { start: 10, end: 20 },
      { start: 0, end: 5 },
    ]
    expectInvalid(validateReview(unordered), /ordered and nonoverlapping/)
  })
  it('rejects overlapping edits and duplicate insertion offsets', () => {
    const p = proposal()
    p.edits.push({ start: 2, end: 7, before: 'world', after: 'earth', reason: 'overlap' })
    expectInvalid(validateProposal(p), /overlap/)
    const dup = proposal()
    dup.edits.push({ start: 20, end: 20, before: '', after: '!', reason: 'same offset' })
    expectInvalid(validateProposal(dup), /duplicate insertion at offset 20/)
  })
  it('rejects a non-insertion edit with empty before', () => {
    const p = proposal()
    p.edits[0].before = ''
    expectInvalid(validateProposal(p), /needs nonempty before/)
  })
  it('rejects an assertion change type', () => {
    const c = check()
    c.changes[0].type = 'assertion'
    expectInvalid(validateCheck(c), /type: expected one of/)
  })
  it('rejects bad check dispositions and semantic statuses', () => {
    const missingReason = check()
    missingReason.changes[0].disposition = 'expected'
    expectInvalid(validateCheck(missingReason), /reason: required/)
    expectInvalid(validateCheck({ ...check(), semanticStatus: 'unknown' }), /semanticStatus: expected one of/)
    expectInvalid(validateCheck({ ...check(), schemaVersion: 1, id: 'x' }), /UUID v4/)
  })
  it('rejects an application with a bad intent or timestamp', () => {
    expectInvalid(validateApplication({ ...application(), intent: 'rewrite' }), /intent: expected one of/)
    expectInvalid(validateApplication({ ...application(), appliedAt: '2026-10-25 00:00:02' }), /ISO 8601 UTC/)
  })
  it('rejects a profile with a kind field or duplicate rule ids', () => {
    expectInvalid(validateProfile({ ...profile(), kind: 'profile' }), /unknown property "kind"/)
    expectInvalid(validateProfile({ ...profile(), rules: [...profile().rules, ...profile().rules] }), /duplicate rule id/)
    expectInvalid(
      validateProfile({ ...profile(), rules: [{ id: 'r', instruction: 'x', rationale: 'y', severity: 'hard' }] }),
      /severity: expected one of/,
    )
  })
  it('does not mutate its input', () => {
    const input = proposal()
    const snapshot = clone(input)
    validateProposal(input)
    expect(input).toEqual(snapshot)
  })
})
