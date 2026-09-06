/**
 * Unit tests for gate-time definition re-fingerprinting (M10): bundled pins
 * re-fingerprint from the CURRENT bundled registry (never null), and
 * project/user pins re-read the EXACT recorded baseDir+filename, falling back
 * to an agentType lookup only when the recorded file is gone (replacement
 * detection).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { definitionFingerprint } from '../src/fingerprint.ts'
import { refingerprintDefinition } from '../src/plugin.ts'
import { loadAgentsDir } from '@dsh-cc/claude-code-agents'
import type { ResumePin } from '../src/pin.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function namedPin(overrides: Partial<ResumePin['definition']> = {}): ResumePin {
  return {
    version: 1,
    childId: 'child',
    parentSessionId: 'parent',
    label: 'l',
    mode: 'continuable-background',
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: {
      kind: 'named',
      agentType: 'researcher',
      source: 'project',
      fingerprint: 'sha256:pinned',
      personaHash: 'sha256:p',
      ...overrides,
    },
    modelSelector: { raw: 'inherit', via: 'inherit' },
    effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true },
    toolFilter: { allow: [], deny: [] },
    workspace: { cwd: '/w', gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
    resume: { state: 'ok' },
  } as ResumePin
}

describe('refingerprintDefinition — bundled registry (M10)', () => {
  it('re-fingerprints a bundled pin from the current bundled registry (not null)', async () => {
    const pin = namedPin({ agentType: 'explore', source: 'bundled', fingerprint: 'sha256:stale' })
    const current = await refingerprintDefinition(pin)
    expect(current).not.toBeNull()
    expect(current).not.toBe('missing')
    expect(current).not.toBe('sha256:stale')
  })

  it('an unknown bundled agentType is missing', async () => {
    const pin = namedPin({ agentType: 'no-such-bundled-agent', source: 'bundled', fingerprint: 'sha256:x' })
    await expect(refingerprintDefinition(pin)).resolves.toBe('missing')
  })
})

describe('refingerprintDefinition — exact recorded file (M10)', () => {
  it('re-reads the exact recorded baseDir+filename: a content edit changes the fingerprint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-refp-'))
    roots.push(dir)
    const file = join(dir, 'researcher.md')
    writeFileSync(file, '---\nname: researcher\ndescription: d\n---\nBODY ONE\n')
    const pin = namedPin({ baseDir: dir, filename: 'researcher.md' })
    const before = await refingerprintDefinition(pin)
    expect(before).not.toBeNull()
    writeFileSync(file, '---\nname: researcher\ndescription: d\n---\nBODY TWO\n')
    const after = await refingerprintDefinition(pin)
    expect(after).not.toBe(before)
  })

  it('a replacement file for the same agentType (recorded .md gone, a .json now defines it) is fingerprinted (changed class, not missing)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-refp-'))
    roots.push(dir)
    writeFileSync(join(dir, 'researcher.md'), '---\nname: researcher\ndescription: d\n---\nORIGINAL\n')
    const pin = namedPin({ baseDir: dir, filename: 'researcher.md' })
    // The recorded file is gone, but a different file now defines the agentType.
    rmSync(join(dir, 'researcher.md'))
    writeFileSync(join(dir, 'researcher.json'), JSON.stringify({ name: 'researcher', description: 'd', prompt: 'REPLACEMENT' }))
    const current = await refingerprintDefinition(pin)
    expect(current).not.toBe('missing')
    const [replacement] = await loadAgentsDir(dir, 'project')
    expect(current).toBe(definitionFingerprint(replacement))
  })

  it('no definition anywhere → missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-refp-'))
    roots.push(dir)
    const pin = namedPin({ baseDir: dir, filename: 'researcher.md' })
    await expect(refingerprintDefinition(pin)).resolves.toBe('missing')
  })

  it('a pin without a file location has no current information (null)', async () => {
    await expect(refingerprintDefinition(namedPin())).resolves.toBeNull()
  })
})
