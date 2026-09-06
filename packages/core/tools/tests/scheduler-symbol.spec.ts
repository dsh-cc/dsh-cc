/**
 * Cross-package symbol identity: the staged scheduler stamped on the registry
 * must be reachable through the SAME symbol the in-box agent loop imports from
 * `@deepseek-ai/dsh-tools`. A `Symbol()` is identity-unique — if this package
 * ever mints its own scheduler symbol again, the loop reads `undefined` and
 * every turn's first tool call crashes (`undefined.prepare`), which the host
 * UI renders as an "interrupted" tool call. Only a cross-package assertion
 * catches this; intra-package tests stay green either way.
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER } from '@dsh-cc/tools'

// Load the upstream reference through Node's own module cache, not a
// vite-transformed static import: vite SSR instantiates node_modules deps in
// its own module runner, yielding a SECOND copy of the symbol and a bogus
// mismatch. In production the agent loop's static import and this
// createRequire share Node's ESM cache (require(esm), Node ≥22.12), so this
// mirrors the deployment's identity semantics.
const { TOOL_RUNTIME_SCHEDULER: UPSTREAM_TOOL_RUNTIME_SCHEDULER } =
  createRequire(import.meta.url)('@deepseek-ai/dsh-tools') as { TOOL_RUNTIME_SCHEDULER: symbol }

describe('scheduler symbol identity', () => {
  it('re-exports the upstream TOOL_RUNTIME_SCHEDULER symbol', () => {
    expect(TOOL_RUNTIME_SCHEDULER).toBe(UPSTREAM_TOOL_RUNTIME_SCHEDULER)
  })

  it('stamps the scheduler under the upstream key on a mounted registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    expect(ctx.tools[UPSTREAM_TOOL_RUNTIME_SCHEDULER]).toBeDefined()
  })
})
