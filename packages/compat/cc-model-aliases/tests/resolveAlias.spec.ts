import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MODEL_ALIASES_NAMESPACE, resolveAlias } from '@dsh-cc/model-aliases'
import type { ModelRoutes } from '@dsh-cc/model-aliases'

/** Route the fakes resolve `haiku` to; every other alias inherits (undefined). */
const CHEAP = { provider: 'p', model: 'cheap' }

describe('resolveAlias', () => {
  it('prefers ctx.get("ccModelRoutes") when present', () => {
    const ctx = new Context()
    const resolve = vi.fn((model: string | undefined) =>
      model === 'haiku' ? CHEAP : undefined)
    ctx.provide('ccModelRoutes', { resolve } satisfies ModelRoutes)
    expect(resolveAlias(ctx, 'haiku')).toEqual(CHEAP)
    expect(resolveAlias(ctx, 'sonnet')).toBeUndefined()
    expect(resolve).toHaveBeenCalledWith('haiku')
  })

  it('falls back to settings.get(MODEL_ALIASES_NAMESPACE) when no ccModelRoutes', () => {
    const ctx = new Context()
    const register = vi.fn()
    ctx.provide('settings', {
      get: (ns: string) =>
        ns === MODEL_ALIASES_NAMESPACE ? { haiku: CHEAP } : undefined,
      register,
    })
    expect(resolveAlias(ctx, 'haiku')).toEqual(CHEAP)
    expect(resolveAlias(ctx, 'sonnet')).toBeUndefined()
  })

  it('returns undefined when neither service is present (unconfigured haiku inherits)', () => {
    const ctx = new Context()
    expect(resolveAlias(ctx, 'haiku')).toBeUndefined()
  })

  it('does not call settings.register', () => {
    const ctx = new Context()
    const register = vi.fn()
    ctx.provide('settings', {
      get: (ns: string) =>
        ns === MODEL_ALIASES_NAMESPACE ? { haiku: CHEAP } : undefined,
      register,
    })
    resolveAlias(ctx, 'haiku')
    expect(register).not.toHaveBeenCalled()
  })
})
