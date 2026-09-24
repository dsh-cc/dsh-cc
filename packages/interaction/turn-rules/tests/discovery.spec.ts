/**
 * Discovery-order determinism (plan §5): fixture plugins assert the
 * discovery→declaration→lexicographic order, cursor-flavor filtering, and the
 * trigger-less drop (§4.2).
 *
 * @module
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverTurnRules } from '../src/discovery.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** One cursor plugin root with a nested manifest and rule files. */
function pluginRoot(parent: string, name: string, rules: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const root = join(parent, name)
  mkdirSync(join(root, '.cursor-plugin'), { recursive: true })
  writeFileSync(join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest }), 'utf8')
  for (const [path, body] of Object.entries(rules)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body, 'utf8')
  }
  return root
}

describe('discoverTurnRules', () => {
  it('orders discovery → manifest declaration → lexicographic, filters flavor, drops trigger-less rules', async () => {
    const pool = tempDir('tr-discover-')
    // Discovered FIRST (dir order), but its rule is in the SECOND declared dir.
    pluginRoot(pool, 'alpha', {
      'rules/z-last.mdc': '---\ntrigger: "ALPHA_SECOND_DIR"\n---\n\nalpha z\n',
      'rules/a-first.mdc': '---\ntrigger: "ALPHA_FIRST"\n---\n\nalpha a\n',
      'rules/nested/b.mdc': '---\ntrigger: "NESTED_B"\n---\n\nnested b\n',
      'rules/nested/a.mdc': '---\ntrigger: "NESTED_A"\n---\n\nnested a\n',
      'rules/no-trigger.mdc': '---\ndescription: plain\nalwaysApply: true\n---\n\nno trigger here\n',
    }, { rules: ['z-last.mdc', 'a-first.mdc', 'nested'] })
    // Discovered SECOND: a cc-flavor plugin whose rules must be skipped...
    const ccRoot = join(pool, 'cc-flavored')
    mkdirSync(join(ccRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(join(ccRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cc-flavored', rules: 'rules' }), 'utf8')
    mkdirSync(join(ccRoot, 'rules'), { recursive: true })
    // ...and a second cursor plugin discovered after alpha.
    pluginRoot(pool, 'beta', {
      'rules/b.mdc': '---\ntrigger: "BETA_PATTERN"\n---\n\nbeta\n',
    })
    // Lexicographic pool order: alpha, beta, cc-flavored.
    const rules = await discoverTurnRules({ pluginDirs: [pool] })
    // Discovered FIRST (dir order), declared in z-then-a order (declaration
    // order preserved), lexicographic WITHIN each declared dir.
    expect(rules.map(r => r.ruleKey)).toEqual([
      'alpha/rules/z-last.mdc',
      'alpha/rules/a-first.mdc',
      'alpha/rules/nested/a.mdc',
      'alpha/rules/nested/b.mdc',
      'beta/rules/b.mdc',
    ])
    // Defaults (§4.1): triggerOn both, repeat once, gap 10; description carried.
    const alphaFirst = rules[1]!
    expect(alphaFirst).toMatchObject({
      trigger: 'ALPHA_FIRST',
      triggerOn: ['tool-results', 'user-prompts'],
      repeat: 'once',
      repeatGap: 10,
      body: 'alpha a\n',
    })
  })
})
