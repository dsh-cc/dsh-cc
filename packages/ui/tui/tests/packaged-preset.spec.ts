import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensurePackagedPreset, packagedPresetRoot } from '@dsh-cc/tui/packaged-preset.ts'

function sourceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-preset-src-'))
  writeFileSync(join(dir, 'agent.cordis.yml'), '- id: persona\n  name: test\n')
  writeFileSync(join(dir, 'preset.yml'), 'name: CC mode\norder: 5\n')
  return dir
}

describe('ensurePackagedPreset', () => {
  it('installs into an empty user root and is idempotent', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const sourceRoot = sourceDir()
    const first = ensurePackagedPreset({ dshHome, sourceRoot, revision: '1' })
    expect(first.status).toBe('installed')
    const dest = join(dshHome, '.agent-presets', 'cc', 'agent.cordis.yml')
    expect(readFileSync(dest, 'utf8')).toContain('persona')
    const second = ensurePackagedPreset({ dshHome, sourceRoot, revision: '1' })
    expect(second.status).toBe('current')
  })

  it('refuses to overwrite an unmarked user directory', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    mkdirSync(join(dshHome, '.agent-presets', 'cc'), { recursive: true })
    writeFileSync(join(dshHome, '.agent-presets', 'cc', 'preset.yml'), 'name: mine\n')
    const result = ensurePackagedPreset({ dshHome, sourceRoot: sourceDir(), revision: '1' })
    expect(result.status).toBe('conflict')
    expect(readFileSync(join(dshHome, '.agent-presets', 'cc', 'preset.yml'), 'utf8')).toBe('name: mine\n')
  })

  it('discovers the repo CC preset and can install it', () => {
    const source = packagedPresetRoot()
    expect(source).toBeDefined()
    expect(readFileSync(join(source!, 'preset.yml'), 'utf8')).toContain('CC mode')
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const result = ensurePackagedPreset({ dshHome, sourceRoot: source, revision: 'repo' })
    expect(result.status).toBe('installed')
    expect(readFileSync(join(dshHome, '.agent-presets', 'cc', 'agent.cordis.yml'), 'utf8')).toContain('cc-services')
  })

  it('reports missing-source when the package has no preset files', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const result = ensurePackagedPreset({
      dshHome,
      sourceRoot: join(dshHome, 'does-not-exist'),
      revision: '1',
    })
    expect(result.status).toBe('missing-source')
  })
})
