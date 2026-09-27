/**
 * Side-query consumers (tool-use summaries, prompt suggestions, advisor, …)
 * configured with the System One `gauge` alias: the real routes service
 * refuses the route before any model request. runSideQuery keeps its
 * never-throws contract, so the refusal surfaces as `reason: 'error'`.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply as applyModelRoutes } from '@dsh-cc/model-aliases'
import { runSideQuery } from '../src/index.ts'

class RecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'summary' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const PARENT = { id: 's', session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'main' } }) } } as unknown as Agent

async function boot() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['deepseek'], adapter)
  applyModelRoutes(ctx, {
    modelAliases: {
      gauge: { provider: 'deepseek', model: 'llmbox_systemone/laya', protocol: 'systemone' },
      haiku: { provider: 'deepseek', model: 'flash' },
    },
  })
  return { ctx, adapter }
}

describe('runSideQuery with the System One gauge alias', () => {
  it('alias gauge is refused before any model request (fail-soft: reason error)', async () => {
    const { ctx, adapter } = await boot()
    const result = await runSideQuery(ctx, { agent: PARENT, alias: 'gauge', prompt: 'summarize' })
    expect(result).toEqual({ ok: false, reason: 'error' })
    expect(adapter.calls).toHaveLength(0)
  })

  it('alias haiku still answers through the same routes service', async () => {
    const { ctx, adapter } = await boot()
    const result = await runSideQuery(ctx, { agent: PARENT, alias: 'haiku', prompt: 'summarize' })
    expect(result).toMatchObject({ ok: true, text: 'summary' })
    expect(adapter.calls[0]).toMatchObject({ provider: 'deepseek', model: 'flash' })
  })
})
