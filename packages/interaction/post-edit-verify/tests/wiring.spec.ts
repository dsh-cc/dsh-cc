import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import type { ShellExecRequest, ShellExecSpec, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { apply } from '../src/index.ts'

/**
 * Listener-level tests at the `tools/post-execute` boundary with a fake ctx:
 * we capture the listener `apply` registers and drive it directly, so every
 * trigger permutation (doc §3.2) is observable end-to-end without a full
 * agent-loop rig.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'pev-home-'))
  dirs.push(home)
  return home
}

interface CtxLike {
  logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  get: (key: string) => unknown
  dshHomePath?: (...segments: string[]) => string
}

interface Rig {
  ctx: CtxLike
  listener: (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  runs: ShellExecRequest[]
  /** Install a fake shell service before apply. */
}

function rig(options: {
  home?: string
  dshHomeThrows?: boolean
  shellRun: (spec: ShellExecSpec) => Promise<ShellRunResult>
}): Rig & { requests: ShellExecRequest[] } {
  const requests: ShellExecRequest[] = []
  const shell = {
    resolve(request: ShellExecRequest): ShellExecSpec {
      requests.push(request)
      return request as unknown as ShellExecSpec
    },
    async run(spec: ShellExecSpec): Promise<ShellRunResult> {
      return options.shellRun(spec)
    },
  } as unknown as ShellExecutor
  const ctx: CtxLike = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    get: (key: string) => (key === 'shell' ? shell : undefined),
    ...(options.home !== undefined || options.dshHomeThrows
      ? {}
      : {}),
  }
  if (options.home !== undefined) ctx.dshHomePath = () => options.home!
  if (options.dshHomeThrows) {
    ;(ctx as unknown as { dshHomePath: () => string }).dshHomePath = () => {
      throw new Error('no home')
    }
  }
  apply(ctx as never)
  const call = ctx.on.mock.calls.find(([event]) => event === 'tools/post-execute') as unknown as [
    string,
    (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>,
  ]
  expect(call).toBeTruthy()
  return { ctx, listener: call[1], requests, shell }
}

function enableRule(home: string, rule: Record<string, unknown> = { glob: '**/*.ts', command: 'tsc -b' }): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    'cc-post-edit-verify': { enabled: true, rules: [rule], 'debounce-ms': 5000, 'max-output-bytes': 4096, 'verbose-on-success': false },
  }))
}

function editExec(): ToolExecution {
  return {
    name: 'edit',
    arguments: { file_path: '/proj/packages/a/b.ts' },
    signal: new AbortController().signal,
    rootCallId: 'c1',
    id: 'c1',
    // Session cwd drives rule matching and the child's workdir.
    agent: { session: { id: 's1', snapshotEvents: () => [], header: { cwd: '/proj' } } },
  } as unknown as ToolExecution
}

function result(): ToolExecutionResult {
  return { content: [{ type: 'text', text: 'edit ok' }] } as unknown as ToolExecutionResult
}

function runResult(over: Partial<ShellRunResult> = {}): ShellRunResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, ...over }
}

const nextAccept = () => async () => ({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] }) as unknown as PostToolDecision
const nextBare = () => async () => ({ kind: 'accept' }) as unknown as PostToolDecision
const nextValue = () => async () => ({ kind: 'accept', value: { x: 1 } }) as unknown as PostToolDecision
const nextBlock = () => async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }) as unknown as PostToolDecision

describe('listener trigger permutations', () => {
  it('non-edit tool is ignored (shell untouched)', async () => {
    let ran = false
    const { listener, requests } = rig({ home: tempHome(), shellRun: async () => { ran = true; return runResult() } })
    enableRule(tempHome()) // even with some rule somewhere, a grep tool never triggers
    const downstream = await listener({ ...editExec(), name: 'grep' } as unknown as ToolExecution, result(), nextAccept())
    expect(ran).toBe(false)
    expect(requests).toEqual([])
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
  })

  it('disabled → untouched, shell not called', async () => {
    let ran = false
    const home = tempHome()
    const { listener } = rig({ home, shellRun: async () => { ran = true; return runResult() } })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-post-edit-verify': { enabled: false } }))
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(ran).toBe(false)
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
  })

  it('no rule matching the path → untouched', async () => {
    let ran = false
    const home = tempHome()
    const { listener } = rig({ home, shellRun: async () => { ran = true; return runResult() } })
    enableRule(home, { glob: '**/*.md', command: 'lint' })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(ran).toBe(false)
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
  })

  it('no dshHome available → inert, shell not called', async () => {
    let ran = false
    const { listener } = rig({ dshHomeThrows: true, shellRun: async () => { ran = true; return runResult() } })
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(ran).toBe(false)
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
  })

  it('block downstream → untouched, shell not called', async () => {
    let ran = false
    const home = tempHome()
    const { listener } = rig({ home, shellRun: async () => { ran = true; return runResult() } })
    enableRule(home)
    const downstream = await listener(editExec(), result(), nextBlock())
    expect(ran).toBe(false)
    expect(downstream).toEqual({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] })
  })

  it('value-accept downstream → untouched, shell not called, debug logged', async () => {
    let ran = false
    const home = tempHome()
    const { listener, ctx } = rig({ home, shellRun: async () => { ran = true; return runResult() } })
    enableRule(home)
    const downstream = await listener(editExec(), result(), nextValue())
    expect(ran).toBe(false)
    expect(downstream).toEqual({ kind: 'accept', value: { x: 1 } })
    expect(ctx.logger.debug).toHaveBeenCalled()
  })

  it('content-accept → verify block appended to downstream content', async () => {
    const home = tempHome()
    const { listener, requests } = rig({ home, shellRun: async () => runResult({ exitCode: 1, stdout: { text: 'err tail\n', truncated: false } }) })
    enableRule(home)
    const decision = await listener(editExec(), result(), nextAccept())
    const content = (decision as { content: ContentBlock[] }).content
    expect(content).toHaveLength(2)
    expect(content[0]!.text).toBe('downstream')
    expect(content[1]!.text).toContain('[auto-verify] tsc -b — exit 1')
    expect(content[1]!.text).toContain('err tail')
    expect(requests).toHaveLength(1)
  })

  it('bare accept falls back to result.content', async () => {
    const home = tempHome()
    const { listener } = rig({ home, shellRun: async () => runResult() })
    enableRule(home)
    const decision = await listener(editExec(), result(), nextBare())
    const content = (decision as { content: ContentBlock[] }).content
    expect(content).toHaveLength(2)
    expect(content[0]!.text).toBe('edit ok')
    expect(content[1]!.text).toContain('[auto-verify] tsc -b — ok')
  })

  it('listener never throws across next(): a throwing shell run degrades to passthrough', async () => {
    const home = tempHome()
    const { listener } = rig({ home, shellRun: async () => { throw new Error('spawn failed') } })
    enableRule(home)
    const downstream = await listener(editExec(), result(), nextAccept())
    expect(downstream).toEqual({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] })
  })

  it('workdir comes from the agent session cwd', async () => {
    const home = tempHome()
    const { listener, requests } = rig({ home, shellRun: async () => runResult() })
    enableRule(home)
    const agent = { session: { id: 's1', snapshotEvents: () => [], header: { cwd: '/proj/session' } } }
    const exec = {
      ...editExec(),
      arguments: { file_path: '/proj/session/packages/a/b.ts' },
      agent,
    } as unknown as ToolExecution
    await listener(exec, result(), nextAccept())
    expect(requests).toHaveLength(1)
    expect(requests[0]!.workdir).toBe('/proj/session')
  })
})
