import { describe, expect, it } from 'vitest'
import {
  DANGEROUS_ENV_VARS,
  applyEnv,
  applyTrustedEnv,
  coerceEnv,
} from '../src/cascade/env.ts'

describe('coerceEnv', () => {
  it('stringifies scalar values', () => {
    expect(coerceEnv(42)).toBe('42')
    expect(coerceEnv(true)).toBe('true')
    expect(coerceEnv('abc')).toBe('abc')
    expect(coerceEnv(null)).toBe('null')
  })

  it('stringifies objects and arrays as JSON', () => {
    expect(coerceEnv({ a: 1 })).toBe('{"a":1}')
    expect(coerceEnv(['x', 'y'])).toBe('["x","y"]')
  })
})

describe('applyEnv (untrusted stage)', () => {
  it('applies ordinary variables to a target', () => {
    const result = applyEnv({ FOO: '1', BAR: 'two' })
    expect(result).toEqual({ FOO: '1', BAR: 'two' })
  })

  it('excludes dangerous variables until trusted', () => {
    const result = applyEnv({ SAFE: '1', PATH: '/usr/bin', LD_PRELOAD: 'x.so' })
    expect(result).toEqual({ SAFE: '1' })
  })

  it('merges into a supplied target without mutating it', () => {
    const target = { EXISTING: 'keep' }
    const result = applyEnv({ FOO: '1' }, target)
    expect(result).toEqual({ EXISTING: 'keep', FOO: '1' })
    expect(target).toEqual({ EXISTING: 'keep' })
  })

  it('application is immutable to the caller-owned env object', () => {
    const env = { FOO: '1' }
    applyEnv(env)
    expect(env).toEqual({ FOO: '1' })
  })
})

describe('applyTrustedEnv (trusted stage)', () => {
  it('applies dangerous variables together with ordinary ones', () => {
    const result = applyTrustedEnv({ SAFE: '1', PATH: '/usr/bin', LD_PRELOAD: 'x.so' })
    expect(result).toEqual({ SAFE: '1', PATH: '/usr/bin', LD_PRELOAD: 'x.so' })
  })

  it('coerces every configured value to a string', () => {
    const result = applyTrustedEnv({ COUNT: 3, ENABLED: true })
    expect(result).toEqual({ COUNT: '3', ENABLED: 'true' })
  })
})

describe('DANGEROUS_ENV_VARS', () => {
  it('names the environment-altering variables that require trust', () => {
    expect(DANGEROUS_ENV_VARS).toContain('LD_PRELOAD')
    expect(DANGEROUS_ENV_VARS).toContain('LD_LIBRARY_PATH')
    expect(DANGEROUS_ENV_VARS).toContain('DYLD_INSERT_LIBRARIES')
    expect(DANGEROUS_ENV_VARS).toContain('PATH')
    expect(DANGEROUS_ENV_VARS).toContain('PYTHONPATH')
    expect(DANGEROUS_ENV_VARS).toContain('NODE_OPTIONS')
  })
})
