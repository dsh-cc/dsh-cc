import { describe, expect, it } from 'vitest'
import { belowMinimumMessage, belowMinimumVersion, compareSemver, extractDshVersion, MIN_DSH_VERSION } from '../bootstrap.mjs'

describe('extractDshVersion', () => {
  it('extracts a plain release version from dsh --version output', () => {
    expect(extractDshVersion('0.1.2\n')).toBe('0.1.2')
    expect(extractDshVersion('dsh 1.2.3 (node v22)')).toBe('1.2.3')
  })

  it('extracts prerelease versions including rc, alpha, and build metadata', () => {
    expect(extractDshVersion('0.1.2-rc.1')).toBe('0.1.2-rc.1')
    expect(extractDshVersion('0.1.2-alpha.5')).toBe('0.1.2-alpha.5')
    expect(extractDshVersion('0.2.0-beta.1+build.7')).toBe('0.2.0-beta.1+build.7')
  })

  it('returns null for garbage output (fail-open path)', () => {
    expect(extractDshVersion('')).toBe(null)
    expect(extractDshVersion('command not found')).toBe(null)
    expect(extractDshVersion(undefined)).toBe(null)
  })
})

describe('compareSemver', () => {
  it('compares core numbers numerically', () => {
    expect(compareSemver('0.1.1', '0.1.2')).toBeLessThan(0)
    expect(compareSemver('0.2.0', '0.1.99')).toBeGreaterThan(0)
    expect(compareSemver('0.1.2', '0.1.2')).toBe(0)
  })

  it('absence of prerelease outranks any prerelease', () => {
    expect(compareSemver('0.1.2', '0.1.2-rc.1')).toBeGreaterThan(0)
    expect(compareSemver('0.1.2-rc.1', '0.1.2')).toBeLessThan(0)
  })

  it('orders prerelease tags: alpha < rc', () => {
    expect(compareSemver('0.1.2-alpha.5', '0.1.2-rc.1')).toBeLessThan(0)
    expect(compareSemver('0.1.2-rc.1', '0.1.2-rc.2')).toBeLessThan(0)
  })

  it('compares numeric prerelease identifiers numerically, not lexically', () => {
    expect(compareSemver('0.1.2-rc.9', '0.1.2-rc.10')).toBeLessThan(0)
    expect(compareSemver('0.1.2-rc.2', '0.1.2-rc.2')).toBe(0)
  })
})

describe('belowMinimumVersion gate table', () => {
  it('minimum is 0.1.5-rc.1', () => {
    expect(MIN_DSH_VERSION).toBe('0.1.5-rc.1')
  })

  const failing = ['0.1.1-rc.2', '0.1.2-rc.1', '0.1.2-rc.2', '0.1.2']
  const passing = ['0.1.5-rc.1', '0.1.5', '0.1.6-alpha.2', '0.2.0']

  it.each(failing)('fails below-minimum %s', (version) => {
    expect(belowMinimumVersion(version)).toBe(true)
  })

  it.each(passing)('passes at-or-above-minimum %s', (version) => {
    expect(belowMinimumVersion(version)).toBe(false)
  })
})

describe('belowMinimumMessage', () => {
  it('names the found version, the minimum, and the fix command', () => {
    const message = belowMinimumMessage('0.1.1-rc.2')
    expect(message).toContain('0.1.1-rc.2')
    expect(message).toContain('0.1.5-rc.1')
    expect(message).toContain('npm install -g @deepseek-ai/dsh@latest')
  })
})
