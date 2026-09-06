import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearResumeTarget,
  legacyResumeMarkerFile,
  readResumeTarget,
  resumeMarkerFile,
  writeResumeTarget,
} from '@dsh-cc/tui/resume-target.ts'
import { __clearProjectCache, resolveProject } from '@dsh-cc/tui/project.ts'

/** Legacy (cwd-bucketed) key: sha256 of `resolve(cwd)`, first 16 hex. */
function legacyKeyOf(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
}

/**
 * New project-keyed marker path under `home`, derived via the authoritative
 * `resolveProject(cwd).projectKey` (so it tracks whatever project.ts does).
 */
function newMarker(home: string, cwd: string): string {
  return join(home, 'projects', resolveProject(cwd).projectKey, 'resume.txt')
}

/** Legacy cwd-bucketed marker path under `home`. */
function legacyMarker(home: string, cwd: string): string {
  return join(home, `resume-${legacyKeyOf(cwd)}.txt`)
}

/** Ensure a marker file's parent directory exists and (re)create the file. */
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Set a file's mtime (explicit ordering for the dual-read matrix). */
function setMtime(path: string, when: Date): void {
  utimesSync(path, when, when)
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

describe('resume markers: project + legacy paths', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('git repo: new marker lands in projects/<sha256(repo root)[:16]>/resume.txt', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const repo = initGitRepo()
    expect(resumeMarkerFile({ home, cwd: repo })).toBe(newMarker(home, repo))
  })

  it('linked worktree shares the main root marker path', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const repo = initGitRepo()
    const wt = addWorktree(repo, 'feat')
    // Main root and its worktree resolve to the same project → same marker.
    expect(resumeMarkerFile({ home, cwd: repo })).toBe(newMarker(home, repo))
    expect(resumeMarkerFile({ home, cwd: wt })).toBe(newMarker(home, repo))
  })

  it('non-git dir: key is sha256(resolve(cwd))[:16], path under projects/', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const cwd = tmpDir('dsh-plain-')
    expect(resumeMarkerFile({ home, cwd })).toBe(newMarker(home, cwd))
  })

  it('legacy marker path is the cwd-bucketed resume-<hash>.txt', () => {
    const home = tmpDir('dsh-cc-rm-home-')
    const cwd = '/some/dir'
    expect(legacyResumeMarkerFile({ home, cwd })).toBe(legacyMarker(home, cwd))
    // legacyCwd overrides cwd for the legacy bucket.
    expect(legacyResumeMarkerFile({ home, cwd, legacyCwd: '/other' })).toBe(legacyMarker(home, '/other'))
  })
})

describe('readResumeTarget dual-read', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  function setup() {
    const home = tmpDir('dsh-cc-rm-rd-')
    const cwd = tmpDir('dsh-plain-')
    return { home, cwd }
  }

  it('returns the value when only the legacy marker exists', () => {
    const { home, cwd } = setup()
    put(legacyResumeMarkerFile({ home, cwd }), 'legacy-only\n')
    expect(readResumeTarget({ home, cwd })).toBe('legacy-only')
  })

  it('returns the value when only the new marker exists', () => {
    const { home, cwd } = setup()
    put(resumeMarkerFile({ home, cwd }), 'new-only\n')
    expect(readResumeTarget({ home, cwd })).toBe('new-only')
  })

  it('both present: legacy newer mtime wins', () => {
    const { home, cwd } = setup()
    const newFile = resumeMarkerFile({ home, cwd })
    const legFile = legacyResumeMarkerFile({ home, cwd })
    put(newFile, 'new-session\n')
    put(legFile, 'legacy-session\n')
    setMtime(newFile, new Date(1000))
    setMtime(legFile, new Date(2000))
    expect(readResumeTarget({ home, cwd })).toBe('legacy-session')
  })

  it('both present: new marker mtime wins', () => {
    const { home, cwd } = setup()
    const newFile = resumeMarkerFile({ home, cwd })
    const legFile = legacyResumeMarkerFile({ home, cwd })
    put(newFile, 'new-session\n')
    put(legFile, 'legacy-session\n')
    setMtime(newFile, new Date(3000))
    setMtime(legFile, new Date(2000))
    expect(readResumeTarget({ home, cwd })).toBe('new-session')
  })

  it('both present, equal mtime: new marker wins (tie → new)', () => {
    const { home, cwd } = setup()
    const newFile = resumeMarkerFile({ home, cwd })
    const legFile = legacyResumeMarkerFile({ home, cwd })
    put(newFile, 'new-session\n')
    put(legFile, 'legacy-session\n')
    setMtime(newFile, new Date(5000))
    setMtime(legFile, new Date(5000))
    expect(readResumeTarget({ home, cwd })).toBe('new-session')
  })

  it('newer-but-blank legacy + older non-blank new → new value', () => {
    const { home, cwd } = setup()
    const newFile = resumeMarkerFile({ home, cwd })
    const legFile = legacyResumeMarkerFile({ home, cwd })
    put(newFile, 'new-session\n')
    put(legFile, '   \n') // blank legacy is discarded regardless of mtime
    setMtime(newFile, new Date(1000))
    setMtime(legFile, new Date(9999))
    expect(readResumeTarget({ home, cwd })).toBe('new-session')
  })

  it('both absent or blank → undefined', () => {
    const { home, cwd } = setup()
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
    put(legacyResumeMarkerFile({ home, cwd }), '\n')
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
  })
})

describe('writeResumeTarget dual-write + idempotence', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('writes both the new and the legacy marker (legacyCwd defaults to cwd)', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = tmpDir('dsh-plain-')
    writeResumeTarget('sess-1', { home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-1')
    expect(readFileSync(legacyResumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-1')
  })

  it('distinct cwd and legacyCwd: legacy lands in legacyCwd bucket, new in cwd project', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = '/repo/main'
    const legacyCwd = '/launch-dir'
    writeResumeTarget('sess-x', { home, cwd, legacyCwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-x')
    expect(readFileSync(legacyResumeMarkerFile({ home, cwd, legacyCwd }), 'utf8').trim()).toBe('sess-x')
  })

  it('git fixture: project marker uses repo root key, legacy uses exact cwd', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const repo = initGitRepo()
    const cwd = join(repo, 'subdir')
    mkdirSync(cwd, { recursive: true })
    writeResumeTarget('sess-g', { home, cwd })
    // New marker is keyed by the repo root (project), not the exact cwd.
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-g')
    expect(readFileSync(resumeMarkerFile({ home, cwd: repo }), 'utf8').trim()).toBe('sess-g')
    expect(readFileSync(newMarker(home, repo), 'utf8').trim()).toBe('sess-g')
    // Legacy marker is keyed by the exact cwd (resolve(cwd)).
    expect(readFileSync(legacyMarker(home, cwd), 'utf8').trim()).toBe('sess-g')
  })

  it('idempotent on the new marker: same id second write is a no-op, legacy untouched', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = tmpDir('dsh-plain-')
    const newFile = resumeMarkerFile({ home, cwd })
    const legFile = legacyResumeMarkerFile({ home, cwd })
    writeResumeTarget('sess-k', { home, cwd })
    const newMtime = mtimeMs(newFile)
    // Clobber the legacy marker to a different id — dedupe must IGNORE it.
    writeFileSync(legFile, 'clobbered\n')
    setMtime(legFile, new Date(9999999))
    writeResumeTarget('sess-k', { home, cwd })
    // New marker untouched (idempotent) …
    expect(mtimeMs(newFile)).toBe(newMtime)
    expect(readFileSync(newFile, 'utf8').trim()).toBe('sess-k')
    // … and the legacy marker is NOT rewritten either.
    expect(readFileSync(legFile, 'utf8').trim()).toBe('clobbered')
  })

  it('a different id updates both markers', () => {
    const home = tmpDir('dsh-cc-rm-w-')
    const cwd = tmpDir('dsh-plain-')
    writeResumeTarget('sess-a', { home, cwd })
    writeResumeTarget('sess-b', { home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-b')
    expect(readFileSync(legacyResumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('sess-b')
    expect(readResumeTarget({ home, cwd })).toBe('sess-b')
  })
})

describe('clearResumeTarget', () => {
  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('blanks both markers and read returns undefined', () => {
    const home = tmpDir('dsh-cc-rm-c-')
    const cwd = tmpDir('dsh-plain-')
    writeResumeTarget('sess-c', { home, cwd })
    clearResumeTarget({ home, cwd })
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('')
    expect(readFileSync(legacyResumeMarkerFile({ home, cwd }), 'utf8').trim()).toBe('')
    expect(readResumeTarget({ home, cwd })).toBeUndefined()
  })
})
