/**
 * Settings tests (§13): ship defaults, the OFF gate, and the fail-soft raw
 * hot-read of `<dshHome>/settings.json`.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_VWA_ARGUMENT_SETTINGS,
  SETTINGS_NAMESPACE,
  readUserSettingsSync,
} from '../src/settings.ts'

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempHome(settings: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vwa-argument-'))
  dirs.push(dir)
  if (settings !== undefined) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8')
  }
  return dir
}

describe('DEFAULT_VWA_ARGUMENT_SETTINGS (§13 table)', () => {
  it('ships semantic OFF and draft mode', () => {
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['semantic-enabled']).toBe(false)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['semantic-mode']).toBe('draft')
  })

  it('carries the §13 budget defaults', () => {
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-calls-per-run']).toBe(40)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-input-tokens-per-run']).toBe(160_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-output-tokens-per-run']).toBe(24_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-output-tokens-per-call']).toBe(3000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-wall-ms']).toBe(180_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-call-timeout-ms']).toBe(45_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-concurrency']).toBe(2)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-artifact-chars']).toBe(120_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['review-max-context-chars-per-task']).toBe(48_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['project-max-entities']).toBe(10_000)
    expect(DEFAULT_VWA_ARGUMENT_SETTINGS['repair-max-rounds-per-artifact-turn']).toBe(1)
  })

  it('uses the vwa-argument namespace with flat kebab keys', () => {
    expect(SETTINGS_NAMESPACE).toBe('vwa-argument')
    expect(Object.keys(DEFAULT_VWA_ARGUMENT_SETTINGS).every((k) => k === k.toLowerCase() && k.includes('-'))).toBe(true)
  })
})

describe('readUserSettingsSync (raw hot read, fail-soft)', () => {
  it('returns defaults for an absent settings file', () => {
    expect(readUserSettingsSync(join(tmpdir(), 'vwa-argument-absent-home'))).toEqual(DEFAULT_VWA_ARGUMENT_SETTINGS)
  })

  it('returns defaults when the namespace is absent', async () => {
    const home = await tempHome({ other: {} })
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_VWA_ARGUMENT_SETTINGS)
  })

  it('reads overrides and keeps the gate OFF until explicitly enabled', async () => {
    const home = await tempHome({ [SETTINGS_NAMESPACE]: { 'semantic-enabled': true, 'review-concurrency': 3 } })
    const s = readUserSettingsSync(home)
    expect(s['semantic-enabled']).toBe(true)
    expect(s['review-concurrency']).toBe(3)
    expect(s['review-max-calls-per-run']).toBe(40)
  })

  it('falls back to defaults on a malformed section or file', async () => {
    const badValue = await tempHome({ [SETTINGS_NAMESPACE]: { 'review-concurrency': 99 } })
    expect(readUserSettingsSync(badValue)['review-concurrency']).toBe(2)
    const brokenDir = await mkdtemp(join(tmpdir(), 'vwa-argument-'))
    dirs.push(brokenDir)
    await writeFile(join(brokenDir, 'settings.json'), '{not json', 'utf8')
    expect(readUserSettingsSync(brokenDir)).toEqual(DEFAULT_VWA_ARGUMENT_SETTINGS)
  })
})
