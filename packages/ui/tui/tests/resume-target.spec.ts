import { execSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearResumeTarget,
  readResumeTarget,
  resumeMarkerFile,
  writeResumeTarget,
} from '@dsh-cc/tui/resume-target.ts'
import { __clearProjectCache, resolveProject } from '@dsh-cc/tui/project.ts'

/**
 * Project-keyed marker path under `home`, derived via the authoritative
 * `resolveProject(cwd).projectKey` (so it tracks whatever project.ts does).
 */
function markerPath(home: string, cwd: string): string {
  return join(home, 'projects', resolveProject(cwd).projectKey, 'resume.txt')
}

function mtimeMs(path: string): number {
  return statSync(path).mtimeMs
}

/** A throwaway, non-git working directory for non-repo cases. */
function tmpDir(prefix = 'dsh-cc-resume-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Create a real local git repo (with one commit) and return its root. */
function initGitRepo(prefix = 'dsh-repo-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  execSync('git init -q', { cwd: root })
  execSync('git config commit.gpgsign false', { cwd: root })
  execSync('git config user.email t@example.com', { cwd: root })
  execSync('git config user.name tester', { cwd: root })
  writeFileSync(join(root, 'a.txt'), 'a\n')
  execSync('git add a.txt && git commit -qm init', { cwd: root })
  return root
}

/** Add a linked worktree of `repoRoot` and return its path. */
function addWorktree(repoRoot: string, name = 'wt'): string {
  const path = join(repoRoot, `.wt-${name}`)
  execSync(`git worktree add -q -b ${name} ${path} HEAD`, { cwd: repoRoot })
  return path
}

describe('resume markers: project path', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('git repo: marker lands in projects/<sha256(repo root)[:16]>/resume.txt', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const repo = initGitRepo()
    expect(resumeMarkerFile({ home, cwd: repo })).toBe(markerPath(home, repo))
  })

  it('linked worktree shares the main root marker path', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const repo = initGitRepo()
    const wt = addWorktree(repo, 'feat')
    expect(resumeMarkerFile({ home, cwd: repo })).toBe(markerPath(home, repo))
    expect(resumeMarkerFile({ home, cwd: wt })).toBe(markerPath(home, repo))
  })

  it('non-git dir: key is sha256(resolve(cwd))[:16], path under projects/', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const cwd = tmpDir('dsh-plain-')
    expect(resumeMarkerFile({ home, cwd })).toBe(markerPath(home, cwd))
  })
})

describe('readResumeTarget', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  function setup() {
    const home = tmpDir('dsh-cc-rm-rd-')
    const cwd = tmpDir('dsh-plain-')
    return { home, cwd }
  }

  it('returns the value when the marker exists', () => {
    const { home, cwd } = setup()
    writeResumeTarget('new-only', { home, cwd })
    expect(readResumeTarget({ home, cwd })).toBe('new-only')
  })

  it('absent or blank → undefined', () => {
    const { home, cwd } = setup()
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
    writeFileSync(resumeMarkerFile({ home, cwd }), '\n')
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
  })
})

describe('writeResumeTarget + idempotence', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('writes the project-keyed marker', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = tmpDir('dsh-plain-')
    writeResumeTarget('sess-1', { home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-1')
  })

  it('git fixture: project marker uses repo root key', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const repo = initGitRepo()
    const cwd = join(repo, 'subdir')
    mkdirSync(cwd, { recursive: true })
    writeResumeTarget('sess-g', { home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-g')
    expect(readFileSync(resumeMarkerFile({ home, cwd: repo }), 'utf8').trim()).toBe('sess-g')
    expect(readFileSync(markerPath(home, repo), 'utf8').trim()).toBe('sess-g')
  })

  it('idempotent: same id second write is a no-op', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = tmpDir('dsh-plain-')
    const file = resumeMarkerFile({ home, cwd })
    writeResumeTarget('sess-k', { home, cwd })
    const firstMtime = mtimeMs(file)
    writeResumeTarget('sess-k', { home, cwd })
    expect(mtimeMs(file)).toBe(firstMtime)
    expect(readFileSync(file, 'utf8').trim()).toBe('sess-k')
  })

  it('a different id updates the marker', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = tmpDir('dsh-plain-')
    writeResumeTarget('sess-a', { home, cwd })
    writeResumeTarget('sess-b', { home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-b')
    expect(readResumeTarget({ home, cwd })).toBe('sess-b')
  })
})

describe('clearResumeTarget', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('blanks the marker and read returns undefined', () => {
    const home = tmpDir('dsh-cc-rm-c-')
    const cwd = tmpDir('dsh-plain-')
    writeResumeTarget('sess-c', { home, cwd })
    clearResumeTarget({ home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('')
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
  })
})
