import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, DEFAULT_RULES_SETTINGS, readUserRules, rulesOf } from '../src/settings.ts'

describe('SettingsSchema', () => {
  it('materializes defaults for a full object', () => {
    const resolved = SettingsSchema({} as unknown as Record<string, never>) as Record<string, unknown>
    expect(resolved.enabled).toBe(false)
    expect(resolved['debounce-ms']).toBe(5000)
    expect(resolved['max-output-bytes']).toBe(4096)
    expect(resolved['verbose-on-success']).toBe(false)
    expect(resolved.rules).toEqual([])
  })

  it('rejects a wrong-typed field', () => {
    expect(() => SettingsSchema({
      rules: [{ glob: 1, command: 'tsc' }],
    } as unknown as Record<string, never>)).toThrow()
  })

  it('rejects a rule missing its command (schemastery drops keys silently — explicit key check)', () => {
    expect(() => rulesOf([{ glob: 'a/**/*.ts' }])).toThrow()
    expect(() => rulesOf([{ glob: 'a/**/*.ts', command: 'tsc', 'timeout-ms': 'slow' }])).toThrow()
  })

  it('accepts a well-formed rule and keeps kebab keys', () => {
    const resolved = SettingsSchema({
      enabled: true,
      rules: [{ glob: 'packages/**/*.ts', command: 'tsc -b', 'timeout-ms': 60000 }],
    } as unknown as Record<string, never>) as Record<string, unknown>
    expect(resolved.enabled).toBe(true)
    expect(resolved.rules).toEqual([{ glob: 'packages/**/*.ts', command: 'tsc -b', 'timeout-ms': 60000 }])
  })

  it('preserves absence like the cascade does (z.const(undefined) union)', () => {
    expect(SettingsSchema(undefined as unknown as Record<string, never>)).toBeUndefined()
  })
})

describe('readUserRules (raw user-layer read)', () => {
  async function emptyHome(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'pev-home-'))
  }

  it('returns defaults when the user settings file is absent', async () => {
    const home = await emptyHome()
    expect(await readUserRules(home)).toEqual(DEFAULT_RULES_SETTINGS)
  })

  it('returns defaults on a parse-error file (fail-soft)', async () => {
    const home = await emptyHome()
    await writeFile(join(home, 'settings.json'), '{ not json')
    expect(await readUserRules(home)).toEqual(DEFAULT_RULES_SETTINGS)
  })

  it('reads rules from the user layer only, mapping timeout-ms → timeoutMs', async () => {
    const home = await emptyHome()
    await writeFile(join(home, 'settings.json'), JSON.stringify({
      'cc-post-edit-verify': {
        enabled: true,
        rules: [{ glob: 'packages/**/*.ts', command: 'tsc -b', 'timeout-ms': 60000 }],
      },
    }))
    const settings = await readUserRules(home)
    expect(settings.enabled).toBe(true)
    expect(settings.rules).toEqual([{ glob: 'packages/**/*.ts', command: 'tsc -b', timeoutMs: 60000 }])
  })

  it('project-scope rules are structurally invisible: only <dshHome>/settings.json is read', async () => {
    const home = await emptyHome()
    await writeFile(join(home, 'settings.json'), JSON.stringify({
      'cc-post-edit-verify': { enabled: true, rules: [] },
    }))
    // A "project" tree placed inside the home dir sibling space carries rules.
    const project = join(home, 'project')
    await mkdir(project)
    await writeFile(join(project, 'settings.json'), JSON.stringify({
      'cc-post-edit-verify': { enabled: true, rules: [{ glob: '**/*.ts', command: 'evil' }] },
    }))
    const settings = await readUserRules(home)
    expect(settings.rules).toEqual([])
  })

  it('falls back to defaults when the section is malformed', async () => {
    const home = await emptyHome()
    await writeFile(join(home, 'settings.json'), JSON.stringify({
      'cc-post-edit-verify': { enabled: true, rules: 'nope' },
    }))
    const settings = await readUserRules(home)
    expect(settings).toEqual(DEFAULT_RULES_SETTINGS)
  })
})
