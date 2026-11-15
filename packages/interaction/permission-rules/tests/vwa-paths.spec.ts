import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePath } from '../src/task-grant.ts'
import {
  DRAFT_FILE_RE,
  DRAFT_PREFIX_RE,
  PROJECT_ID_RE,
  VWA_BATCH_ROOT,
  VWA_STATE_ROOT,
  isVwaBatchPath,
  isVwaDraftPath,
  isVwaDraftPrefix,
  isVwaStatePath,
  relativeToStateRoot,
  vwaProjectIdOfDraft,
} from '../src/vwa-paths.ts'

/**
 * The shared corpus (§3.2 "the fixture is the contract"). `vwa-evidence`
 * restates the same predicates in its own `src/vwa-paths.ts` and asserts the
 * SAME file, which is what keeps the two matchers identical without a
 * permission-rules dependency.
 */
interface DraftPathCase {
  why: string
  rel: string
  draftFile: boolean
  draftPrefix: boolean
  projectId: string | null
}

const corpusUrl = new URL('./fixtures/vwa-draft-paths.json', import.meta.url)
const corpus = JSON.parse(readFileSync(corpusUrl, 'utf8')) as {
  schemaVersion: number
  cases: readonly DraftPathCase[]
}

const temporaryRoots: string[] = []

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vwa-paths-')))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const PROJECT_ID = 'prj_11111111-1111-4111-8111-111111111111'

describe('§3.2 draft-path predicates driven by the shared fixture corpus', () => {
  it('the corpus is versioned and covers accept and reject verdicts for both predicates', () => {
    expect(corpus.schemaVersion).toBe(1)
    expect(corpus.cases.length).toBeGreaterThan(20)
    expect(corpus.cases.some(one => one.draftFile)).toBe(true)
    expect(corpus.cases.some(one => !one.draftFile)).toBe(true)
    expect(corpus.cases.some(one => one.draftPrefix)).toBe(true)
    expect(corpus.cases.some(one => !one.draftPrefix)).toBe(true)
    for (const one of corpus.cases) {
      expect(one.rel.length, `${one.why} carries a path`).toBeGreaterThan(0)
      expect(one.why.length, `${one.rel} explains its verdict`).toBeGreaterThan(0)
    }
  })

  it.each(corpus.cases.map(one => [one.why, one] as const))('fixture verdict: %s', (_why, one) => {
    expect(isVwaDraftPath(one.rel)).toBe(one.draftFile)
    expect(isVwaDraftPrefix(one.rel)).toBe(one.draftPrefix)
    expect(vwaProjectIdOfDraft(one.rel) ?? null).toBe(one.projectId)
  })

  it('the exported regexes carry the documented shapes and no stateful flag', () => {
    // A /g or /y flag would make repeated .test() calls alternate verdicts.
    expect(DRAFT_FILE_RE.flags).toBe('')
    expect(DRAFT_PREFIX_RE.flags).toBe('')
    expect(PROJECT_ID_RE.flags).toBe('')
    expect(PROJECT_ID_RE.test(PROJECT_ID)).toBe(true)
    expect(PROJECT_ID_RE.test(PROJECT_ID)).toBe(true)
    expect(isVwaDraftPath(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
    expect(isVwaDraftPath(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
    expect(DRAFT_FILE_RE.test(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
    expect(DRAFT_FILE_RE.test(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
    expect(DRAFT_PREFIX_RE.test(`.dsh/vwa/${PROJECT_ID}/drafts`)).toBe(true)
    expect(DRAFT_PREFIX_RE.test(`.dsh/vwa/${PROJECT_ID}/drafts`)).toBe(true)
  })

  it('splits the state tree into its root, batches carve-out and project segment', () => {
    expect(VWA_STATE_ROOT).toBe('.dsh/vwa')
    expect(VWA_BATCH_ROOT).toBe('.dsh/vwa/batches')
    expect(isVwaStatePath('.dsh/vwa')).toBe(true)
    expect(isVwaStatePath('.dsh/vwa/batches/b1/x.json')).toBe(true)
    expect(isVwaStatePath('.dsh/vwa-other/x.json')).toBe(false)
    expect(isVwaStatePath('.dsh')).toBe(false)
    expect(isVwaBatchPath('.dsh/vwa/batches')).toBe(true)
    expect(isVwaBatchPath('.dsh/vwa/batches/b1/x.json')).toBe(true)
    expect(isVwaBatchPath('.dsh/vwa/batches-other/x.json')).toBe(false)
    expect(isVwaBatchPath('.dsh/vwa/prj_1/batches/x.json')).toBe(false)
  })
})

describe('§3.2 relativeToStateRoot anchors the predicates on the canonical state root', () => {
  it('maps an absolute realpath under the state root onto the workspace-relative POSIX form', () => {
    const root = workspace()
    mkdirSync(join(root, '.dsh/vwa', PROJECT_ID, 'drafts'), { recursive: true })
    const stateRoot = normalizePath(join(root, VWA_STATE_ROOT))
    expect(relativeToStateRoot(join(root, '.dsh/vwa', PROJECT_ID, 'drafts/a.md'), stateRoot))
      .toBe(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)
    expect(relativeToStateRoot(stateRoot, stateRoot)).toBe(VWA_STATE_ROOT)
    expect(relativeToStateRoot(join(stateRoot, 'batches/b1/x.json'), stateRoot)).toBe('.dsh/vwa/batches/b1/x.json')
    expect(relativeToStateRoot(join(root, 'docs/a.md'), stateRoot)).toBeUndefined()
    expect(relativeToStateRoot(join(root, '.dsh/vwa-other/a.md'), stateRoot)).toBeUndefined()
    expect(relativeToStateRoot(join(root, 'docs/.dsh/vwa'), stateRoot)).toBeUndefined()
  })

  it('classifies through a relocated .dsh/vwa symlink because the caller passes the canonical root', () => {
    const root = workspace()
    mkdirSync(join(root, 'storage/vwa', PROJECT_ID, 'drafts'), { recursive: true })
    mkdirSync(join(root, '.dsh'), { recursive: true })
    symlinkSync(join(root, 'storage/vwa'), join(root, '.dsh/vwa'))
    const stateRoot = normalizePath(join(root, VWA_STATE_ROOT))
    expect(stateRoot).toBe(join(root, 'storage/vwa'))
    const target = normalizePath(join(root, '.dsh/vwa', PROJECT_ID, 'drafts/a.md'))
    expect(relativeToStateRoot(target, stateRoot)).toBe(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)
    expect(isVwaDraftPath(relativeToStateRoot(target, stateRoot) ?? '')).toBe(true)
  })

  it('resolves a draft-file symlink to its authoritative destination, so it never reads as a draft', () => {
    const root = workspace()
    const drafts = join(root, '.dsh/vwa', PROJECT_ID, 'drafts')
    mkdirSync(drafts, { recursive: true })
    writeFileSync(join(root, '.dsh/vwa', PROJECT_ID, 'adjudications.json'), '{}')
    symlinkSync(join(root, '.dsh/vwa', PROJECT_ID, 'adjudications.json'), join(drafts, 'a.md'))
    const stateRoot = normalizePath(join(root, VWA_STATE_ROOT))
    const rel = relativeToStateRoot(normalizePath(join(drafts, 'a.md')), stateRoot)
    expect(rel).toBe(`.dsh/vwa/${PROJECT_ID}/adjudications.json`)
    expect(isVwaDraftPath(rel ?? '')).toBe(false)
    expect(isVwaDraftPath(`.dsh/vwa/${PROJECT_ID}/drafts/a.md`)).toBe(true)
  })
})
