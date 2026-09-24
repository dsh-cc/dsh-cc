import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FsObservation, FsTarget, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillCc from '../src/index.ts'

async function tempDir(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `dsh-ccprov-${name}-`))
}

async function writeSkill(root: string, name: string, frontmatter: string, body = 'Body.\n'): Promise<string> {
  await mkdir(join(root, name), { recursive: true })
  const path = join(root, name, 'SKILL.md')
  await writeFile(path, `---\n${frontmatter}\n---\n\n${body}`, 'utf8')
  return path
}

async function setup(config: SkillCc.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillCc, config)
  return ctx
}

describe('dsh-skill-claude-code plugin', () => {
  it('declares stable plugin metadata', () => {
    expect(SkillCc.name).toBe('skill-claude-code')
    expect(SkillCc.inject).toEqual(['skills'])
  })

  it('discovers and loads a management-managed provider opinion rooted skill', async () => {
    const home = await tempDir('home')
    const managed = await tempDir('managed')
    const project = await tempDir('proj')
    await mkdir(join(project, '.git'), { recursive: true })

    const managePath = await writeSkill(managed, 'manage-skill', 'name: manage-skill\ndescription: A managed skill')
    const projPath = await writeSkill(join(project, '.claude', 'skills'), 'proj-skill', 'name: proj-skill\ndescription: A project skill')
    const userPath = await writeSkill(join(home, 'skills'), 'user-skill', 'name: user-skill\ndescription: A user skill')

    const ctx = await setup({ dshHome: home, managedDir: managed })
    const skills = await ctx.skills.list({ cwd: project })
    const names = skills.map(s => s.name)
    expect(names).toContain('manage-skill')
    expect(names).toContain('proj-skill')
    expect(names).toContain('user-skill')

    const loaded = await ctx.skills.get('proj-skill', { cwd: project })
    expect(loaded?.content).toBe('Body.\n')
    expect(loaded?.metadata?.deprecated).toBe(false)
    void managePath
    void projPath
    void userPath
  })

  it('marks disable-model-invocation skills as model-hidden', async () => {
    const project = await tempDir('proj')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(
      join(project, '.claude', 'skills'),
      'hidden-skill',
      'name: hidden-skill\ndescription: Hidden\ndisable-model-invocation: true',
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    const loaded = await ctx.skills.get('hidden-skill', { cwd: project })
    expect(loaded?.invocation.modelInvocable).toBe(false)
    expect(loaded?.invocation.userInvocable).toBe(true)
  })

  it('exposes forks, tool restrictions, and paths in metadata', async () => {
    const project = await tempDir('proj')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(
      join(project, '.claude', 'skills'),
      'rich-skill',
      [
        'name: rich-skill',
        'description: Rich',
        'allowed-tools: Bash, Read',
        'context: fork',
        'paths:',
        '  - "src/**"',
        'arguments: query mode',
      ].join('\n'),
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    // `paths` gates this skill into conditional activation: activate it via a
    // matching Read touch before loading its full metadata.
    await ctx.skills.list({ cwd: project })
    ctx.emit(
      'fs/observed',
      { targetKey: FsTargetKey(join(project, 'src', 'app.ts')), displayPath: join(project, 'src', 'app.ts') } satisfies FsTarget,
      { kind: 'present', version: FsVersion('1') } satisfies FsObservation,
      { name: 'read' },
    )
    const loaded = await ctx.skills.get('rich-skill', { cwd: project })
    expect(loaded?.metadata).toMatchObject({
      allowedTools: ['Bash', 'Read'],
      executionContext: 'fork',
      paths: ['src'],
      arguments: ['query', 'mode'],
    })
    expect(SkillCc.ccRestriction(loaded?.metadata?.allowedTools as string[])).toEqual({
      allow: ['bash', 'read', 'read_image'],
    })
  })

  it('surfaces legacy commands as deprecated', async () => {
    const project = await tempDir('proj')
    await mkdir(join(project, '.git'), { recursive: true })
    const commandsDir = join(project, '.claude', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'old-cmd.md'), '---\nname: old-cmd\ndescription: Legacy\n---\n\nOld.\n')
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    const loaded = await ctx.skills.get('old-cmd', { cwd: project })
    expect(loaded?.metadata).toMatchObject({ deprecated: true })
  })

  it('shows a learned skill only after the skills/learned-changed refresh (§4.5)', async () => {
    const home = await tempDir('home')
    const project = await tempDir('proj')
    await mkdir(join(project, '.git'), { recursive: true })
    const ctx = await setup({ dshHome: home })

    // (1) populate the registry collectCache before any write.
    await ctx.skills.list({ cwd: project })

    // (2) write a learned SKILL.md without emitting → still absent.
    await writeSkill(join(home, 'learned-skills'), 'fresh-learned', 'name: fresh-learned\ndescription: A fresh learned skill')
    const stale = (await ctx.skills.list({ cwd: project })).map(s => s.name)
    expect(stale).not.toContain('fresh-learned')

    // (3) emit the refresh event → now visible with source `learned`.
    ctx.emit('skills/learned-changed')
    const fresh = await ctx.skills.list({ cwd: project })
    const learned = fresh.find(s => s.name === 'fresh-learned')
    expect(learned).toBeDefined()
    expect(learned?.source).toBe('learned')
  })
})
