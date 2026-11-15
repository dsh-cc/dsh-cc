import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantAdmitsWritePath } from '../src/task-grant-match.ts'
import { buildTaskGrant, validateDescriptor, type TaskGrant } from '../src/task-grant.ts'
import { isVwaStateWrite } from '../src/vwa-state.ts'

const temporaryRoots: string[] = []

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grant-path-security-')))
  temporaryRoots.push(root)
  mkdirSync(join(root, '.dsh/vwa/batches'), { recursive: true })
  mkdirSync(join(root, 'docs/reports'), { recursive: true })
  return root
}

function grant(root: string, writePaths: string[]): TaskGrant {
  return buildTaskGrant({
    root,
    branch: 'path-security',
    goalId: null,
    face: validateDescriptor({ rules: [], tools: [], writePaths, sandboxEscalation: false }),
  })
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('task-grant canonical write boundary', () => {
  it('a broad .dsh prefix never admits authoritative state but retains batch scratch', () => {
    const root = workspace()
    const g = grant(root, ['.dsh'])
    for (const target of ['.dsh/vwa/current-project.json', '.dsh/vwa/revisions/new.json']) {
      expect(isVwaStateWrite(target, root)).toBe(true)
      expect(grantAdmitsWritePath(g, target)).toBe(false)
    }
    expect(grantAdmitsWritePath(g, '.dsh/vwa/batches/b1/input.json')).toBe(true)
    expect(grantAdmitsWritePath(g, '.dsh/vwa-other/a.json')).toBe(true)
  })

  it('a directly granted symlink into state is excluded by its canonical destination', () => {
    const root = workspace()
    symlinkSync(join(root, '.dsh/vwa'), join(root, 'docs/link'))
    const g = grant(root, ['docs/link'])
    expect(isVwaStateWrite('docs/link/signatures.json', root)).toBe(true)
    expect(grantAdmitsWritePath(g, 'docs/link/signatures.json')).toBe(false)
    expect(grantAdmitsWritePath(g, 'docs/link/batches/b1/input.json')).toBe(true)
  })

  it('rechecks a granted symlink after it is retargeted into state', () => {
    const root = workspace()
    const link = join(root, 'docs/link')
    symlinkSync(join(root, 'docs/reports'), link)
    const g = grant(root, ['docs/link'])
    expect(grantAdmitsWritePath(g, 'docs/link/new.json')).toBe(true)
    unlinkSync(link)
    symlinkSync(join(root, '.dsh/vwa'), link)
    expect(isVwaStateWrite('docs/link/new.json', root)).toBe(true)
    expect(grantAdmitsWritePath(g, 'docs/link/new.json')).toBe(false)
  })

  it('never admits a canonical target outside the grant root through a symlink prefix', () => {
    const root = workspace()
    const outside = workspace()
    const link = join(root, 'docs/link')
    symlinkSync(outside, link)
    const g = grant(root, ['docs/link'])
    expect(grantAdmitsWritePath(g, 'docs/link/new.json')).toBe(false)
    expect(grantAdmitsWritePath(g, join(outside, 'new.json'))).toBe(false)
    expect(grantAdmitsWritePath(grant(root, ['docs']), 'docs/link/new.json')).toBe(false)
  })

  it('rechecks root containment after a granted symlink is retargeted outside', () => {
    const root = workspace()
    const outside = workspace()
    const link = join(root, 'docs/link')
    symlinkSync(join(root, 'docs/reports'), link)
    const g = grant(root, ['docs/link'])
    expect(grantAdmitsWritePath(g, 'docs/link/a.md')).toBe(true)
    unlinkSync(link)
    symlinkSync(outside, link)
    expect(grantAdmitsWritePath(g, 'docs/link/a.md')).toBe(false)
  })

  it('keeps in-root aliases, canonical batch aliases, and separator boundaries', () => {
    const root = workspace()
    symlinkSync(join(root, 'docs/reports'), join(root, 'docs/alias'))
    symlinkSync(join(root, '.dsh/vwa/batches'), join(root, 'docs/batches'))
    expect(grantAdmitsWritePath(grant(root, ['docs/alias']), 'docs/reports/new/a.md')).toBe(true)
    expect(grantAdmitsWritePath(grant(root, ['docs/batches']), 'docs/batches/b1/input.json')).toBe(true)
    expect(isVwaStateWrite('docs/batches/b1/input.json', root)).toBe(false)
    expect(grantAdmitsWritePath(grant(root, ['docs/reports']), 'docs/reports-other/a.md')).toBe(false)
  })

  it('a batches symlink cannot turn an authoritative subtree into exempt scratch', () => {
    const root = workspace()
    mkdirSync(join(root, '.dsh/vwa/prj_1'))
    rmSync(join(root, '.dsh/vwa/batches'), { recursive: true })
    symlinkSync(join(root, '.dsh/vwa/prj_1'), join(root, '.dsh/vwa/batches'))
    const g = grant(root, ['.dsh/vwa/batches'])
    expect(isVwaStateWrite('.dsh/vwa/batches/adjudications.json', root)).toBe(true)
    expect(isVwaStateWrite('.dsh/vwa/prj_1/adjudications.json', root)).toBe(true)
    expect(grantAdmitsWritePath(g, '.dsh/vwa/batches/adjudications.json')).toBe(false)
    expect(grantAdmitsWritePath(g, '.dsh/vwa/prj_1/adjudications.json')).toBe(false)
  })

  it('locates authoritative state and batch scratch through an aliased VWA root', () => {
    const root = workspace()
    mkdirSync(join(root, 'storage/vwa/batches'), { recursive: true })
    rmSync(join(root, '.dsh/vwa'), { recursive: true })
    symlinkSync(join(root, 'storage/vwa'), join(root, '.dsh/vwa'))
    const g = grant(root, ['storage'])
    expect(isVwaStateWrite('storage/vwa/current-project.json', root)).toBe(true)
    expect(grantAdmitsWritePath(g, 'storage/vwa/current-project.json')).toBe(false)
    expect(isVwaStateWrite('.dsh/vwa/batches/b1/input.json', root)).toBe(false)
    expect(grantAdmitsWritePath(g, '.dsh/vwa/batches/b1/input.json')).toBe(true)
  })
})

/** Well-formed `prj_<uuid>` project segments (§3.2). */
const DRAFT_PROJECT = 'prj_11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT = 'prj_22222222-2222-4222-8222-222222222222'

function draftsRoot(): string {
  const root = workspace()
  mkdirSync(join(root, '.dsh/vwa', DRAFT_PROJECT, 'drafts'), { recursive: true })
  mkdirSync(join(root, '.dsh/vwa', OTHER_PROJECT, 'drafts'), { recursive: true })
  writeFileSync(join(root, '.dsh/vwa', DRAFT_PROJECT, 'adjudications.json'), '{}')
  return root
}

describe('task-grant canonical write boundary: the drafts carve-out (§3.2/§3.3)', () => {
  it('exempts a draft FILE of a well-formed project and keeps every other project path asking', () => {
    const root = draftsRoot()
    const g = grant(root, [`.dsh/vwa/${DRAFT_PROJECT}/drafts`])
    expect(isVwaStateWrite(`.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`, root)).toBe(false)
    expect(grantAdmitsWritePath(g, `.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`)).toBe(true)
    // A non-markdown neighbour, a nested path and a sibling state file are state.
    for (const target of [
      `.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.json`,
      `.dsh/vwa/${DRAFT_PROJECT}/drafts/sub/notes.md`,
      `.dsh/vwa/${DRAFT_PROJECT}/adjudications.json`,
    ]) {
      expect(isVwaStateWrite(target, root), target).toBe(true)
      expect(grantAdmitsWritePath(g, target), target).toBe(false)
    }
    // Another project's draft file needs no approval (§3.3 keys the exemption on
    // the path shape), but this grant names no segment of that project.
    expect(isVwaStateWrite(`.dsh/vwa/${OTHER_PROJECT}/drafts/notes.md`, root)).toBe(false)
    expect(grantAdmitsWritePath(g, `.dsh/vwa/${OTHER_PROJECT}/drafts/notes.md`)).toBe(false)
  })

  it('a draft-file symlink into authoritative state is judged on its destination', () => {
    const root = draftsRoot()
    const drafts = join(root, '.dsh/vwa', DRAFT_PROJECT, 'drafts')
    symlinkSync(join(root, '.dsh/vwa', DRAFT_PROJECT, 'adjudications.json'), join(drafts, 'notes.md'))
    const g = grant(root, [`.dsh/vwa/${DRAFT_PROJECT}/drafts`])
    expect(isVwaStateWrite(`.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`, root)).toBe(true)
    expect(grantAdmitsWritePath(g, `.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`)).toBe(false)
  })

  it('a drafts directory symlinked out of the state tree is an ordinary in-root write', () => {
    const root = draftsRoot()
    const drafts = join(root, '.dsh/vwa', DRAFT_PROJECT, 'drafts')
    rmSync(drafts, { recursive: true })
    mkdirSync(join(root, 'docs/reports'), { recursive: true })
    symlinkSync(join(root, 'docs/reports'), drafts)
    const g = grant(root, [`docs/reports`])
    expect(isVwaStateWrite(`.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`, root)).toBe(false)
    // The physical destination is the granted (non-state) prefix.
    expect(grantAdmitsWritePath(g, `.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`)).toBe(true)
  })

  it('a drafts prefix cannot be retargeted onto another project\'s state after approval', () => {
    const root = draftsRoot()
    const drafts = join(root, '.dsh/vwa', DRAFT_PROJECT, 'drafts')
    rmSync(drafts, { recursive: true })
    symlinkSync(join(root, '.dsh/vwa', OTHER_PROJECT, 'drafts'), drafts)
    const g = grant(root, [`.dsh/vwa/${DRAFT_PROJECT}/drafts`])
    // The alias resolves to the other project's drafts directory: the write is
    // a draft file there, so it asks for nobody and the grant's prefix (which
    // resolves to the same physical directory) admits it.
    expect(isVwaStateWrite(`.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`, root)).toBe(false)
    expect(grantAdmitsWritePath(g, `.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.md`)).toBe(true)
    // A non-draft file through the same alias is still authoritative state.
    expect(isVwaStateWrite(`.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.json`, root)).toBe(true)
    expect(grantAdmitsWritePath(g, `.dsh/vwa/${DRAFT_PROJECT}/drafts/notes.json`)).toBe(false)
  })
})
