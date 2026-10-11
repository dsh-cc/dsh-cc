import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { parsePluginManifest } from '../src/manifest.ts'
import { mountSkills } from '../src/skills.ts'
import { registerSkillPathActivator, activationFor } from '../src/skill-semantics.ts'
import { tempPluginRoot, writeSkill, writeFileAt, makeContext } from './helpers.ts'

function manifest(extra: Record<string, unknown> = {}): ReturnType<typeof parsePluginManifest> {
  return parsePluginManifest({ name: 'p', ...extra }, 'p')
}

describe('mountSkills', () => {
  it('skips skills when the skill registry seam is absent', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'do-thing', { name: 'do-thing', description: 'Does a thing' })
      const ctx = makeContext()
      const { tally } = await mountSkills({ ctx, pluginRoot: root, manifest: manifest(), skills: undefined, subagentsPresent: true })
      expect(tally.result().skipped).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('discovers and registers skills from the standard skills/ directory', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'do-thing', {
        name: 'do-thing',
        description: 'Does a thing',
        'allowed-tools': 'read',
        paths: ['src/**/*.ts'],
      })
      const defs: SkillDefinition[] = []
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs[0]?.name).toBe('do-thing')
      expect(defs[0]?.description).toBe('Does a thing')
      const metadata = defs[0]?.metadata as Record<string, unknown> | undefined
      expect(metadata?.['allowedTools']).toEqual(['read'])
      expect(metadata?.['paths']).toEqual(['src/**/*.ts'])
    } finally {
      await dispose()
    }
  })

  it('reports a skill with an invalid registry name as failed', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'Bad Name', { name: 'Bad Name', description: 'x' })
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: () => () => {} },
        subagentsPresent: true,
      })
      expect(tally.result().failed).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('falls back to the frontmatter name when the skill root basename is not a valid registry name', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      // A versioned plugin install directory: `"skills": ["./"]` makes the
      // plugin root itself the skill directory, so the directory-derived name
      // is the version, `3.1.0`. Frontmatter mirrors a real single-skill
      // release: block-scalar description plus unknown license/metadata keys.
      await writeFileAt(root, '3.1.0/SKILL.md', [
        '---',
        'name: prose-cleanup',
        'description: |',
        '  Rewrite AI-sounding text so it reads like the writer without changing',
        '  what it says.',
        'license: MIT',
        'metadata:',
        '  version: "3.1.0"',
        '---',
        '',
        'Rewrite AI-sounding text so it reads like the writer.',
      ].join('\n'))
      const defs: SkillDefinition[] = []
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: join(root, '3.1.0'),
        manifest: manifest({ skills: ['./'] }),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().failed).toBe(0)
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(def => def.name)).toEqual(['prose-cleanup'])
      expect(defs[0]?.description).toContain('Rewrite AI-sounding text')
      expect(defs[0]?.content).toContain('Rewrite AI-sounding text')
    } finally {
      await dispose()
    }
  })

  it('falls back to the frontmatter name for a non-kebab skill directory', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'My_Skill/SKILL.md', ['---', 'name: my-skill', 'description: x', '---', '', 'Body.'].join('\n'))
      const defs: SkillDefinition[] = []
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest({ skills: ['./My_Skill'] }),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(def => def.name)).toEqual(['my-skill'])
    } finally {
      await dispose()
    }
  })

  it('still fails a root skill with no valid name in the directory or the frontmatter', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '3.1.0/SKILL.md', ['---', 'description: x', '---', '', 'Body.'].join('\n'))
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: join(root, '3.1.0'),
        manifest: manifest({ skills: ['./'] }),
        skills: { register: () => () => {} },
        subagentsPresent: true,
      })
      const result = tally.result()
      expect(result.failed).toBe(1)
      expect(result.reasons[0]).toContain('3.1.0')
      expect(result.reasons[0]).toContain('absent')
    } finally {
      await dispose()
    }
  })

  it('reports no skills when the plugin ships none', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: () => () => {} },
        subagentsPresent: true,
      })
      expect(tally.result().skipped).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('discovers skills declared in manifest skills paths', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.claude/skills/inline-skill/SKILL.md', '---\nname: inline-skill\ndescription: Inline skill\n---')
      const ctx = makeContext()
      const defs: SkillDefinition[] = []
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest({ skills: ['./.claude/skills'] }),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs[0]?.name).toBe('inline-skill')
    } finally {
      await dispose()
    }
  })

  it('loads listed skill directories and skips the default skills/ when replace-default', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'xlsx', { name: 'xlsx', description: 'Excel' })
      await writeSkill(root, 'pdf', { name: 'pdf', description: 'PDF' })
      const ctx = makeContext()
      const defs: SkillDefinition[] = []
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: parsePluginManifest(
          { name: 'p', skills: ['./skills/xlsx'] },
          'p',
          { skillsReplaceDefault: true },
        ),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(d => d.name)).toEqual(['xlsx'])
    } finally {
      await dispose()
    }
  })
})

describe('registerSkillPathActivator', () => {
  it('registers a path activator that returns a disposer', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'src/a.ts', 'let x = 1')
      const ctx = makeContext()
      const definition = {
        name: 'do-thing',
        content: 'body',
        metadata: { paths: ['src/**/*.ts'] },
      } as never
      const disposer = registerSkillPathActivator(ctx, definition as never, root)
      expect(typeof disposer).toBe('function')
      disposer()
    } finally {
      await dispose()
    }
  })

  it('returns a no-op disposer for a skill with no paths', () => {
    const ctx = makeContext()
    const definition = { name: 'p', content: 'body', metadata: {} } as never
    const disposer = registerSkillPathActivator(ctx, definition as never, '/tmp')
    disposer()
    expect(true).toBe(true)
  })
})

describe('mountSkills wiring', () => {
  it('wires activation descriptors for discovered skills', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'forky', { name: 'forky', description: 'fork', context: 'fork' })
      const ctx = makeContext()
      const defs: SkillDefinition[] = []
      await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      const metadata = defs[0]?.metadata as Record<string, unknown> | undefined
      const activation = activationFor(metadata as never, true)
      expect(activation.execution).toBe('fork')
    } finally {
      await dispose()
    }
  })
})
