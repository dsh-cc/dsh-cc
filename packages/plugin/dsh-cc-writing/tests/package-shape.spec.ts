/**
 * Package-shape pin for the dsh-cc-writing distribution (plan §13):
 * pack and extract with `npm pack --ignore-scripts`, then prove that every
 * resource a skill reads at runtime (references, profiles, examples, scripts)
 * resolves inside the extracted package. Installation must not need a
 * repository checkout. The other tests pin what the loader and the scripts
 * trust: tracked files are never git-ignored, skill frontmatter is complete,
 * and every profile satisfies the §9 profile schema.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  validateProfile,
} from '../skills/writing-workflow/scripts/check-profile.lib.mjs'

const PKG_DIR = dirname(import.meta.dirname)
const REPO_ROOT = join(PKG_DIR, '..', '..', '..')
const WORKFLOW = 'skills/writing-workflow'
const PUBLIC_SKILLS = ['article-writing', 'article-review', 'language-editing']
const PROFILE_IDS = ['technical', 'research', 'opinion', 'technical-ste']

const scratch: string[] = []
const temporary = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

afterAll(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** The `files` whitelist ships the skill tree; extraction proves it. */
function extractPackage(): string {
  const destination = temporary('dsh-cc-writing-pack-')
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: temporary('dsh-cc-writing-npm-cache-') },
  })
  const tarball = join(destination, execFileSync('ls', [destination], { encoding: 'utf8' }).trim())
  const extracted = join(destination, 'package')
  execFileSync('tar', ['-xzf', tarball, '-C', destination], { encoding: 'utf8' })
  return extracted
}

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

describe('packages/plugin/dsh-cc-writing package shape', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string
    version: string
    type: string
    files: string[]
  }

  it('is the official plugin package with a publishable manifest', () => {
    expect(pkg.name).toBe('@dsh-cc/plugin-dsh-cc-writing')
    expect(pkg.type).toBe('module')
    expect(pkg.files).toEqual(
      expect.arrayContaining(['.claude-plugin/plugin.json', 'skills', 'README.md', 'README.zh.md']),
    )
  })

  describe('extracted npm package', () => {
    let extracted = ''

    beforeAll(() => {
      extracted = extractPackage()
    }, 120_000)

    it('ships the skill tree outside the checkout', () => {
      for (const skill of PUBLIC_SKILLS) {
        expect(existsSync(join(extracted, 'skills', skill, 'SKILL.md')), skill).toBe(true)
      }
      expect(existsSync(join(extracted, WORKFLOW, 'SKILL.md'))).toBe(true)
    })

    it('ships the references the public skills read', () => {
      for (const name of ['workflow.md', 'contracts.md', 'review-rubric.md', 'vwa-adapter.md']) {
        expect(existsSync(join(extracted, WORKFLOW, 'references', name)), name).toBe(true)
      }
    })

    it('ships the profiles and examples', () => {
      for (const id of PROFILE_IDS) {
        expect(existsSync(join(extracted, WORKFLOW, 'profiles', `${id}.json`)), id).toBe(true)
      }
      for (const name of ['zh.md', 'en.md']) {
        expect(existsSync(join(extracted, WORKFLOW, 'examples', name)), name).toBe(true)
      }
    })

    it('runs the script entry point from the extracted package', () => {
      // Node resolves the main module's realpath, so /var vs /private/var in a
      // macOS temp dir would leave `invokedDirectly` false and hide the CLI.
      const script = realpathSync(join(extracted, WORKFLOW, 'scripts', 'writing.mjs'))
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8' })
      // A missing command is invalid input, not a crash: one JSON envelope on
      // stdout, exit 2 (plan §6), and no stack trace.
      expect(run.status).toBe(2)
      const envelope = JSON.parse(run.stdout) as { ok: boolean; code: string }
      expect(envelope).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    })
  })

  it('no tracked file is git-ignored', () => {
    const tracked = execFileSync('git', ['ls-files', 'packages/plugin/dsh-cc-writing'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.length > 0)
    expect(tracked.length).toBeGreaterThan(0)
    // `git check-ignore` exits 1 when no path matches — zero hits, not a fault.
    const check = spawnSync('git', ['check-ignore', '--stdin'], {
      cwd: REPO_ROOT,
      input: tracked.join('\n'),
      encoding: 'utf8',
    })
    expect(check.status, check.stderr).toBe(1)
    expect(check.stdout.trim()).toBe('')
  })

  it('declares complete frontmatter on all four skills', () => {
    for (const skill of PUBLIC_SKILLS) {
      const fields = frontmatter(readFileSync(join(PKG_DIR, 'skills', skill, 'SKILL.md'), 'utf8'))
      expect(fields['name'], skill).toBe(skill)
      expect(fields['description'], skill).toBeTruthy()
      // Public entry points stay user-invocable; omitting the key means true.
      expect(fields['user-invocable'] ?? 'true', skill).toBe('true')
      expect(fields['disable-model-invocation'] ?? 'false', skill).toBe('false')
    }
    const workflow = frontmatter(readFileSync(join(PKG_DIR, WORKFLOW, 'SKILL.md'), 'utf8'))
    expect(workflow['name']).toBe('writing-workflow')
    expect(workflow['description']).toBeTruthy()
    expect(workflow['user-invocable']).toBe('false')
    expect(workflow['disable-model-invocation']).toBe('true')
  })

  it('every profile satisfies the §9 profile schema', () => {
    const ids: string[] = []
    for (const id of PROFILE_IDS) {
      const raw = JSON.parse(readFileSync(join(PKG_DIR, WORKFLOW, 'profiles', `${id}.json`), 'utf8'))
      const checked = (validateProfile as unknown as (value: unknown) => { ok: boolean; value: Record<string, any> })(raw)
      expect(checked.ok, `${id} profile schema`).toBe(true)
      const profile = checked.value
      expect(profile['id']).toBe(id)
      expect(profile['schemaVersion']).toBe(1)
      expect(profile['kind'], 'profiles are resources, not run artifacts').toBeUndefined()
      expect(profile['applicableLanguages'].length).toBeGreaterThan(0)
      expect(profile['rules'].length).toBeGreaterThan(0)
      expect(Array.isArray(profile['protectedTerms'])).toBe(true)
      for (const rule of profile['rules']) expect(['advisory', 'required']).toContain(rule.severity)
      ids.push(profile['id'])
    }
    expect(new Set(ids).size).toBe(PROFILE_IDS.length)
  })

  it('the marketplace manifest lists the plugin', () => {
    const marketplace = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ name: string; source: string }> }
    const entry = marketplace.plugins.find((plugin) => plugin.name === 'dsh-cc-writing')
    expect(entry?.source).toBe('./packages/plugin/dsh-cc-writing')
  })
})
