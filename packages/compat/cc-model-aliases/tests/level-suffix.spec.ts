/**
 * Tests for the `$level` model-reference suffix: `splitLevelSuffix` parsing,
 * resolver integration (suffix overrides alias-target effort, strip-before-
 * emit), and the shared `resolveSpawnEffort` precedence helper.
 */
import { describe, expect, it } from 'vitest'
import { createModelResolver, splitLevelSuffix } from '../src/resolver.ts'
import { resolveSpawnEffort } from '../src/agentOptions.ts'

describe('splitLevelSuffix', () => {
  it('splits a valid suffix', () => {
    expect(splitLevelSuffix('opus$high')).toEqual({ bare: 'opus', level: 'high' })
    expect(splitLevelSuffix('glm-5.3$xhigh')).toEqual({ bare: 'glm-5.3', level: 'xhigh' })
    expect(splitLevelSuffix('pkg/glm-5.3$low')).toEqual({ bare: 'pkg/glm-5.3', level: 'low' })
    expect(splitLevelSuffix('m$a1-B')).toEqual({ bare: 'm', level: 'a1-B' })
  })

  it('malformed: trailing $ → passthrough', () => {
    expect(splitLevelSuffix('glm$')).toEqual({ bare: 'glm$', level: undefined })
  })

  it('malformed: leading $ (empty bare model segment) → passthrough', () => {
    expect(splitLevelSuffix('$high')).toEqual({ bare: '$high', level: undefined })
    expect(splitLevelSuffix('pkg/$high')).toEqual({ bare: 'pkg/$high', level: undefined })
  })

  it('malformed: bad charset level → passthrough', () => {
    expect(splitLevelSuffix('m$hi!')).toEqual({ bare: 'm$hi!', level: undefined })
    expect(splitLevelSuffix('m$_high')).toEqual({ bare: 'm$_high', level: undefined })
    expect(splitLevelSuffix('m$-lead')).toEqual({ bare: 'm$-lead', level: undefined })
  })

  it('$ in a provider (non-trailing) segment is NOT treated', () => {
    expect(splitLevelSuffix('open$high/glm')).toEqual({ bare: 'open$high/glm', level: undefined })
  })

  it('ids without $ resolve byte-identically (regression)', () => {
    for (const ref of ['opus', 'glm-5.3', 'pkg/model-x', 'deepseek-chat']) {
      expect(splitLevelSuffix(ref)).toEqual({ bare: ref, level: undefined })
    }
  })
})

describe('resolver × $level suffix', () => {
  const aliases = new Map<string, { provider?: string; model: string; reasoningEffort?: string }>([
    ['opus', { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' }],
  ])

  it('alias name + suffix resolves the alias and stamps the level', () => {
    const resolve = createModelResolver(() => aliases, { warnOnInherit: false })
    expect(resolve('opus$high')).toEqual({ provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'high' })
  })

  it('explicit suffix OVERRIDES the alias-target effort', () => {
    const resolve = createModelResolver(() => aliases, { warnOnInherit: false })
    expect(resolve('opus$low')?.reasoningEffort).toBe('low')
  })

  it('alias-target effort survives when no suffix is present', () => {
    const resolve = createModelResolver(() => aliases, { warnOnInherit: false })
    expect(resolve('opus')).toEqual({ provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' })
  })

  it('literal model id + suffix strips the suffix onto reasoningEffort', () => {
    const resolve = createModelResolver(() => new Map(), { warnOnInherit: false })
    expect(resolve('glm-5.3$high')).toEqual({ model: 'glm-5.3', reasoningEffort: 'high' })
  })

  it('strip invariant: resolved model/provider never contain $', () => {
    const resolve = createModelResolver(() => aliases, { warnOnInherit: false })
    for (const ref of ['opus$high', 'glm-5.3$xhigh', 'pkg/glm$low', 'opus']) {
      const route = resolve(ref)
      expect(route?.model).not.toContain('$')
      expect(route?.provider ?? '').not.toContain('$')
    }
  })

  it('malformed suffix keeps the literal id (zero behavior change)', () => {
    const resolve = createModelResolver(() => new Map(), { warnOnInherit: false })
    expect(resolve('glm$')).toEqual({ model: 'glm$' })
    expect(resolve('$high')).toEqual({ model: '$high' })
  })
})

describe('resolveSpawnEffort (spawn precedence helper)', () => {
  it('route effort beats def.effort', () => {
    expect(resolveSpawnEffort({ model: 'm', reasoningEffort: 'high' }, 'low')).toBe('high')
  })

  it('def.effort used when the route carries none', () => {
    expect(resolveSpawnEffort({ model: 'm' }, 'low')).toBe('low')
    expect(resolveSpawnEffort(undefined, 3)).toBe('3')
  })

  it('undefined when neither carries an effort', () => {
    expect(resolveSpawnEffort(undefined, undefined)).toBeUndefined()
    expect(resolveSpawnEffort({ model: 'm' }, undefined)).toBeUndefined()
  })
})
