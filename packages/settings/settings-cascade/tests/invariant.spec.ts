import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as CascadeInvariant from '../src/invariant.ts'

describe('settings-cascade invariant', () => {
  it('mounts the companion through the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CascadeInvariant)
    expect(true).toBe(true)
  })

  it('reserves the manifest name against a second registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CascadeInvariant)
    expect(() => ctx.invariants.register('@dsh-cc/settings-cascade', () => {}))
      .toThrow(/already registered/)
  })
})
