import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

/** deepseek-style reasoning stream: reasoning block → usage → text block → finish. */
const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: '思考' }, // 6 bytes
  { type: 'reasoning-delta', index: 0, text: '中' }, // 3 bytes
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考中' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '答' }, // 3 bytes
  { type: 'text-delta', index: 1, text: '案' }, // 3 bytes
  { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 8 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

class ReplayAdapter extends LlmAdapter {
  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.script) {
      if (options.signal?.aborted) break
      yield chunk
    }
  }
}

/** Recursive loop freeze (the "Object.deepFreeze" no-write check). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function baseOptions(): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    sessionId: 'sess-42' as never,
  }
}

interface Boot {
  ctx: Context
  home: string
  /** Consume one stream, collecting the chunks the consumer actually sees. */
  run(options?: Partial<GenerateOptions>): Promise<StreamChunk[]>
}

async function boot(opts: { script?: StreamChunk[]; probe?: boolean; settings?: boolean } = {}): Promise<Boot> {
  const home = await mkdtemp(join(tmpdir(), 'fold-home-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['deepseek'], new ReplayAdapter(opts.script ?? SCRIPT))
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => [home, ...segments].join('/')
  if (opts.settings !== false) {
    const probe = opts.probe ?? true
    ctx.provide('settings', { register: () => ({ get: () => ({ probe }) }) })
  }
  plugin.apply(ctx)
  return {
    ctx,
    home,
    run: async (over = {}) => {
      const chunks: StreamChunk[] = []
      for await (const c of ctx.llm.stream({ ...baseOptions(), ...over })) chunks.push(c)
      return chunks
    },
  }
}

const EXPECTED_CHUNKS: StreamChunk[] = SCRIPT

describe('@dsh-cc/reasoning-fold component', () => {
  it('writes one ledger row with correct byte counts + usage; chunks unchanged', async () => {
    const { home, run } = await boot()
    const seen = await run()
    expect(seen).toEqual(EXPECTED_CHUNKS)
    const file = join(home, 'reasoning-fold', 'sess-42.jsonl')
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: 'sess-42',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      purpose: null,
      reasoningBytes: 9,
      textBytes: 6,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 8 },
    })
  })

  it('LEDGER-ONLY tripwire: identical chunk sequence with and without the plugin', async () => {
    const { run } = await boot()
    const seenWith = await run()
    // Fresh context WITHOUT the plugin mounted (and no settings provider).
    const bareCtx = new Context()
    await bareCtx.plugin(LlmRuntime)
    bareCtx.llm.registerAdapter(['deepseek'], new ReplayAdapter(SCRIPT))
    const seenWithout: StreamChunk[] = []
    for await (const c of bareCtx.llm.stream(baseOptions())) seenWithout.push(c)
    expect(seenWith).toEqual(seenWithout)
    expect(seenWithout).toEqual(EXPECTED_CHUNKS)
  })

  it('no-write on options: frozen options stream cleanly and stay unchanged', async () => {
    const { home, run } = await boot()
    const options = deepFreeze({ ...baseOptions(), purpose: 'session-title' as const })
    const snapshot = JSON.parse(JSON.stringify(options)) as GenerateOptions
    await expect(run(options)).resolves.toEqual(EXPECTED_CHUNKS)
    expect(options).toEqual(snapshot)
    // purpose stamped on the row, keyed by the session-title session id.
    const rows = (await readFile(join(home, 'reasoning-fold', 'sess-42.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(rows[rows.length - 1]!)).toMatchObject({ purpose: 'session-title' })
  })

  it('probe=false registers nothing: no ledger file, chunks still pass', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fold-off-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek'], new ReplayAdapter(SCRIPT))
    ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
      (...segments: string[]) => [home, ...segments].join('/')
    ctx.provide('settings', {
      register: (ns: string) => {
        expect(ns).toBe('cc-reasoning-fold')
        return { get: () => ({ probe: false }) }
      },
    })
    expect(plugin.apply(ctx)).toBeUndefined()
    const seen: StreamChunk[] = []
    for await (const c of ctx.llm.stream(baseOptions())) seen.push(c)
    expect(seen).toEqual(EXPECTED_CHUNKS)
    await expect(readdir(home)).resolves.toEqual([])
  })

  it('mid-stream throw from the adapter still appends the partial row', async () => {
    const throwing: StreamChunk[] = [
      { type: 'reasoning-delta', index: 0, text: '中断' },
    ]
    const { home, run } = await boot({ script: throwing })
    // The runtime normalizes adapter throws to a terminal finish chunk; the
    // listener's finally must still have appended the partial record.
    await run()
    const rows = (await readFile(join(home, 'reasoning-fold', 'sess-42.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(rows[0]!)).toMatchObject({ reasoningBytes: 6, textBytes: 0 })
  })
})
