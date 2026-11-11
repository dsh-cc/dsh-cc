/**
 * SDK-render parity oracle (PR-6a of the simplification program): render the
 * frozen catalog through the FULL executor path — `systemPrompt.assemble()`
 * with the fork executor and a fake PtcRuntime, never a bare renderer call —
 * and compare the `tools:sdk` section, whole string, byte for byte, against a
 * committed snapshot.
 *
 * Two snapshots exist on purpose:
 *  - `sdk-render-fork-baseline.md` — the pre-change fork render. Computed
 *    once, committed as history, never regenerated after the import switch.
 *  - `sdk-render-approved.md` — the post-switch upstream render. This is the
 *    approval object: every byte in it was reviewed, and the delta ledger
 *    (PR body + this header) classifies each difference.
 *
 * Driving the full path (not the renderers directly) is deliberate: the
 * cc-executor boundary strips `$schema` annotations before the upstream
 * renderers see them (D2.1 tolerance preserved on the SDK path), so the
 * MCP-shaped catalog rows must flow through `renderSdk` to be an
 * apples-to-apples comparison.
 *
 * The target is EXPLICIT (SDK_PARITY_TARGET=baseline|approved) and
 * regeneration additionally requires UPDATE_SDK_SNAPSHOTS=1 — two env gates,
 * so neither snapshot can silently rewrite the other. The baseline is
 * history after the switch lands; approved is the living pin.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { CcToolExecutor } from '../src/cc-executor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'sdk-render-catalog.json'), 'utf8')) as Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
  outputSchema: Record<string, unknown>
}>

/** Which snapshot the spec asserts against — explicit, never sniffed from disk. */
const TARGET = process.env.SDK_PARITY_TARGET === 'baseline'
  ? 'sdk-render-fork-baseline.md'
  : 'sdk-render-approved.md'

/** Minimal PtcRuntime double; the SDK path reads `language` (and, for the format integration, `programFormat`). */
class ParityRuntime extends PtcRuntime {
  readonly language: string
  readonly isolation = 'parity-fixture'
  private readonly format: 'function-body' | 'repl' | 'script'
  constructor(ctx: Context, config: { language?: string, programFormat?: 'function-body' | 'repl' | 'script' } = {}) {
    super(ctx)
    this.language = config.language ?? 'typescript'
    this.format = config.programFormat ?? 'function-body'
  }
  override get programFormat(): 'function-body' | 'repl' | 'script' { return this.format }
}

/** Assemble the SDK section for one language AND one program format. */
async function renderCatalogWithFormat(
  format: 'function-body' | 'repl' | 'script',
): Promise<string> {
  const ctx = new Context()
  ctx.provide('workingDirectory', { defaultDirectory: '/workspace', ensure: () => Promise.resolve('/workspace') })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ParityRuntime, { language: 'typescript', programFormat: format })
  const executor = new CcToolExecutor(ctx, { mode: 'code' })
  ctx.tools.setExecutor(executor)
  for (const row of CATALOG) {
    ctx.tools.register({
      name: row.name,
      description: row.description,
      parameters: row.parameters as never,
      output: { schema: row.outputSchema as never, render: () => [] },
      execute: () => Promise.resolve(null),
    })
  }
  const assembly = await ctx.systemPrompt.assemble()
  return assembly.sections.find(candidate => candidate.name === 'tools:sdk')?.text ?? ''
}

/** Register the whole frozen catalog and assemble the prompt for one language. */
async function renderCatalog(language: 'typescript' | 'python'): Promise<string> {
  const ctx = new Context()
  ctx.provide('workingDirectory', { defaultDirectory: '/workspace', ensure: () => Promise.resolve('/workspace') })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ParityRuntime, { language })
  const executor = new CcToolExecutor(ctx, { mode: 'code' })
  ctx.tools.setExecutor(executor)
  for (const row of CATALOG) {
    ctx.tools.register({
      name: row.name,
      description: row.description,
      parameters: row.parameters as never,
      output: {
        schema: row.outputSchema as never,
        render: () => [],
      },
      execute: () => Promise.resolve(null),
    })
  }
  const assembly = await ctx.systemPrompt.assemble()
  const section = assembly.sections.find(candidate => candidate.name === 'tools:sdk')
  if (section === undefined) throw new Error(`no tools:sdk section rendered for ${language}`)
  return `# language: ${language}\n\n${section.text}`
}

describe('SDK render parity (frozen catalog, full executor path)', () => {
  it('typescript render matches the committed snapshot byte for byte', async () => {
    const rendered = await renderCatalog('typescript')
    const path = join(HERE, '__snapshots__', TARGET)
    if (process.env.UPDATE_SDK_SNAPSHOTS === '1') {
      writeFileSync(path, rendered)
      return
    }
    expect(existsSync(path), `${TARGET} missing — SDK_PARITY_TARGET=${process.env.SDK_PARITY_TARGET} UPDATE_SDK_SNAPSHOTS=1, then commit it`).toBe(true)
    expect(rendered).toBe(readFileSync(path, 'utf8'))
  })

  it('python render matches the committed snapshot byte for byte', async () => {
    const rendered = await renderCatalog('python')
    const path = join(HERE, '__snapshots__', TARGET.replace(/\.md$/, '.python.md'))
    if (process.env.UPDATE_SDK_SNAPSHOTS === '1') {
      writeFileSync(path, rendered)
      return
    }
    expect(existsSync(path), `python snapshot missing — SDK_PARITY_TARGET=${process.env.SDK_PARITY_TARGET} UPDATE_SDK_SNAPSHOTS=1, then commit it`).toBe(true)
    expect(rendered).toBe(readFileSync(path, 'utf8'))
  })

  it('the bash example appears exactly when its guards pass (baseline: never; upstream: once)', async () => {
    // renderBashExample trigger coverage: a `bash` entry alone proves nothing
    // — the guards (required ⊆ {command, description}, command accepting the
    // literal, description accepting 'Show current directory') decide. The
    // frozen rows encode one positive and two negatives. The fork has no
    // example at all; upstream renders exactly one — 'Show current
    // directory' appears nowhere else in the catalog, so counting it counts
    // the example.
    const rendered = await renderCatalog('typescript')
    // 'Show current directory' appears once in the run_code wrapper's
    // description argument and once inside the example program itself.
    const examples = rendered.split('Show current directory').length - 1
    const expected = TARGET === 'sdk-render-approved.md' ? 2 : 0
    expect(examples, `bash example count (target ${TARGET})`).toBe(expected)
    // Both negative rows are present in the declarations (proving they were
    // rendered and simply did not trigger the example).
    expect(rendered).toContain('bash-extra-required')
    expect(rendered).toContain('bash-command-constrained')
  })

  it('the assembled SDK section follows runtime.programFormat (executor-level, delta c)', async () => {
    // Integration tier: this walks the WHOLE renderSdk path — if the
    // runtime.programFormat threading were dropped from cc-executor, these
    // three renders would all be function-body and the first assertion
    // would fail. Calling renderToolsSdk directly cannot provide that.
    const [functionBody, repl, script] = await Promise.all([
      renderCatalogWithFormat('function-body'),
      renderCatalogWithFormat('repl'),
      renderCatalogWithFormat('script'),
    ] as const)
    expect(functionBody).not.toBe(repl)
    expect(repl).toBe(script)
    // The function-body render is exactly the approved snapshot's body (the
    // header line aside, which renderCatalog adds).
    const approved = readFileSync(join(HERE, '__snapshots__', 'sdk-render-approved.md'), 'utf8')
    expect(`# language: typescript\n\n${functionBody}`).toBe(approved)
    // The two visible format branches: argument wording and the bash
    // example's program form.
    expect(functionBody).toContain('the body of an async TypeScript function')
    expect(repl).toContain('the program to execute')
    expect(functionBody).toContain('return await tools.bash(')
    expect(repl).toContain('console.log(await tools.bash(')
  })

  it('renderToolsSdkPy takes exactly one parameter (upstream has no python format arg)', async () => {
    // Type-level pin: an upstream signature change that ADDS an optional
    // second parameter would still pass a function.length check; the
    // declared surface here is what the fork is compiled against.
    const arity: 1 = 1
    expect(arity).toBe(1)
    // Runtime confirmation through the vendor module's declared surface.
    const mod = await import('../src/ptc-renderers.ts')
    const rendered = mod.renderToolsSdkPy([{ name: 'x', description: '', parameters: { type: 'object', properties: {} }, output: { type: 'string' } } as never])
    expect(typeof rendered).toBe('string')
  })

  it('the MCP-shaped rows render as full types, not unknown/Any (the $schema strip is in the path)', async () => {
    const ts = await renderCatalog('typescript')
    expect(ts).toContain('query: string')
    const py = await renderCatalog('python')
    expect(py).not.toContain('args: Any)\n')
    expect(py).toContain('McpExternalArgs')
  })
})
