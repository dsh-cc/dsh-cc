/**
 * Unit tests for the test-mode (VITEST) hard-fail arm of the parameters
 * tripwire in `ToolsService.register()` (design §F.2.3, the CI schema gate).
 *
 * FORK DRIFT: the tripwire itself is a fork-only delta re-applied onto the
 * re-vendored registry; upstream validates only the `output` schema.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@dsh-cc/tools'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function def(parameters: unknown, name = 'fake_tool'): ToolDefinition {
  return {
    name,
    description: 'test tool',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: () => [{ type: 'text', text: '' }],
    },
    execute: () => Promise.resolve([]),
  } as unknown as ToolDefinition
}

describe('the register() parameters tripwire under VITEST', () => {
  it('throws in test mode when parameters is a flat repo-DSL spec', async () => {
    const ctx = await setup()
    expect(() => ctx.tools.register(def({ foo: { type: 'string', required: true } })))
      .toThrow(/not a supported JSON Schema/)
  })

  it('registers fine with a valid compiled JSON Schema in test mode', async () => {
    const ctx = await setup()
    expect(() => ctx.tools.register(def({ type: 'object', additionalProperties: true }))).not.toThrow()
  })

  it('skips undefined/null parameters without throwing in test mode', async () => {
    const ctx = await setup()
    expect(() => ctx.tools.register(def(undefined, 'undef'))).not.toThrow()
    expect(() => ctx.tools.register(def(null, 'null-params'))).not.toThrow()
  })
})
