import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import Lsp, {
  LspProviderId,
  type LspProvider,
  type LspProviderQuery,
  type LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import * as ToolLsp from '@deepseek-ai/dsh-tool-lsp'

/**
 * cc-shell bundle smoke for the LSP rows: the `@deepseek-ai/dsh-lsp` capability
 * seam (`ctx.lsp`) is the provider registry, and `@deepseek-ai/dsh-tool-lsp`
 * registers the model-facing `lsp` tool (goToDefinition/findReferences/
 * goToImplementation/hover) over it. The seam must mount before the tool that
 * injects it; the stdio provider (`dsh-lsp-stdio`) is one backing provider a
 * deployment may register — this spec fakes a provider via registerProvider()
 * to exercise the routing, and asserts the graceful LSP_WORKSPACE_REQUIRED when
 * no session workspace cwd is present.
 */

/** A scripted provider recording queries; `respond` yields the result or throws. */
function stubProvider(
  respond: (request: LspProviderQuery) => LspQueryResult,
  extensionToLanguage: Record<string, string> = { '.ts': 'typescript' },
): LspProvider & { seen: LspProviderQuery[] } {
  const seen: LspProviderQuery[] = []
  return {
    id: LspProviderId('stub'),
    extensionToLanguage,
    seen,
    query(request) {
      seen.push(request)
      return Promise.resolve(respond(request))
    },
  }
}

/**
 * Mount the vendored ToolRuntime swap (requires systemPrompt) + the LSP seam +
 * the model-facing lsp tool. Order mirrors upstream: SystemPrompt → ToolRuntime →
 * Lsp → ToolLsp, with the seam registered before the tool that injects it.
 */
async function mountLsp(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Lsp)
  await ctx.plugin(ToolLsp)
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

let seq = 0
const workspaceRoot = resolve('/virtual/workspace')
const okLocations: LspQueryResult = {
  kind: 'locations',
  locations: [{ uri: pathToFileURL(join(workspaceRoot, 'a.ts')).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
  resolvedWorkspaceUri: pathToFileURL(workspaceRoot).href,
}
/** `cwd: null` means "no agent" (tests LSP_WORKSPACE_REQUIRED); a string is the session cwd. */
function callLsp(ctx: Context, args: unknown, cwd: string | null = workspaceRoot) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `cc-lsp-${++seq}` as never,
    name: 'lsp',
    arguments: args,
    ...cwd !== null ? { agent: { session: { header: { cwd } } } as never } : {},
  })
}

describe('cc-shell bundle — LSP rows (dsh-lsp + dsh-lsp-stdio + dsh-tool-lsp)', () => {
  it('registers the lsp tool over the vendored ToolRuntime with the four operations', async () => {
    const { ctx, dispose } = await mountLsp()
    expect(ctx.lsp).toBeDefined()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('lsp')
    const schema = ctx.tools.get('lsp')?.parameters as { properties: { operation: { enum: string[] } } }
    expect(schema.properties.operation.enum).toEqual(['goToDefinition', 'findReferences', 'goToImplementation', 'hover'])
    expect(schema).toMatchObject({
      type: 'object',
      required: ['operation', 'file_path', 'line', 'character'],
    })
    await dispose()
  })

  it('routes goToDefinition to a registered ctx.lsp provider and projects the result shape', async () => {
    const { ctx, dispose } = await mountLsp()
    const provider = stubProvider(() => okLocations)
    ;(ctx.lsp as Lsp).registerProvider(provider)

    const result = await callLsp(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 3, character: 5 }, workspaceRoot)
    expect(result.isError).toBe(false)
    // The fake provider received the normalized query with the session cwd as
    // workspace root and the zero-based cursor.
    expect(provider.seen[0]).toMatchObject({
      operation: 'goToDefinition',
      filePath: 'a.ts',
      position: { line: 2, character: 4 },
      languageId: 'typescript',
      workspaceRoot,
    })
    // The canonical value carries the closed locations shape.
    expect(result.value).toMatchObject({
      kind: 'locations',
      locations: [{ uri: pathToFileURL(join(workspaceRoot, 'a.ts')).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
      resolvedWorkspaceUri: pathToFileURL(workspaceRoot).href,
    })
    expect(result.content[0]).toEqual({ type: 'text', text: 'a.ts:1:1' })
    await dispose()
  })

  it('surfaces LSP_WORKSPACE_REQUIRED gracefully without a session workspace cwd', async () => {
    const { ctx, dispose } = await mountLsp()
    ;(ctx.lsp as Lsp).registerProvider(stubProvider(() => okLocations))

    const result = await callLsp(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 1 }, null)
    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'LspError', code: 'LSP_WORKSPACE_REQUIRED' } },
    })
    // The host context stays alive for further use after the error.
    expect(ctx.tools.get('lsp')).toBeDefined()
    await dispose()
  })

  it('unregisters the lsp tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Lsp)
    const fiber = await ctx.plugin(ToolLsp)
    expect(ctx.tools.get('lsp')).toBeDefined()

    await fiber.dispose()
    expect(ctx.tools.get('lsp')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
