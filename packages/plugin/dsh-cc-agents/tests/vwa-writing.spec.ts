/** Exercise the shipped preflight without host services or repository source imports. */
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const pkg = resolve(import.meta.dirname, '..')
const skill = join(pkg, 'skills/vwa-writing')
const toolNames = ['evidence.register', 'evidence.search_log', 'argument.update', 'argument.review', 'argument.report']
const projectId = 'prj_11111111-1111-4111-8111-111111111111'
const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vwa-skill-'))
  dirs.push(dir)
  const home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const settings = { 'vwa-argument': { 'semantic-enabled': true }, privateKey: 'must-not-leak' }
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  const current = join(workspace, '.dsh/vwa')
  mkdirSync(current, { recursive: true })
  writeFileSync(
    join(current, 'current-project.json'),
    JSON.stringify({ schemaVersion: 1, projectId, workspaceIdentity: 'a'.repeat(64) }),
  )
  mkdirSync(join(current, projectId), { recursive: true })
  writeFileSync(join(current, projectId, 'HEAD.json'), JSON.stringify({ revision: 1 }))
  return { dir, home, workspace, settings, current }
}
function run(f: ReturnType<typeof fixture>, tools: string[] = toolNames, base = skill) {
  const r = spawnSync(
    process.execPath,
    [join(base, 'scripts/preflight.mjs'), '--workspace', f.workspace, '--dsh-home', f.home, '--tools', tools.join(',')],
    { encoding: 'utf8' },
  )
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('VWA writing prerequisites', () => {
  it('returns only public readiness data and does not change files', () => {
    const f = fixture(),
      before = readFileSync(join(f.home, 'settings.json'), 'utf8')
    const result = run(f)
    expect(result).toMatchObject({ status: 'ready-for-tools', projectId, reviewerAlias: 'sonnet', blockers: [] })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe(before)
  })
  it('reports all missing conditions together without creating a project or changing settings', () => {
    const f = fixture()
    writeFileSync(
      join(f.home, 'settings.json'),
      JSON.stringify({ 'vwa-argument': { 'semantic-enabled': false }, 'vwa-evidence': { enabled: false } }),
    )
    rmSync(join(f.current, 'current-project.json'))
    const result = run(f, [])
    expect(result.status).toBe('blocked')
    expect(result.blockers.map((b: any) => b.code).sort()).toEqual([
      'EVIDENCE_DISABLED',
      'NO_PROJECT',
      'SEMANTIC_DISABLED',
      'TOOLS_MISSING',
    ])
    expect(existsSync(join(f.current, 'current-project.json'))).toBe(false)
  })
  it('does not treat enabled settings as proof that the host mounted the tools', () => {
    const result = run(fixture(), ['argument.review'])
    expect(result.status).toBe('blocked')
    expect(result.blockers[0]).toMatchObject({
      code: 'TOOLS_MISSING',
      missingTools: expect.arrayContaining(['argument.report']),
    })
  })
  it('rejects malformed settings and invalid project pointers without exposing their content', () => {
    const f = fixture()
    writeFileSync(join(f.home, 'settings.json'), '{privateKey:must-not-leak')
    writeFileSync(
      join(f.current, 'current-project.json'),
      JSON.stringify({ schemaVersion: 1, projectId: '../../elsewhere' }),
    )
    const result = run(f)
    expect(result.status).toBe('blocked')
    expect(result.blockers.map((b: any) => b.code)).toEqual(
      expect.arrayContaining(['SETTINGS_INVALID', 'PROJECT_INVALID']),
    )
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })
  it('requires runtime project metadata rather than accepting a pointer alone', () => {
    const f = fixture()
    rmSync(join(f.current, projectId, 'HEAD.json'))
    expect(run(f).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PROJECT_INVALID' })]))
  })
  it('rejects unknown command options instead of ignoring a misspelled prerequisite', () => {
    const r = spawnSync(process.execPath, [join(skill, 'scripts/preflight.mjs'), '--toolz', 'argument.review'], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Unknown option')
  })
})

describe('published VWA writing skill', () => {
  it('ships both README languages and can load relative resources outside the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vwa-plugin-pack-'))
    dirs.push(dir)
    const result = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {
        cwd: pkg,
        encoding: 'utf8',
      }),
    )[0]
    const paths = result.files.map((f: any) => f.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'README.md',
        'README.zh.md',
        'skills/vwa-writing/SKILL.md',
        'skills/vwa-writing/references/tool-contract.md',
        'skills/vwa-writing/references/writing-rules.md',
        'skills/vwa-writing/scripts/preflight.mjs',
      ]),
    )
    execFileSync('tar', ['-xzf', join(dir, result.filename), '-C', dir])
    const unpacked = join(dir, 'package/skills/vwa-writing')
    expect(readFileSync(join(unpacked, 'references/tool-contract.md'), 'utf8')).toContain('argument.review')
    expect(run(fixture(), toolNames, unpacked).status).toBe('ready-for-tools')
  }, 20_000)
})
