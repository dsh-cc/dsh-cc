/**
 * Outline gate for structured profiles (genre expansion design §6, §8.1-8.2):
 * the `structure` profile field, the optional `outline` check field, the
 * matcher, and the end-to-end finalize enforcement chain.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateCheck, validateProfile } from '../skills/writing-workflow/scripts/contracts.lib.mjs'
import { computeOutline, verifyOutline } from '../skills/writing-workflow/scripts/outline.lib.mjs'
import {
  bodyPath,
  call,
  contextArtifact,
  failure,
  initRun,
  makeWorkspace,
  ok,
  record,
  reportPath,
  review,
  runJson,
  statusOf,
  writePlan,
} from './workflow-fixtures'

// ---------------------------------------------------------------- fixtures

const structure = () => ({
  openingPattern: 'scqa',
  sections: [
    { id: 'summary', headingHint: 'TL;DR / Summary / 摘要', required: true, order: 1 },
    { id: 'policy', headingHint: 'Guiding Policy / 指导方针', required: true, order: 2 },
    { id: 'operations', headingHint: 'Operations / 落实机制', required: false, order: 3 },
    { id: 'diagnosis', headingHint: 'Diagnosis / 诊断', required: true, order: 4 },
  ],
})

const profile = () => ({
  schemaVersion: 1,
  id: 'engineering-strategy',
  description: 'Engineering strategy document.',
  applicableLanguages: ['en', 'zh'],
  rules: [{ id: 'engineering-strategy-specificity', instruction: 'Be specific.', rationale: 'design §5.4', severity: 'advisory' }],
  protectedTerms: [],
  structure: structure(),
})

const typeProfile = validateProfile as unknown as (value: unknown) => { ok: boolean; value: Record<string, any>; message?: string }
const typeCheck = validateCheck as unknown as (value: unknown) => { ok: boolean; value: Record<string, any>; message?: string }

const BODY_MISSING = [
  '# Cache strategy',
  '',
  '## Summary',
  '',
  'Keys expire early.',
  '',
  '## Guiding Policy',
  '',
  'Default to Rust.',
  '',
].join('\n')
const BODY_COMPLETE = `${BODY_MISSING}\n## Diagnosis\n\nThe cache misses at peak load.\n`

const storedCheck = (workspace: string, checkPath: string) => JSON.parse(readFileSync(join(workspace, checkPath), 'utf8'))

/** Walk the write chain up to (but not including) the check. */
function prepareRun(workspace: string, body: string) {
  const init = initRun(workspace, { profile: 'engineering-strategy' })
  writeFileSync(bodyPath(workspace), body)
  const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
  ok(record(workspace, init.runPath, writePlan(init.runId), snapshot.hash, null))
  const planHash = statusOf(workspace, init.runPath).planHash
  ok(record(workspace, init.runPath, contextArtifact(init.runId), snapshot.hash, planHash))
  ok(record(workspace, init.runPath, review(init.runId, body, 'structure'), snapshot.hash, planHash))
  // No language or repair proposal was applied, so the semantics review owes no
  // edited-block coverage (preservation.lib.mjs requiredRanges).
  const semantics = { ...review(init.runId, body, 'semantics'), coverageRanges: [] }
  ok(record(workspace, init.runPath, semantics, snapshot.hash, planHash))
  return { init, snapshot, planHash, semantics }
}

function checkArtifact(runId: string, semanticsReviewId: string | null) {
  return {
    schemaVersion: 1,
    kind: 'check',
    id: randomUUID(),
    runId,
    mechanicalStatus: 'clean',
    semanticStatus: semanticsReviewId === null ? 'not-run' : 'no-issue-found',
    changes: [],
    semanticReviewId: semanticsReviewId,
  }
}

function structuredRun(workspace: string, body: string) {
  const prepared = prepareRun(workspace, body)
  const candidate = checkArtifact(prepared.init.runId, prepared.semantics.id)
  const recorded = ok(record(workspace, prepared.init.runPath, candidate, prepared.snapshot.hash, prepared.planHash))
  return { ...prepared, recorded }
}

// ------------------------------------------------- profile `structure` (§8.1)

describe('profile structure field', () => {
  it('accepts an ordered skeleton and normalizes it', () => {
    const checked = typeProfile(profile())
    expect(checked.ok, checked.message).toBe(true)
    expect(checked.value.structure.sections.map((section: any) => section.id)).toEqual(['summary', 'policy', 'operations', 'diagnosis'])
    expect(checked.value.structure.openingPattern).toBe('scqa')
    expect(checked.value.structure.sections[0].required).toBe(true)
  })

  it('accepts a skeleton without the optional fields and with no sections', () => {
    expect(typeProfile({ ...profile(), structure: { sections: [] } }).ok).toBe(true)
    const minimal = { sections: [{ id: 'summary', headingHint: 'Summary', required: true, order: 1 }] }
    expect(typeProfile({ ...profile(), structure: minimal }).ok).toBe(true)
  })

  it('leaves a profile without structure unchanged', () => {
    const bare: Record<string, unknown> = { ...profile() }
    delete bare.structure
    const checked = typeProfile(bare)
    expect(checked.ok).toBe(true)
    expect(checked.value.structure).toBeUndefined()
  })

  it('rejects unknown fields, bad enums, and bad section shapes', () => {
    expect(typeProfile({ ...profile(), structure: { ...structure(), extra: true } }).ok).toBe(false)
    expect(typeProfile({ ...profile(), structure: { ...structure(), openingPattern: 'scqa2' } }).ok).toBe(false)
    expect(typeProfile({ ...profile(), structure: { sections: 'summary' } }).ok).toBe(false)
    expect(typeProfile({ ...profile(), structure: {} }).ok).toBe(false)
    const section = (overrides: Record<string, unknown>) => ({
      ...profile(),
      structure: { sections: [{ id: 'summary', headingHint: 'Summary', required: true, order: 1, ...overrides }] },
    })
    expect(typeProfile(section({ headingHint: '' })).ok).toBe(false)
    expect(typeProfile(section({ required: 'yes' })).ok).toBe(false)
    expect(typeProfile(section({ order: 0 })).ok).toBe(false)
    expect(typeProfile(section({ order: '1' })).ok).toBe(false)
    expect(typeProfile(section({ extra: 1 })).ok).toBe(false)
  })

  it('ships a schema-valid engineering-strategy profile with the §5.4 skeleton', () => {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'skills', 'writing-workflow', 'profiles', 'engineering-strategy.json'), 'utf8'),
    )
    const checked = typeProfile(raw)
    expect(checked.ok, checked.message).toBe(true)
    expect(checked.value.id).toBe('engineering-strategy')
    expect(checked.value.structure.sections.map((section: any) => section.id)).toEqual([
      'summary',
      'policy',
      'operations',
      'diagnosis',
      'explore',
    ])
    expect(checked.value.structure.openingPattern).toBe('scqa')
  })

  it('rejects duplicate ids and a non-increasing order', () => {
    const sections = (values: { id: string; order: number }[]) => ({
      ...profile(),
      structure: { sections: values.map((value) => ({ headingHint: value.id, required: true, ...value })) },
    })
    expect(typeProfile(sections([{ id: 'a', order: 1 }, { id: 'a', order: 2 }])).ok).toBe(false)
    expect(typeProfile(sections([{ id: 'a', order: 2 }])).ok, 'order starts at 1').toBe(false)
    expect(typeProfile(sections([{ id: 'a', order: 1 }, { id: 'b', order: 1 }])).ok).toBe(false)
    expect(typeProfile(sections([{ id: 'a', order: 1 }, { id: 'b', order: 3 }, { id: 'c', order: 2 }])).ok).toBe(false)
  })
})

// ---------------------------------------------- check `outline` field (§8.1)

describe('check outline field', () => {
  const check = () => ({
    schemaVersion: 1,
    kind: 'check',
    id: randomUUID(),
    runId: randomUUID(),
    beforeHash: 'a'.repeat(64),
    afterHash: 'b'.repeat(64),
    mechanicalStatus: 'clean',
    semanticStatus: 'not-run',
    changes: [],
    semanticReviewId: null,
  })

  it('stays optional: old and profile-less checks carry no outline', () => {
    const checked = typeCheck(check())
    expect(checked.ok).toBe(true)
    expect(checked.value.outline).toBeUndefined()
  })

  it('accepts compliant and non-compliant outlines', () => {
    const compliant = typeCheck({ ...check(), outline: { status: 'compliant', missingRequiredSections: [], orderViolations: [] } })
    expect(compliant.ok, compliant.message).toBe(true)
    const nonCompliant = typeCheck({
      ...check(),
      outline: {
        status: 'non-compliant',
        missingRequiredSections: ['diagnosis'],
        orderViolations: [{ section: 'summary', declaredOrder: 1, actualOrder: 2 }],
      },
    })
    expect(nonCompliant.ok, nonCompliant.message).toBe(true)
    expect(nonCompliant.value.outline.orderViolations).toEqual([{ section: 'summary', declaredOrder: 1, actualOrder: 2 }])
  })

  it('rejects bad statuses, bad nested shapes, and unknown fields', () => {
    const outline = (overrides: Record<string, unknown>) => ({
      ...check(),
      outline: { status: 'compliant', missingRequiredSections: [], orderViolations: [], ...overrides },
    })
    expect(typeCheck(outline({ status: 'clean' })).ok).toBe(false)
    expect(typeCheck(outline({ missingRequiredSections: [1] })).ok).toBe(false)
    expect(typeCheck(outline({ orderViolations: [{ section: 'summary', declaredOrder: 1 }] })).ok).toBe(false)
    expect(typeCheck(outline({ orderViolations: [{ section: 'summary', declaredOrder: 0, actualOrder: 1 }] })).ok).toBe(false)
    expect(typeCheck(outline({ extra: true })).ok).toBe(false)
    expect(typeCheck({ ...check(), outline: [] }).ok).toBe(false)
  })
})

// ------------------------------------------------------------- matcher (§6)

describe('outline matcher', () => {
  it('matches H2 headings only, by alternative equality', () => {
    const text = '# Strategy\n\n## Summary\n\n## guiding policy ##\n\n### Diagnosis\n'
    const outline = computeOutline(structure(), text)
    expect(outline.missingRequiredSections).toEqual(['diagnosis'])
    expect(outline.orderViolations).toEqual([])
    expect(outline.status).toBe('non-compliant')
  })

  it('reports a reworded required heading as missing and ignores extra H2s', () => {
    const text = '## Overview\n\n## Guiding Policy\n'
    expect(computeOutline(structure(), text).missingRequiredSections).toEqual(['summary', 'diagnosis'])
    const extra = '## Summary\n\n## Policy thoughts\n\n## Diagnosis\n'
    const outline = computeOutline(structure(), extra)
    expect(outline.missingRequiredSections).toEqual(['policy'])
  })

  it('reports inversions with the 1-based rank among matched sections', () => {
    const text = '## Guiding Policy\n\n## Summary\n\n## Diagnosis\n'
    expect(computeOutline(structure(), text).orderViolations).toEqual([
      { section: 'summary', declaredOrder: 1, actualOrder: 2 },
    ])
    const swapped = '## Diagnosis\n\n## Guiding Policy\n\n## Summary\n'
    expect(computeOutline(structure(), swapped).orderViolations).toEqual([
      { section: 'policy', declaredOrder: 2, actualOrder: 2 },
      { section: 'summary', declaredOrder: 1, actualOrder: 3 },
    ])
  })

  it('recomputes and compares field by field', () => {
    const body = BODY_COMPLETE
    const outline = computeOutline(structure(), body)
    expect(outline.status).toBe('compliant')
    const check = { outline }
    expect(verifyOutline(check, body, structure())).toEqual(outline)
    expect(() => verifyOutline({ outline: { ...outline, status: 'non-compliant' } }, body, structure())).toThrow()
    expect(() => verifyOutline({}, body, structure())).toThrow()
  })
})

// ------------------------------------------------------- end-to-end (§8.2)

describe('engineering-strategy outline gate', () => {
  it('blocks finalize on the outline alone and attributes the reason', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, recorded } = structuredRun(workspace, BODY_MISSING)
    const check = storedCheck(workspace, recorded.artifactPath)
    expect(check.outline.status).toBe('non-compliant')
    expect(check.outline.missingRequiredSections).toEqual(['diagnosis'])
    expect(check.outline.orderViolations).toEqual([])
    expect(check.changes).toEqual([])
    expect(check.mechanicalStatus).toBe('clean')

    const status = statusOf(workspace, init.runPath)
    expect(status.nextStage).toBe('re-check')
    expect(status.nextStageGuidance).toBe('add the required sections and re-check')

    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }),
      'REVIEW_INCOMPLETE',
      4,
    )
    expect(failed.details.missing).toEqual(['outline'])
    expect(failed.details.outcome).toBe('blocked')
    expect(runJson(workspace, init.runPath).outcome).toBe('blocked')

    const report = readFileSync(reportPath(workspace, init.runPath), 'utf8')
    expect(report).toContain('Editorial outcome: blocked')
    expect(report).toContain('missing stages: outline')
    expect(report).toContain('outline status: non-compliant')
    expect(report).toContain('missing required sections: diagnosis')
  })

  it('rejects a model-supplied outline on the record path', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, planHash, semantics } = prepareRun(workspace, BODY_MISSING)
    const candidate = {
      ...checkArtifact(init.runId, semantics.id),
      outline: { status: 'compliant', missingRequiredSections: [], orderViolations: [] },
    }
    const failed = failure(record(workspace, init.runPath, candidate, snapshot.hash, planHash), 'INVALID_INPUT', 2)
    expect(failed.message).toContain('outline')
  })

  it('keeps a mixed missing list incomplete and the run active', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, planHash } = prepareRun(workspace, BODY_MISSING)
    // A new snapshot without re-reviews: both reviews go stale while the check
    // still pairs the accepted baseline with the current body.
    writeFileSync(bodyPath(workspace), `${BODY_MISSING}\nOne more prose paragraph, still no diagnosis section.\n`)
    const moved = ok(call('snapshot', workspace, { runPath: init.runPath }))
    ok(record(workspace, init.runPath, checkArtifact(init.runId, null), moved.hash, planHash))
    expect(moved.hash).not.toBe(snapshot.hash)

    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: moved.hash }),
      'REVIEW_INCOMPLETE',
      4,
    )
    expect(failed.details.missing).toContain('structure-review')
    expect(failed.details.missing).toContain('semantic-review')
    expect(failed.details.missing).toContain('outline')
    expect(failed.details.outcome).toBe('incomplete')
    expect(runJson(workspace, init.runPath).outcome).toBe('active')
  })

  it('keeps a reviews-only list free of the outline token', () => {
    const workspace = makeWorkspace()
    const { init, planHash } = prepareRun(workspace, BODY_COMPLETE)
    // Same staleness move, but the body already satisfies the skeleton.
    writeFileSync(bodyPath(workspace), `${BODY_COMPLETE}\nOne more prose paragraph, with the diagnosis section present.\n`)
    const moved = ok(call('snapshot', workspace, { runPath: init.runPath }))
    ok(record(workspace, init.runPath, checkArtifact(init.runId, null), moved.hash, planHash))
    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: moved.hash }),
      'REVIEW_INCOMPLETE',
      4,
    )
    expect(failed.details.missing).toEqual(['structure-review', 'semantic-review'])
    expect(failed.details.missing).not.toContain('outline')
    expect(failed.details.outcome).toBe('incomplete')
  })

  it('passes finalize after the repair and replays both check producers', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, recorded } = structuredRun(workspace, BODY_MISSING)
    const planHash = statusOf(workspace, init.runPath).planHash
    expect(storedCheck(workspace, recorded.artifactPath).outline.status).toBe('non-compliant')

    // Repair: new body snapshot, re-review, re-check (record check last).
    writeFileSync(bodyPath(workspace), BODY_COMPLETE)
    const repaired = ok(call('snapshot', workspace, { runPath: init.runPath }))
    ok(record(workspace, init.runPath, review(init.runId, BODY_COMPLETE, 'structure'), repaired.hash, planHash))
    const semantics = { ...review(init.runId, BODY_COMPLETE, 'semantics'), coverageRanges: [] }
    ok(record(workspace, init.runPath, semantics, repaired.hash, planHash))
    const recheck = ok(record(workspace, init.runPath, checkArtifact(init.runId, semantics.id), repaired.hash, planHash))
    const repairedCheck = storedCheck(workspace, recheck.artifactPath)
    expect(repairedCheck.outline).toEqual({ status: 'compliant', missingRequiredSections: [], orderViolations: [] })
    expect(verifyOutline(repairedCheck, BODY_COMPLETE, structure())).toEqual(repairedCheck.outline)
    expect(statusOf(workspace, init.runPath).nextStage).toBe('finalize')

    const finalized = ok(call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: repaired.hash }))
    expect(finalized.editorialOutcome).toBe('checked-no-major-findings')
    expect(runJson(workspace, init.runPath).outcome).toBe('completed')

    // The compare producer computes the same outline; replay it byte for byte.
    const first = ok(call('compare', workspace, { runPath: init.runPath, beforeHash: snapshot.hash, afterHash: repaired.hash }))
    const second = ok(call('compare', workspace, { runPath: init.runPath, beforeHash: snapshot.hash, afterHash: repaired.hash }))
    expect(first.outline).toEqual(repairedCheck.outline)
    const outlineJson = (checkId: string) =>
      JSON.stringify(storedCheck(workspace, `${init.runPath}/checks/${checkId}.json`).outline)
    expect(outlineJson(second.checkId)).toBe(outlineJson(first.checkId))
    expect(verifyOutline(storedCheck(workspace, `${init.runPath}/checks/${first.checkId}.json`), BODY_COMPLETE, structure()))
      .toEqual(repairedCheck.outline)
  })

  it('rejects a stored outline that diverges from the body (finalize, not status)', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, recorded } = structuredRun(workspace, BODY_MISSING)
    const path = join(workspace, recorded.artifactPath)
    const stored = storedCheck(workspace, recorded.artifactPath)
    stored.outline = { status: 'compliant', missingRequiredSections: [], orderViolations: [] }
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`)

    // Status stays advisory on the stored value alone.
    expect(statusOf(workspace, init.runPath).nextStage).toBe('finalize')
    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }),
      'INVALID_INPUT',
      2,
    )
    expect(failed.message).toContain('check.outline.status')
    expect(runJson(workspace, init.runPath).outcome).toBe('active')
  })

  it('requires an outline field once the profile declares structure', () => {
    const workspace = makeWorkspace()
    const { init, snapshot, recorded } = structuredRun(workspace, BODY_MISSING)
    const path = join(workspace, recorded.artifactPath)
    const stored = storedCheck(workspace, recorded.artifactPath)
    delete stored.outline
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`)
    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }),
      'INVALID_INPUT',
      2,
    )
    expect(failed.message).toContain('carries an outline')
  })

  it('skips the recompute on snapshot loss and blocks through completion.blocked', () => {
    const workspace = makeWorkspace()
    const { init, snapshot } = structuredRun(workspace, BODY_MISSING)
    rmSync(join(workspace, init.runPath, 'snapshots', `${snapshot.hash}.md`))
    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }),
      'REVIEW_INCOMPLETE',
      4,
    )
    expect(failed.details.missing).toEqual(['final-check'])
    expect(failed.details.missing).not.toContain('outline')
    expect(failed.details.outcome).toBe('incomplete')
    expect(runJson(workspace, init.runPath).outcome).toBe('blocked')
  })

  it('rejects a stored outline under a profile with no structure', () => {
    const workspace = makeWorkspace()
    writeFileSync(bodyPath(workspace), '# Cache\n\nKeys expire early.\n')
    const init = initRun(workspace, { operation: 'edit' })
    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    const compared = ok(call('compare', workspace, { runPath: init.runPath, beforeHash: snapshot.hash, afterHash: snapshot.hash }))
    const path = join(workspace, init.runPath, 'checks', `${compared.checkId}.json`)
    const stored = storedCheck(workspace, `${init.runPath}/checks/${compared.checkId}.json`)
    stored.outline = { status: 'compliant', missingRequiredSections: [], orderViolations: [] }
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`)
    const failed = failure(
      call('finalize', workspace, { runPath: init.runPath, expectedBodyHash: snapshot.hash }),
      'INVALID_INPUT',
      2,
    )
    expect(failed.message).toContain('no structure')
  })

  it('leaves a profile without structure unaffected', () => {
    const workspace = makeWorkspace()
    const init = initRun(workspace)
    writeFileSync(bodyPath(workspace), '# Cache\n\nKeys expire early.\n')
    const snapshot = ok(call('snapshot', workspace, { runPath: init.runPath }))
    const compared = ok(call('compare', workspace, { runPath: init.runPath, beforeHash: snapshot.hash, afterHash: snapshot.hash }))
    expect(compared.outline).toBeNull()
    expect(storedCheck(workspace, `${init.runPath}/checks/${compared.checkId}.json`).outline).toBeUndefined()
  })
})
