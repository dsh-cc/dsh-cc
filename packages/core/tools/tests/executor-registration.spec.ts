/**
 * Executor composition contract (migration slice S3 / design D7).
 *
 * Harness 0.2.2-rc.1 split tool execution out of the registry: `ctx.tools`
 * registers and resolves definitions, an executor owns the model-facing
 * projection and the batch settlement. `ToolsService.setExecutor` admits
 * exactly ONE executor per scope — a second registration in the same scope
 * throws — and `selectExecutor` walks the scope chain then falls back to root,
 * throwing `ToolExecutorUnavailableError` when nothing is mounted.
 *
 * The CC bundles rely on both halves: `cc-shell/cordis.patch.yml` disables
 * dsh-base's `tool-executor-native` row and mounts `@dsh-cc/tools/executor`
 * (`tool-executor-cc`) at root, so exactly one executor must be live there and
 * any second mount — a stray base row, a double-loaded preset — must fail
 * loudly instead of silently swapping the model-visible catalog.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CcToolExecutor } from '../src/cc-executor.ts'
import * as CcExecutorPlugin from '../src/cc-executor.ts'

/** A registry host with the host SystemPrompt service the executor injects. */
async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('one executor per scope (upstream contract)', () => {
  it('mounts the CC executor plugin at root and registers exactly one executor', async () => {
    const ctx = await host()
    // `apply` is the row-mounted entry point: it registers in the mounting scope.
    await ctx.plugin(CcExecutorPlugin)
    // Root registration is observable through the definition projection: a
    // missing executor throws ToolExecutorUnavailableError instead of returning.
    expect(() => ctx.tools.selectExecutor()).not.toThrow()
    expect(ctx.tools.selectExecutor()).toBeInstanceOf(CcToolExecutor)
    await ctx.fiber.dispose()
  })

  it('throws when a second executor registers in the same scope', async () => {
    const ctx = await host()
    await ctx.plugin(CcExecutorPlugin)
    expect(() => ctx.tools.setExecutor(new CcToolExecutor(ctx)))
      .toThrow(/Only one tool executor may be registered in each scope/)
    await ctx.fiber.dispose()
  })

  it('throws when the root scope has no executor at all', async () => {
    const ctx = await host()
    expect(() => ctx.tools.selectExecutor())
      .toThrow(/tool executor/i)
    await ctx.fiber.dispose()
  })

  it('keeps the disabled native row from coexisting with the CC executor', async () => {
    // The composition contract the yml encodes: dsh-base's `tool-executor-native`
    // row is disabled before `tool-executor-cc` inserts. Simulating the mistake
    // (both registered at root) must fail at the SECOND registration — proving
    // the cc-shell patch is load-order-sensitive by necessity, not by taste.
    const ctx = await host()
    ctx.tools.setExecutor(new CcToolExecutor(ctx, { mode: 'native' }))
    expect(() => ctx.tools.setExecutor(new CcToolExecutor(ctx, { mode: 'native' })))
      .toThrow(/Only one tool executor/)
    await ctx.fiber.dispose()
  })
})
