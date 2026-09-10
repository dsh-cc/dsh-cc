import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as yaml from 'js-yaml'
import * as plugin from '../src/index.ts'

/**
 * Loader-composition smoke test: the real agent.cordis.yml row, parsed under
 * the real loader schema, mounted by the real cordis-plugin-loader, with the
 * real file-backed settings provider and real LlmRuntime, arms the probe
 * listener and writes the ledger row.
 *
 * The probe's production failure mode is SILENT (every error is swallowed by
 * design — LEDGER-ONLY), so this is the regression tripwire for the
 * row-to-ledger chain.
 *
 * MINIMAL REAL-LOADER COMPOSITION — this test does NOT cover:
 * - scripts/sync-cc-preset.sh copying the preset into the host tree;
 * - @deepseek-ai/dsh-agent-presets PresetTree mount legality;
 * - host base.cordis.yml drift;
 * - package-name resolution: `loader.internal` is stubbed, so a typo'd row
 *   `name` fails only via the module-map miss (thrown below) / the yml-row
 *   pin, not via real specifier resolution.
 */

/** deepseek-style reasoning stream: reasoning block → text block → usage → finish. */
const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: '思考' }, // 6 bytes
  { type: 'reasoning-delta', index: 0, text: '中' }, // 3 bytes
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考中' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '答' }, // 3 bytes
  { type: 'text-delta', index: 1, text: '案' }, // 3 bytes
  { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
  {
    type: 'usage',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 8, cacheReadTokens: 5 },
  },
  { type: 'finish', reason: { kind: 'stop' } },
]

const EXPECTED_USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 8, cacheReadTokens: 5 }

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

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  const context = ctx
  ctx = undefined
  // Context has no dispose(); the fiber owns the Include write queues/timers.
  if (context !== undefined) await context.fiber.dispose().catch(() => {})
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    root = undefined
  }
})

/** Parse the REAL preset file and extract the reasoning-fold row. */
function extractRealRow(): { id: string; name: string } {
  const preset = join(import.meta.dirname, '../../../preset/cc/agent.cordis.yml')
  const text = readFileSync(preset, 'utf8')
  const entries = yaml.load(text, { schema: entryListSchema }) as unknown
  const found: Array<Record<string, unknown>> = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
    } else if (node !== null && typeof node === 'object') {
      if ((node as Record<string, unknown>).name === '@dsh-cc/reasoning-fold') found.push(node as Record<string, unknown>)
      for (const value of Object.values(node as Record<string, unknown>)) walk(value)
    }
  }
  walk(entries)
  expect(found, 'agent.cordis.yml must contain exactly one @dsh-cc/reasoning-fold row').toHaveLength(1)
  return found[0] as unknown as { id: string; name: string }
}

/** Build the loader-mounted composition in a tmp root and return it booted. */
async function bootComposition(): Promise<{ home: string; compositionPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'fold-loader-'))
  const home = join(root, 'dsh-home')

  // Pin the row as it exists in the real preset, parsed under the real schema.
  const row = extractRealRow()
  // The preset row carries exactly id + name — pin the full shape so preset
  // drift on this row trips the test.
  expect(row).toEqual({ id: 'reasoning-fold', name: '@dsh-cc/reasoning-fold' })

  // Host rows for the settings provider and the LLM runtime live in the
  // harness's base.cordis.yml, outside this repo's preset — these two ids are
  // chosen for the minimal composition, not mirrored from any host file.
  const compositionPath = join(root, 'composition.cordis.yml')
  await writeFile(compositionPath, [
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(join(root, 'settings.yaml'))}`,
    '    watch: false',
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    `- id: ${row.id}`,
    `  name: ${JSON.stringify(row.name)}`,
    // The preset row is verbatim { id, name } — it relies on the host group's
    // mount ordering; a flat parallel tree mounts entries CONCURRENTLY, so the
    // composition adds inject to guarantee the settings provider is up before
    // the probe's apply() reads it (an unmet inject is what hangs await()).
    '  inject: [settings]',
    '',
  ].join('\n'))
  await writeFile(join(root, 'settings.yaml'), 'cc-reasoning-fold:\n  probe: true\n')

  const context = new Context()
  ctx = context
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  // The module map keys are the row `name` strings; values are the real
  // plugin exports. Stubbing internal bypasses real specifier resolution.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@dsh-cc/reasoning-fold', plugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>

  // Seed dshHomePath BEFORE the composition mounts (Include reassigns
  // ctx.baseUrl to the composition file's dir during loader.create).
  ;(context as unknown as { dshHomePath: (...segments: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)

  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(compositionPath).href },
  })
  // Unmet inject hangs loader.await() forever — the only realistic hang.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('loader.await() timed out — likely an unmet inject (settings provider never came up)'), 5000))
  })
  timeout.catch(() => {}) // keep the loser from surfacing as unhandled
  await Promise.race([context.loader.await(), timeout])
  clearTimeout(timer)

  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])

  context.llm.registerAdapter(['deepseek'], new ReplayAdapter(SCRIPT))
  return { home, compositionPath }
}

describe('@dsh-cc/reasoning-fold loader composition', () => {
  it('arms the probe from the real yml row through a real Loader mount and writes the ledger row', async () => {
    const { home } = await bootComposition()

    const seen: StreamChunk[] = []
    for await (const chunk of ctx!.llm.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'loader-42' as never,
    })) seen.push(chunk)

    // Passthrough intact: the caller sees exactly the scripted chunks.
    expect(seen).toEqual(SCRIPT)

    const rows = (await readFile(join(home, 'reasoning-fold', 'loader-42.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    // The ledger stamps `ts` at append time (appendLedgerRow) — pinned as a
    // string, everything else pinned exactly.
    expect(typeof rows[0]!.ts).toBe('string')
    expect(rows[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      sessionId: 'loader-42',
      purpose: null,
      reasoningBytes: 9,
      textBytes: 6,
      usage: EXPECTED_USAGE,
    })
  })

  it('the plugin module is loadable as a cordis plugin (real Loader.unwrapExports)', async () => {
    const loader = new Loader(new Context())
    const unwrapped = loader.unwrapExports(plugin)
    expect(unwrapped).toHaveProperty('apply')
    expect(typeof (unwrapped as { apply: unknown }).apply).toBe('function')
    expect(unwrapped).toHaveProperty('name')
  })
})
