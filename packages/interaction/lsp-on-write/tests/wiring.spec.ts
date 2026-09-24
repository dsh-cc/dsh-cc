import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { McpConnectionsService } from '@dsh-cc/mcp-client'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { DEFAULT_TOOL_NAMES, matchTool } from '../src/match.ts'
import { parseDiagnostics, renderDiagnosticsBlock, BLOCK_CAP_BYTES } from '../src/diagnostics.ts'
import { composeLspBlock } from '../src/compose.ts'
import { apply } from '../src/index.ts'

/**
 * Unit specs for the lsp-on-write listener (design doc §5 unit list):
 * matcher table, args shape, severity mapping, cap/truncate math,
 * timeout→drop, error→drop, breaker auto-disable, recursion pin
 * (one MCP call per edit at the service boundary), schema-drift → drop,
 * multi-text-block parse, cwd-relative path, value/block/passthrough
 * untouched, warn-once server-missing.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'low-home-'))
  dirs.push(home)
  return home
}

interface Rig {
  listener: (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  calls: { name: string; rawName: string; args: Record<string, unknown>; options?: { timeoutMs?: number; signal?: AbortSignal } }[]
  respond?: (name: string, rawName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
}

function rig(options: {
  home?: string
  /** Fake registry; omit to simulate "no mcpConnections service". */
  respond?: (rawName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Name the fake registry reports as registered (default 'serena'). */
  registeredName?: string
}): Rig {
  const home = options.home ?? tempHome()
  if (options.home === undefined) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      'cc-lsp-on-write': { enabled: true },
    }))
  }
  const calls: Rig['calls'] = []
  const registry = options.respond === undefined ? undefined : {
    entries: () => [{ name: options.registeredName ?? 'serena' }],
    callTool: async (name: string, rawName: string, args: Record<string, unknown>, opts?: Record<string, unknown>) => {
      calls.push({ name, rawName, args, options: opts as Rig['calls'][number]['options'] })
      // Honor the threaded budget signal like the real transport would: abort → reject.
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal
      return await Promise.race([
        options.respond!(rawName, args),
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
        }),
      ])
    },
  }
  const logger = { debug: vi.fn(), warn: vi.fn() }
  const ctx = {
    logger,
    on: vi.fn(),
    get: (key: string) => (key === 'mcpConnections' ? registry : undefined),
    dshHomePath: () => home,
  }
  apply(ctx as never)
  const call = ctx.on.mock.calls.find(([event]) => event === 'tools/post-execute') as unknown as [
    string,
    (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>,
  ]
  expect(call).toBeTruthy()
  return { listener: call[1], calls, respond: options.respond, logger }
}

function editExec(name = 'edit', args: Record<string, unknown> = { file_path: '/proj/src/foo.ts' }): ToolExecution {
  return {
    name,
    arguments: args,
    signal: new AbortController().signal,
    rootCallId: 'c1',
    id: 'c1',
    agent: { session: { id: 's1', snapshotEvents: () => [], header: { cwd: '/proj' } } },
  } as unknown as ToolExecution
}

function result(): ToolExecutionResult {
  return { content: [{ type: 'text', text: 'edit ok' }] } as unknown as ToolExecutionResult
}

/** One Error + one Warning diagnostic, serena grouped-map shape. */
function cannedMap(): Record<string, unknown> {
  return {
    'src/foo.ts': {
      Error: { '<file>': [{ message: 'bad type', range: { start: { line: 11, character: 6 } }, code: 2345 }] },
      Warning: { '<file>': [{ message: 'unused ctx', range: { start: { line: 39, character: 10 } }, code: 6133 }] },
      Information: { '<file>': [{ message: 'info', range: { start: { line: 0, character: 0 } } }] },
      Hint: { '<file>': [{ message: 'hint', range: { start: { line: 1, character: 0 } } }] },
    },
  }
}

function textResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

const nextAccept = () => async () => ({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] }) as unknown as PostToolDecision
const nextBare = () => async () => ({ kind: 'accept' }) as unknown as PostToolDecision
const nextValue = () => async () => ({ kind: 'accept', value: { x: 1 } }) as unknown as PostToolDecision
const nextBlock = () => async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }) as unknown as PostToolDecision

describe('matcher', () => {
  it('matches the pinned runtime names and arg keys', () => {
    expect(matchTool({ name: 'edit', arguments: { file_path: 'a.ts' } }, undefined)).toBe('a.ts')
    expect(matchTool({ name: 'write', arguments: { file_path: 'a.ts' } }, undefined)).toBe('a.ts')
    expect(matchTool({ name: 'NotebookEdit', arguments: { notebook_path: 'a.ipynb' } }, undefined)).toBe('a.ipynb')
  })

  it('NotebookEdit capitalization is required (lowercase does not match)', () => {
    expect(matchTool({ name: 'notebookedit', arguments: { notebook_path: 'a.ipynb' } }, undefined)).toBeUndefined()
  })

  it('mcp__ names never match by construction (Set membership)', () => {
    expect(DEFAULT_TOOL_NAMES).not.toContain(expect.stringMatching(/^mcp__/))
    expect(matchTool({ name: 'mcp__serena__edit', arguments: { file_path: 'a.ts' } }, undefined)).toBeUndefined()
  })

  it('toolNames override replaces the built-in set wholesale', () => {
    expect(matchTool({ name: 'grep', arguments: {} }, ['grep'])).toBeUndefined() // no path key
    expect(matchTool({ name: 'NotebookEdit', arguments: { notebook_path: 'a' } }, ['edit'])).toBeUndefined()
  })
})

describe('pull + render', () => {
  it('args shape: relative_path cwd-relative, start_line 0, end_line -1, min_severity 2 (default warning)', async () => {
    const { listener, calls } = rig({ respond: async () => textResult(cannedMap()) })
    await listener(editExec(), result(), nextAccept())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.rawName).toBe('get_diagnostics_for_file')
    expect(calls[0]!.args).toEqual({ relative_path: 'src/foo.ts', start_line: 0, end_line: -1, min_severity: 2 })
    expect(calls[0]!.options!.timeoutMs).toBe(1500)
    expect(calls[0]!.options!.signal).toBeInstanceOf(AbortSignal)
  })

  it('min_severity 1 when settings.minSeverity is error', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-lsp-on-write': { enabled: true, 'min-severity': 'error' } }))
    const { listener, calls } = rig({ home, respond: async () => textResult({}) })
    await listener(editExec(), result(), nextAccept())
    expect(calls[0]!.args['min_severity']).toBe(1)
  })

  it('severity filter + ordering: errors before warnings, Information/Hint dropped at default', () => {
    const parsed = parseDiagnostics(textResult(cannedMap()))
    expect(parsed).toHaveLength(4) // parse keeps all severities; the render filters
    const block = renderDiagnosticsBlock({ relativePath: 'src/foo.ts', diagnostics: parsed }, {
      enabled: true, serverName: 'serena', timeoutMs: 1500, maxDiagnostics: 8, minSeverity: 'warning', toolNames: undefined,
    })
    expect(block).toBe('[lsp] src/foo.ts: 2 problems\n  E2345 12:7 bad type\n  W6133 40:11 unused ctx')
  })

  it('line:col rendered 1-based from 0-based ranges', () => {
    const parsed = parseDiagnostics(textResult(cannedMap()))
    const error = parsed.find((d) => d.severity === 'Error')!
    expect(error.range.start.line).toBe(11)
    const block = renderDiagnosticsBlock({ relativePath: 'src/foo.ts', diagnostics: [error] }, {
      enabled: true, serverName: 'serena', timeoutMs: 1500, maxDiagnostics: 8, minSeverity: 'error', toolNames: undefined,
    })
    expect(block).toContain('E2345 12:7')
  })

  it('maxDiagnostics caps rendered entries with a reconciled suffix', () => {
    const diagnostics = Array.from({ length: 12 }, (_, i) => ({
      message: `m${i}`, range: { start: { line: i, character: 0 } }, code: 1, severity: 'Warning',
    }))
    const block = renderDiagnosticsBlock({ relativePath: 'a.ts', diagnostics }, {
      enabled: true, serverName: 'serena', timeoutMs: 1500, maxDiagnostics: 8, minSeverity: 'warning', toolNames: undefined,
    })
    expect(block).toContain('[lsp] a.ts: 12 problems')
    expect(block).toMatch(/… \(4 more\)$/)
    expect(block?.split('\n')).toHaveLength(10) // header + 8 entries + suffix
  })

  it('4KB cap truncates with a reconciled … (N more) suffix', () => {
    const diagnostics = Array.from({ length: 200 }, (_, i) => ({
      message: 'x'.repeat(200), range: { start: { line: i, character: 0 } }, code: 1, severity: 'Warning',
    }))
    const block = renderDiagnosticsBlock({ relativePath: 'a.ts', diagnostics }, {
      enabled: true, serverName: 'serena', timeoutMs: 1500, maxDiagnostics: 200, minSeverity: 'warning', toolNames: undefined,
    })
    expect(block).toBeDefined()
    expect(Buffer.byteLength(block!, 'utf8')).toBeLessThanOrEqual(BLOCK_CAP_BYTES)
    expect(block).toMatch(/… \((\d+) more\)$/)
    const more = Number(block!.match(/… \((\d+) more\)$/)![1])
    const shown = block!.split('\n').length - 2 // header + suffix
    expect(shown + more).toBe(200)
  })

  it('multi-text-block concat parse', () => {
    const json = JSON.stringify(cannedMap())
    const half = json.length / 2
    const parsed = parseDiagnostics({
      content: [
        { type: 'text', text: json.slice(0, half) },
        { type: 'text', text: json.slice(half) },
      ],
    })
    expect(parsed).toHaveLength(4)
  })

  it('schema drift (missing content, no text, garbage JSON, non-object) throws; tolerant empties parse to []', () => {
    expect(() => parseDiagnostics({})).toThrow(/schema drift/)
    expect(() => parseDiagnostics({ content: [{ type: 'image', data: 'x' }] })).toThrow(/schema drift/)
    expect(() => parseDiagnostics({ content: [{ type: 'text', text: 'not json' }] })).toThrow(/schema drift/)
    expect(() => parseDiagnostics({ content: [{ type: 'text', text: '"just a string"' }] })).toThrow(/schema drift/)
    // NOT drift: a legitimate empty map (serena: no diagnostics) and a
    // map whose inner groups are shallow-mismatched parse to empty.
    expect(parseDiagnostics(textResult({}))).toEqual([])
    expect(parseDiagnostics({ content: [{ type: 'text', text: '{"a": 1}' }] })).toEqual([])
  })

  it('empty diagnostics → no block', () => {
    expect(renderDiagnosticsBlock({ relativePath: 'a.ts', diagnostics: [] }, {
      enabled: true, serverName: 'serena', timeoutMs: 1500, maxDiagnostics: 8, minSeverity: 'warning', toolNames: undefined,
    })).toBeUndefined()
  })
})

describe('listener behavior', () => {
  it('content-accept: [lsp] block appended to downstream content', async () => {
    const { listener } = rig({ respond: async () => textResult(cannedMap()) })
    const decision = await listener(editExec(), result(), nextAccept())
    const content = (decision as { content: ContentBlock[] }).content
    expect(content).toHaveLength(2)
    expect(content[0]!.text).toBe('downstream')
    expect(content[1]!.text).toContain('[lsp] src/foo.ts: 2 problems')
  })

  it('bare accept falls back to result.content', async () => {
    const { listener } = rig({ respond: async () => textResult(cannedMap()) })
    const decision = await listener(editExec(), result(), nextBare())
    const content = (decision as { content: ContentBlock[] }).content
    expect(content[0]!.text).toBe('edit ok')
    expect(content[1]!.text).toContain('[lsp]')
  })

  it('value-accept downstream → untouched', async () => {
    const { listener, calls } = rig({ respond: async () => textResult(cannedMap()) })
    const downstream = await listener(editExec(), result(), nextValue())
    expect(downstream).toEqual({ kind: 'accept', value: { x: 1 } })
    expect(calls).toHaveLength(0)
  })

  it('block downstream → untouched', async () => {
    const { listener, calls } = rig({ respond: async () => textResult(cannedMap()) })
    const downstream = await listener(editExec(), result(), nextBlock())
    expect(downstream).toEqual({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] })
    expect(calls).toHaveLength(0)
  })

  it('recursion pin: exactly one MCP call per edit at the service boundary', async () => {
    const { listener, calls } = rig({ respond: async () => textResult(cannedMap()) })
    await listener(editExec(), result(), nextAccept())
    expect(calls).toHaveLength(1)
  })

  it('timeout → drop (debug counter), downstream untouched', async () => {
    const { listener, calls, logger } = rig({ respond: async () => new Promise(() => { /* never settles: abort fires */ }) })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(calls).toHaveLength(1)
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('dropped'))
  })

  it('error → drop, never throws into the tool result', async () => {
    const { listener, logger } = rig({ respond: async () => { throw new Error('boom') } })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(logger.debug).toHaveBeenCalled()
  })

  it('breaker: 3 consecutive drops auto-disable the session with one debug line', async () => {
    const { listener, logger } = rig({ respond: async () => { throw new Error('boom') } })
    for (let i = 0; i < 3; i++) await listener(editExec(), result(), nextAccept())
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('disabled for the rest of the session'))
    const debugCallsAfter = logger.debug.mock.calls.length
    await listener(editExec(), result(), nextAccept())
    expect(logger.debug.mock.calls.length).toBe(debugCallsAfter) // short-circuited
  })

  it('registry absent → lazy warn-once "no server named" on first matched edit', async () => {
    const { listener, logger, calls } = rig({})
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(calls).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no server named "serena" registered'))
    await listener(editExec(), result(), nextAccept())
    expect(logger.warn).toHaveBeenCalledTimes(1) // warn-ONCE
  })

  it('registry live but server missing → warn-once, no drop charged to the breaker', async () => {
    const { listener, logger, calls } = rig({ registeredName: 'other', respond: async () => textResult(cannedMap()) })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(calls).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no server named "serena" registered'))
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('dropped')) // server-missing is NOT a drop
    await listener(editExec(), result(), nextAccept())
    expect(logger.warn).toHaveBeenCalledTimes(1) // warn-ONCE
  })

  it('schema drift → drop (debug counter), downstream untouched', async () => {
    const { listener, logger } = rig({ respond: async () => textResult('just a string') })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('dropped'))
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('schema drift'))
  })

  it('exec.agent undefined → drop silently, no MCP call', async () => {
    const { listener, calls } = rig({ respond: async () => textResult(cannedMap()) })
    const exec = editExec() as unknown as Record<string, unknown>
    delete exec.agent
    const downstream = await listener(exec as unknown as ToolExecution, result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(calls).toHaveLength(0)
  })

  it('disabled by default → untouched even with a live registry', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({})) // no cc-lsp-on-write section → enabled: false
    const { listener, calls } = rig({ home, respond: async () => textResult(cannedMap()) })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
    expect(calls).toHaveLength(0)
  })

  it('compose is exported and composes content-accept only (unit pin)', () => {
    const downstream = { kind: 'accept', content: [{ type: 'text', text: 'base' }] } as unknown as PostToolDecision
    const res = { content: [{ type: 'text', text: 'tool' }] } as unknown as ToolExecutionResult
    const out = composeLspBlock(downstream, res, { type: 'text', text: '[lsp] x' })
    expect(out).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'base' }, { type: 'text', text: '[lsp] x' }] })
    expect(composeLspBlock({ kind: 'accept', value: 1 } as unknown as PostToolDecision, res, { type: 'text', text: 'x' })).toEqual({ kind: 'accept', value: 1 })
  })
})
