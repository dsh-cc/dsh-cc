/**
 * Package-shape pin for the dsh-cc-math plugin distribution
 * (docs/plans/2026-11-21-mathematical-research-harness.md §3.1, §3.4):
 * the npm `files` whitelist ships the skill tree only — never `tests/`, never
 * `README.i18n.yaml` — the nested CC manifest stays in lockstep with the npm
 * manifest, and the marketplace stanza names the same package so
 * `/plugin install dsh-cc-math@dsh-cc` resolves.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_DIR = dirname(import.meta.dirname)
const REPO_ROOT = join(PKG_DIR, '..', '..', '..')
const SKILL = 'skills/math-research'
const REFERENCES = ['formalize.md', 'prove.md', 'discover.md', 'evidence.md', 'budget.md']

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

const frontmatter = (text: string): Record<string, string> => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  expect(match, 'SKILL.md starts with frontmatter').not.toBeNull()
  const fields: Record<string, string> = {}
  for (const line of match![1]!.split('\n')) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (pair) fields[pair[1]!] = pair[2]!.trim()
  }
  return fields
}

describe('packages/plugin/dsh-cc-math package shape', () => {
  const pkg = readJson<{
    name: string
    version: string
    description: string
    type: string
    files: string[]
  }>(join(PKG_DIR, 'package.json'))

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-dsh-cc-math')
    expect(pkg.type).toBe('module')
    expect(pkg.files).toEqual(['.claude-plugin/plugin.json', 'skills', 'README.md', 'README.zh.md'])
    // The dsh-cc-writing whitelist precedent: the tests tree and the i18n
    // pairing record are repository material, not published artifacts.
    expect(pkg.files).not.toContain('tests')
    expect(pkg.files).not.toContain('tests/')
    expect(pkg.files).not.toContain('README.i18n.yaml')
  })

  it('declares every shipped component in `files`, and each entry exists on disk', () => {
    for (const entry of pkg.files) {
      const path = join(PKG_DIR, entry)
      expect(existsSync(path), `files entry "${entry}" exists`).toBe(true)
      if (statSync(path).isDirectory()) {
        // npm pack drops empty directories, so a lost skill tree fails here.
        expect(readdirSync(path).length, `files dir "${entry}" non-empty`).toBeGreaterThan(0)
      }
    }
    // Present in the repository, absent from the published whitelist.
    expect(existsSync(join(PKG_DIR, 'tests', 'package-shape.spec.ts'))).toBe(true)
    expect(existsSync(join(PKG_DIR, 'README.i18n.yaml'))).toBe(true)
  })

  it('the nested plugin manifest is name/version/description lockstep with package.json', () => {
    const manifest = readJson<{ name: string; version: string; description: string }>(
      join(PKG_DIR, '.claude-plugin', 'plugin.json'),
    )
    expect(manifest.name).toBe('dsh-cc-math')
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.description).toBe(pkg.description)
  })

  it('the version matches the root release version (check-release-version gate)', () => {
    const root = readJson<{ version: string }>(join(REPO_ROOT, 'package.json'))
    expect(pkg.version).toBe(root.version)
  })

  it('the marketplace manifest lists the plugin with a matching stanza', () => {
    const marketplace = readJson<{
      plugins: Array<{ name: string; source: string; description: string }>
    }>(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'))
    const entry = marketplace.plugins.find((plugin) => plugin.name === 'dsh-cc-math')
    expect(entry?.source).toBe('./packages/plugin/dsh-cc-math')
    expect(entry?.description).toBe(pkg.description)
  })

  it('the skill declares complete frontmatter and ships its references', () => {
    const fields = frontmatter(readFileSync(join(PKG_DIR, SKILL, 'SKILL.md'), 'utf8'))
    expect(fields['name']).toBe('math-research')
    expect(fields['description']).toBeTruthy()
    // User-invocable public entry point: omitting the keys means true/false.
    expect(fields['user-invocable'] ?? 'true').toBe('true')
    expect(fields['disable-model-invocation'] ?? 'false').toBe('false')
    for (const name of REFERENCES) {
      expect(existsSync(join(PKG_DIR, SKILL, 'references', name)), name).toBe(true)
    }
    expect(existsSync(join(PKG_DIR, SKILL, 'scripts'))).toBe(true)
  })

  it('the skill gates milestones on script presence, not on a settings flag', () => {
    const body = readFileSync(join(PKG_DIR, SKILL, 'SKILL.md'), 'utf8')
    expect(body).toContain('${CLAUDE_SKILL_DIR}/scripts/')
    expect(body).toContain('Milestone gates (feature gate = file presence)')
    for (const heading of ['## M0 core', '## M1 formalization and fidelity gate', '## M2 proof search', '## M3 discovery']) {
      expect(body).toContain(heading)
    }
  })

  it('the bilingual README trio is present', () => {
    for (const name of ['README.md', 'README.zh.md', 'README.i18n.yaml']) {
      expect(existsSync(join(PKG_DIR, name)), name).toBe(true)
    }
  })
})
