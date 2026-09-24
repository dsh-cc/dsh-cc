/**
 * Trigger frontmatter (turn-rules, plan docs/plans/2026-09-23-turn-rules.md
 * §4.1): `parseRuleFile` populates the four optional keys straight off the
 * preserved frontmatter record; a malformed value skips the rule with a tally
 * warning — never a load failure. Rules without a trigger are byte-for-byte
 * unaffected (fields stay `undefined`, `mountRules` unchanged).
 *
 * @module
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComponentTally } from '../src/seams.ts'
import { parseRuleFile } from '../src/rules.ts'
import { mountRules } from '../src/rules.ts'
import { parsePluginManifest } from '../src/manifest.ts'
import type { RulesSeam } from '../src/seams.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function ruleFile(frontmatter: string, body = 'Rule body text.'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'turn-rule-'))
  dirs.push(dir)
  const file = join(dir, 'rule.mdc')
  await writeFile(file, `---\n${frontmatter}\n---\n\n${body}`, 'utf8')
  return file
}

const tallyOf = () => new ComponentTally('rules')

describe('parseRuleFile trigger keys', () => {
  it('populates trigger, triggerOn, repeat, repeatGap from frontmatter', async () => {
    const file = await ruleFile('description: d\ntrigger: "\\\\bBox::leak\\\\b"\ntriggerOn: [tool-results, user-prompts]\nrepeat: after-gap\nrepeatGap: 10')
    const entry = await parseRuleFile(file, tallyOf(), [])
    expect(entry).toMatchObject({
      trigger: '\\bBox::leak\\b',
      triggerOn: ['tool-results', 'user-prompts'],
      repeat: 'after-gap',
      repeatGap: 10,
    })
   expect(entry?.body).toContain('Rule body text.')
  })

  it('defaults triggerOn to both and repeat to once (fields stay undefined)', async () => {
    const file = await ruleFile('trigger: "foo"')
    const entry = await parseRuleFile(file, tallyOf(), [])
    expect(entry?.trigger).toBe('foo')
    expect(entry?.triggerOn).toBeUndefined()
    expect(entry?.repeat).toBeUndefined()
    expect(entry?.repeatGap).toBeUndefined()
  })

  it('leaves trigger-less rules byte-unaffected', async () => {
    const file = await ruleFile('description: d\nalwaysApply: true\nglobs: "**/*.ts"')
    const warnings: string[] = []
    const entry = await parseRuleFile(file, tallyOf(), warnings)
    expect(entry).toMatchObject({ description: 'd', alwaysApply: true, globs: ['**/*.ts'] })
    expect(entry?.trigger).toBeUndefined()
    expect(entry?.triggerOn).toBeUndefined()
    expect(entry?.repeat).toBeUndefined()
    expect(entry?.repeatGap).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it.each([
    ['non-string trigger', 'trigger: 42'],
    ['invalid regex source', 'trigger: "[unclosed"'],
    ['unknown triggerOn enum', 'trigger: "x"\ntriggerOn: [assistant-text]'],
    ['unknown repeat enum', 'trigger: "x"\nrepeat: always'],
    ['zero repeatGap', 'trigger: "x"\nrepeatGap: 0'],
    ['negative repeatGap', 'trigger: "x"\nrepeatGap: -3'],
    ['non-integer repeatGap', 'trigger: "x"\nrepeatGap: 1.5'],
  ])('skips the rule with a tally warning: %s', async (_label, frontmatter) => {
    const file = await ruleFile(frontmatter)
    const tally = tallyOf()
    const warnings: string[] = []
    const entry = await parseRuleFile(file, tally, warnings)
    expect(entry).toBeUndefined()
    expect(tally.result().skipped).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('skipped rule')
  })
})

describe('mountRules regression with trigger-bearing rules', () => {
  it('passes triggered and trigger-less entries through the seam unchanged; malformed skips', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turn-mount-'))
    dirs.push(root)
    await mkdir(join(root, 'rules'), { recursive: true })
    await writeFile(join(root, 'rules', 'good.mdc'), '---\ndescription: g\ntrigger: "PATTERN_XYZ"\n---\n\nTriggered body.\n', 'utf8')
    await writeFile(join(root, 'rules', 'plain.mdc'), '---\nalwaysApply: true\n---\n\nPlain body.\n', 'utf8')
    await writeFile(join(root, 'rules', 'bad.mdc'), '---\ntrigger: "[bad"\n---\n\nBad body.\n', 'utf8')
    const merged: { entries: { path: string; trigger?: string; alwaysApply: boolean }[] }[] = []
    const seam: RulesSeam = {
      mergePluginRules: (_name, entries) => {
        merged.push({ entries: entries as never })
        return () => {}
      },
    } as unknown as RulesSeam
    const manifest = parsePluginManifest({ name: 'fixture', rules: 'rules' }, 'fixture', { flavor: 'cursor' })
    const mount = await mountRules({ pluginRoot: root, manifest, rules: seam })
    expect(merged).toHaveLength(1)
    const entries = merged[0]!.entries
    expect(entries).toHaveLength(2)
    expect(entries.find(e => e.path === 'rules/good.mdc')).toMatchObject({ trigger: 'PATTERN_XYZ', alwaysApply: false })
    const plain = entries.find(e => e.path === 'rules/plain.mdc')
    expect(plain).toMatchObject({ alwaysApply: true })
    expect('trigger' in plain!).toBe(false)
    // The malformed regex skipped with a warning; the mount itself never failed.
    expect(mount.warnings).toHaveLength(1)
    expect(mount.warnings[0]).toContain('valid regex')
    expect(mount.tally.result().loaded).toBe(2)
    expect(mount.tally.result().skipped).toBe(1)
  })
})
