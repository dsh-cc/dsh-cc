/**
 * The REAL `packages/plugin/dsh-cc-writing` plugin mounted through
 * `mountCcPlugin` — installation/discovery regression for the official
 * writing plugin (plan docs/plans/2026-10-25-writing-harness-plugin.md §3,
 * §12 step 6):
 *
 * - the three public skills register with model invocation and user
 *   invocation enabled, and their descriptions carry the trigger sentences;
 * - `writing-workflow` is a supporting skill: model invocation is disabled
 *   and it is NOT user-invocable, so it never shows up as a separate task;
 * - every skill resolves its resources from its own installed directory.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { mountCcPlugin } from '../src/index.ts'

/** The real plugin dir, resolved from this test file to the repo root. */
const REAL_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/dsh-cc-writing')

const PUBLIC_SKILLS = ['article-writing', 'article-review', 'language-editing']

/** A capture-only subagent seam: the writing plugin ships no agents. */
const subagentsSeam = () => ({
  registerProvider: () => () => {},
  getProvider: () => undefined,
})

describe('mountCcPlugin on the real dsh-cc-writing plugin', () => {
  it('discovers the three public skills and the supporting workflow skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const mount = await mountCcPlugin(ctx, {
      root: REAL_PLUGIN_DIR,
      seams: { subagents: subagentsSeam() as never },
    })
    try {
      expect(mount.report.name).toBe('dsh-cc-writing')
      const skills = mount.report.components.find(component => component.kind === 'skills')
      expect(skills?.loaded).toBe(4)
      expect(skills?.failed).toBe(0)

      const listed = (await ctx.skills.list()).map(skill => skill.name)
      for (const name of [...PUBLIC_SKILLS, 'writing-workflow']) {
        expect(listed, name).toContain(name)
      }
    } finally {
      mount.dispose()
    }
  })

  it('keeps the public skills model-invocable and user-invocable with trigger descriptions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const mount = await mountCcPlugin(ctx, {
      root: REAL_PLUGIN_DIR,
      seams: { subagents: subagentsSeam() as never },
    })
    try {
      for (const name of PUBLIC_SKILLS) {
        const skill = await ctx.skills.get(name)
        expect(skill, name).toBeDefined()
        expect(skill?.invocation.modelInvocable, name).toBe(true)
        expect(skill?.invocation.userInvocable, name).toBe(true)
        expect(skill?.description, name).toBeTruthy()
        expect(skill?.resourceBase).toEqual({
          kind: 'directory',
          path: resolve(REAL_PLUGIN_DIR, 'skills', name),
        })
      }
      // The trigger sentences must reach the catalog, not only the file.
      expect((await ctx.skills.get('article-writing'))?.description).toContain('写文章')
      expect((await ctx.skills.get('article-review'))?.description).toContain('文章评审')
      expect((await ctx.skills.get('language-editing'))?.description).toContain('润色')
    } finally {
      mount.dispose()
    }
  })

  it('the supporting workflow skill is not a separate user task', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const mount = await mountCcPlugin(ctx, {
      root: REAL_PLUGIN_DIR,
      seams: { subagents: subagentsSeam() as never },
    })
    try {
      const workflow = await ctx.skills.get('writing-workflow')
      expect(workflow).toBeDefined()
      expect(workflow?.invocation.modelInvocable).toBe(false)
      expect(workflow?.invocation.userInvocable).toBe(false)
      // Public skills read it by relative path from the installed directory.
      const writing = await ctx.skills.get('article-writing')
      expect(writing?.content).toContain('../writing-workflow/SKILL.md')
    } finally {
      mount.dispose()
    }
  })
})
