import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverCcRoots,
  discoverCcSkills,
  type CcSkillFile,
} from '../src/discovery.ts'

async function tempDir(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `dsh-cc-${name}-`))
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`)
}

async function writeFlatMd(dir: string, file: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const name = file.replace(/\.md$/, '')
  await writeFile(join(dir, file), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`)
}

describe('discoverCcRoots', () => {
  it('orders managed, user, project, then additional roots', async () => {
    const home = await tempDir('home')
    const proj = await tempDir('proj')
    await mkdir(join(proj, '.git'), { recursive: true })
    const roots = await discoverCcRoots({
      dshHome: home,
      projectCwd: proj,
      additionalDirs: [join(proj, '.claude-add')],
    })
    const sources = roots.map(r => r.source)
    // project roots precede user; additional comes last.
    expect(sources.indexOf('project')).toBeLessThan(sources.indexOf('user'))
    expect(sources.indexOf('user')).toBeLessThan(sources.indexOf('additional'))
  })

  it('walks project dirs up to home stopping at the git root', async () => {
    const home = await tempDir('home')
    await mkdir(join(home, '.git'), { recursive: true })
    const proj = join(home, 'nested', 'deep')
    await mkdir(proj, { recursive: true })
    const roots = await discoverCcRoots({ dshHome: home, projectCwd: proj, additionalDirs: [] })
    const project = roots.filter(r => r.source === 'project')
    expect(project.length).toBeGreaterThan(0)
    expect(project[0]?.path).toBe(join(home, '.claude', 'skills'))
  })
})

describe('discoverCcSkills', () => {
  it('discovers directory skills with realpath dedup', async () => {
    const home = await tempDir('home')
    const userRoot = join(home, 'skills')
    await writeSkill(userRoot, 'user-skill', 'A user skill')
    await writeSkill(userRoot, 'dup-skill', 'Original')

    const proj = await tempDir('proj')
    await mkdir(join(proj, '.git'), { recursive: true })
    const projRoot = join(proj, '.claude', 'skills')
    await mkdir(projRoot, { recursive: true })
    // A symlink that resolves to the same real file as userRoot/dup-skill.
    await symlink(join(userRoot, 'dup-skill'), join(projRoot, 'dup-skill'), 'dir')
    await writeSkill(projRoot, 'proj-skill', 'A project skill')

    const skills = await discoverCcSkills({
      dshHome: home,
      projectCwd: proj,
      additionalDirs: [],
    })
    const names = skills.map(s => s.name)
    expect(names).toContain('user-skill')
    expect(names).toContain('proj-skill')
    // dup-skill appears once despite the symlink duplicate.
    expect(names.filter(n => n === 'dup-skill')).toHaveLength(1)
  })

  it('discovers legacy .claude/commands marked deprecated', async () => {
    const proj = await tempDir('proj')
    await mkdir(join(proj, '.git'), { recursive: true })
    const commandsDir = join(proj, '.claude', 'commands')
    await writeFlatMd(commandsDir, 'old-cmd.md', 'A legacy command')

    const skills = await discoverCcSkills({
      dshHome: await tempDir('home'),
      projectCwd: proj,
      additionalDirs: [],
    })
    const old = skills.find(s => s.name === 'old-cmd')
    expect(old).toBeDefined()
    expect(old?.deprecated).toBe(true)
  })

  it('includes additional directory skills last', async () => {
    const additional = await tempDir('add')
    const addRoot = join(additional, 'skills')
    await writeSkill(addRoot, 'extra-skill', 'Extra')
    const skills = await discoverCcSkills({
      dshHome: await tempDir('home'),
      projectCwd: await tempDir('proj'),
      additionalDirs: [addRoot],
    })
    const extra = skills.find((s: CcSkillFile) => s.name === 'extra-skill')
    expect(extra).toBeDefined()
    expect(extra?.source).toBe('additional')
  })

  it('orders the learned root last, below user/project/additional', async () => {
    const home = await tempDir('home')
    const proj = await tempDir('proj')
    await mkdir(join(proj, '.git'), { recursive: true })
    const roots = await discoverCcRoots({
      dshHome: home,
      projectCwd: proj,
      additionalDirs: [join(proj, '.claude-add')],
    })
    const sources = roots.map(r => r.source)
    expect(sources[sources.length - 1]).toBe('learned')
    expect(sources.indexOf('user')).toBeLessThan(sources.indexOf('additional'))
    expect(sources.indexOf('additional')).toBeLessThan(sources.indexOf('learned'))
    const learned = roots.find(r => r.source === 'learned')
    expect(learned?.path).toBe(join(home, 'learned-skills'))
    expect(learned?.rank).toBe(500)
  })

  it('discovers a learned skill with source learned and rank 500', async () => {
    const home = await tempDir('home')
    await writeSkill(join(home, 'learned-skills'), 'learned-skill', 'A learned skill')
    const skills = await discoverCcSkills({ dshHome: home, additionalDirs: [] })
    const learned = skills.find((s: CcSkillFile) => s.name === 'learned-skill')
    expect(learned).toBeDefined()
    expect(learned?.source).toBe('learned')
    expect(learned?.rank).toBe(500)
  })
})
