import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DRAFT_FILE_RE,
  DRAFT_PREFIX_RE,
  PROJECT_ID_RE,
  VWA_BATCH_ROOT,
  VWA_STATE_ROOT,
  isVwaBatchPath,
  isVwaDraftPath,
  isVwaDraftPrefix,
  vwaProjectIdOfDraft,
} from '../src/vwa-paths.ts'

/**
 * Cross-package pin (§3.2 of
 * docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md): vwa-evidence
 * restates the draft-path predicates instead of importing `permission-rules`
 * (that would invert the layering). Both packages assert the SAME fixture
 * corpus, so identical verdicts are not a convention — they are a test.
 */
interface DraftPathCase {
  why: string
  rel: string
  draftFile: boolean
  draftPrefix: boolean
  projectId: string | null
}

const corpusUrl = new URL('../../permission-rules/tests/fixtures/vwa-draft-paths.json', import.meta.url)
const corpus = JSON.parse(readFileSync(corpusUrl, 'utf8')) as {
  schemaVersion: number
  cases: readonly DraftPathCase[]
}

const PROJECT_ID = 'prj_11111111-1111-4111-8111-111111111111'

describe('§3.2 draft-path predicates: vwa-evidence mirror of the shared corpus', () => {
  it('loads the permission-rules fixture corpus (the shared contract) and covers both verdicts', () => {
    expect(corpus.schemaVersion).toBe(1)
    expect(corpus.cases.length).toBeGreaterThan(20)
    expect(corpus.cases.some(one => one.draftFile)).toBe(true)
    expect(corpus.cases.some(one => !one.draftFile)).toBe(true)
    expect(corpus.cases.some(one => one.draftPrefix)).toBe(true)
    expect(corpus.cases.some(one => !one.draftPrefix)).toBe(true)
  })

  it.each(corpus.cases.map(one => [one.why, one] as const))('fixture verdict: %s', (_why, one) => {
    expect(isVwaDraftPath(one.rel)).toBe(one.draftFile)
    expect(isVwaDraftPrefix(one.rel)).toBe(one.draftPrefix)
    expect(vwaProjectIdOfDraft(one.rel) ?? null).toBe(one.projectId)
  })

  it('keeps the state-tree vocabulary identical to the owner package', () => {
    expect(VWA_STATE_ROOT).toBe('.dsh/vwa')
    expect(VWA_BATCH_ROOT).toBe('.dsh/vwa/batches')
    expect(PROJECT_ID_RE.test(PROJECT_ID)).toBe(true)
    expect(DRAFT_FILE_RE.flags).toBe('')
    expect(DRAFT_PREFIX_RE.flags).toBe('')
    expect(isVwaDraftPath(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
    expect(isVwaDraftPath(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
    expect(isVwaBatchPath('.dsh/vwa/batches/b1/x.json')).toBe(true)
    expect(isVwaBatchPath('.dsh/vwa/batches-other/x.json')).toBe(false)
  })

  it('never imports permission-rules (the mirror is a restatement, not a dependency)', () => {
    const source = readFileSync(new URL('../src/vwa-paths.ts', import.meta.url), 'utf8')
    expect(/from\s+['"][^'"]*permission-rules[^'"]*['"]/.test(source)).toBe(false)
  })
})
