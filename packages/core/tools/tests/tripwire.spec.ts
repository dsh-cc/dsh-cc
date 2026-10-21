/**
 * Unit tests for the test-mode (VITEST) hard-fail arm of the parameters
 * tripwire in `register()` (design §F.2.3, the CI schema gate).
 */
import { describe, expect, it, vi } from 'vitest'
import { register } from '../src/runtime-registry.ts'
import type { ToolDefinition, ToolRuntimeCore } from '../src/tool-types.ts'

/** Minimal runtime stub: `register` only needs ctx.logger and layers.effect. */
function stubRt() {
  return {
    ctx: { logger: { warn: vi.fn() } },
    layers: { effect: vi.fn(() => () => {}) },
  } as never as ToolRuntimeCore
}

function def(parameters: unknown): ToolDefinition {
  return {
    name: 'fake_tool',
    description: 'test tool',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: () => '',
    },
    execute: () => [],
  } as ToolDefinition
}

describe('the register() parameters tripwire under VITEST', () => {
  it('throws in test mode when parameters is a flat repo-DSL spec', () => {
    expect(() => register(stubRt(), def({ foo: { type: 'string', required: true } })))
      .toThrow(/not a supported JSON Schema/)
  })

  it('registers fine with a valid compiled JSON Schema in test mode', () => {
    expect(() => register(stubRt(), def({ type: 'object', additionalProperties: true }))).not.toThrow()
  })

  it('skips undefined/null parameters without throwing in test mode', () => {
    expect(() => register(stubRt(), def(undefined))).not.toThrow()
    expect(() => register(stubRt(), def(null))).not.toThrow()
  })
})
