import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as CcOutputStylesInvariant from '@dsh-cc/output-styles/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('@dsh-cc/output-styles invariants', () => {
  it('reserves package ownership with Loader-safe exports and disposes it', async () => {
    expect(CcOutputStylesInvariant.name).toBe('cc-output-styles-invariant')
    expect(CcOutputStylesInvariant.inject).toEqual(['invariants'])
    expect('default' in CcOutputStylesInvariant).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(CcOutputStylesInvariant)).toBe(CcOutputStylesInvariant)

    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(CcOutputStylesInvariant)
    await fiber.await()

    // A second live registration of the same package fails loud.
    await expect(ctx.plugin(CcOutputStylesInvariant).await()).rejects.toThrow(/already registered/)

    // Disposal releases the package so it can be registered again (HMR-safety).
    await fiber.dispose()
    const fiber2 = ctx.plugin(CcOutputStylesInvariant)
    await fiber2.await()
    await fiber2.dispose()
    await ctx.fiber.dispose()
  })
})
