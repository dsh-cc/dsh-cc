import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
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
