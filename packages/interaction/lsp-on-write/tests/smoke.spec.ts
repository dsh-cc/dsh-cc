import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { apply } from '../src/index.ts'

/**
 * Smoke spec (design doc §5): a scripted edit driven through the registered
 * `tools/post-execute` listener end-to-end with a fake `mcpConnections`
 * registry returning canned diagnostics → the tool result text ends with the
 * `[lsp]` block; with the registry absent the result content is
 * byte-identical to the baseline.
 *
 * Deviation from the doc's "in-process preset session" wording: full preset
 * mounting requires the whole harness runtime (session, agent loop, llm) and
 * there is no in-process preset-session spec to build on; the nearest
 * faithful seam is the registered listener itself, driven exactly as the
 * waterfall drives it (downstream accept decision in, composed decision out).
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'low-smoke-'))
  dirs.push(home)
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-lsp-on-write': { enabled: true } }))
  return home
}

function mount(registry: unknown) {
  const ctx = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    get: (key: string) => (key === 'mcpConnections' ? registry : undefined),
    dshHomePath: () => tempHome(),
  }
  apply(ctx as never)
  return (ctx.on.mock.calls.find(([event]) => event === 'tools/post-execute') as unknown as [
    string,
    (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>,
  ])[1]
}

function editExec(): ToolExecution {
  return {
    name: 'edit',
    arguments: { file_path: '/proj/src/foo.ts' },
    signal: new AbortController().signal,
    rootCallId: 'c1',
    id: 'c1',
    agent: { session: { id: 's1', snapshotEvents: () => [], header: { cwd: '/proj' } } },
  } as unknown as ToolExecution
}

function result(): ToolExecutionResult {
  return { content: [{ type: 'text', text: 'edit ok' }] } as unknown as ToolExecutionResult
}

const canned = {
  'src/foo.ts': { Error: { '<file>': [{ message: 'bad type', range: { start: { line: 11, character: 6 } }, code: 2345 }] } },
}

const nextAccept = () => async () => ({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] }) as unknown as PostToolDecision

it('scripted edit with a fake registry: result text ends with the [lsp] block', async () => {
  const listener = mount({
    entries: () => [{ name: 'serena' } as never],
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(canned) }] }),
  })
  const decision = await listener(editExec(), result(), nextAccept()) as { content: ContentBlock[] }
  const last = decision.content[decision.content.length - 1]!
  expect(last.type).toBe('text')
  expect(last.text!.endsWith('[lsp] src/foo.ts: 1 problems\n  E2345 12:7 bad type')).toBe(true)
})

it('registry absent: byte-identical baseline', async () => {
  const listener = mount(undefined)
  const baseline = await nextAccept()()
  const decision = await listener(editExec(), result(), nextAccept())
  expect(decision).toEqual(baseline)
})
