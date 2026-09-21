import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-bash-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ToolExecution } from '@dsh-cc/tools'
import { createRunner, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, clampTimeoutMs, keepOutput } from '../src/runner.ts'
import { DEFAULT_RULES_SETTINGS } from '../src/settings.ts'
import type { VerifyRule } from '../src/rules.ts'

/** Minimal ToolExecution stub: the runner only reads `signal` (and the wiring reads `name`). */
function exec(signal: AbortSignal): ToolExecution {
  return {
    signal,
    rootCallId: 'c1',
    id: 'c1',
    name: 'edit',
    arguments: { file_path: '/x/a.ts' },
  } as unknown as ToolExecution
}

/**
 * Duck-typed recorder for the ShellExecutor seam, mirroring the hook-protocol
 * runner spec's test hook: carry the request through `resolve` verbatim.
 */
function fakeShell(run: (spec: ShellExecSpec, request: ShellExecRequest) => Promise<ShellRunResult>): {
  shell: ShellExecutor
  requests: ShellExecRequest[]
} {
  const requests: ShellExecRequest[] = []
  const shell = {
    resolve(request: ShellExecRequest): ShellExecSpec {
      requests.push(request)
      return request as unknown as ShellExecSpec
    },
    async run(spec: ShellExecSpec): Promise<ShellRunResult> {
      return run(spec, requests[requests.length - 1]!)
    },
  } as unknown as ShellExecutor
  return { shell, requests }
}

function shellResult(over: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...over,
  }
}

const rule: VerifyRule = { glob: '**/*.ts', command: 'tsc -b' }
const settings = { ...DEFAULT_RULES_SETTINGS, enabled: true }
const signal = new AbortController().signal

describe('request shaping', () => {
  it('forwards the exec signal into the resolve request', async () => {
    let captured: AbortSignal | undefined
    const { shell } = fakeShell(async (_spec, request) => {
      captured = request.signal
      return shellResult()
    })
    const runner = createRunner({ shell, logger: console })
    await runner.run(rule, exec(signal), settings)
    expect(captured).toBe(signal)
  })

  it('passes the session cwd as workdir; absent cwd omits the key', async () => {
    const workdirs: (string | undefined)[] = []
    const { shell } = fakeShell(async (_spec, request) => {
      workdirs.push(request.workdir)
      return shellResult()
    })
    const runner = createRunner({ shell, logger: console })
    await runner.run(rule, exec(signal), settings, '/session/cwd')
    await runner.run(rule, exec(signal), settings)
    expect(workdirs).toEqual(['/session/cwd', undefined])
  })

  it('defaults the timeout to 60s and caps at 120s', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000)
    expect(MAX_TIMEOUT_MS).toBe(120_000)
    expect(clampTimeoutMs({ glob: 'a', command: 'b' })).toBe(60_000)
    expect(clampTimeoutMs({ glob: 'a', command: 'b', timeoutMs: 999_999 })).toBe(120_000)
    expect(clampTimeoutMs({ glob: 'a', command: 'b', timeoutMs: 500 })).toBe(500)
  })

  it('requests a large stdout budget (executor caps, we truncate consumer-side)', async () => {
    const budgets: (number | undefined)[] = []
    const { shell } = fakeShell(async (_spec, request) => {
      budgets.push(request.stdoutMaxBytes)
      return shellResult()
    })
    const runner = createRunner({ shell, logger: console })
    await runner.run(rule, exec(signal), settings)
    expect(budgets).toEqual([256 * 1024])
  })
})

describe('block composition', () => {
  it('exit 0 → one-liner with duration', async () => {
    let clock = 1000
    const { shell } = fakeShell(async () => { clock += 5; return shellResult({ stdout: { text: 'all good\n', truncated: false } }) })
    const runner = createRunner({ shell, logger: console, now: () => clock })
    const outcome = await runner.run(rule, exec(signal), settings)
    expect(outcome.block?.type).toBe('text')
    expect(outcome.block && 'text' in outcome.block && outcome.block.text).toBe('[auto-verify] tsc -b — ok (5ms)')
    expect(outcome.skipped).toBeUndefined()
  })

  it('verbose-on-success includes the kept output', async () => {
    const { shell } = fakeShell(async () => shellResult({ stdout: { text: 'details\n', truncated: false } }))
    const runner = createRunner({ shell, logger: console, now: () => 5 })
    const outcome = await runner.run(rule, exec(signal), { ...settings, verboseOnSuccess: true })
    expect(outcome.block && 'text' in outcome.block && outcome.block.text).toContain('details')
    expect(outcome.block && 'text' in outcome.block && outcome.block.text).toContain('— exit 0 (') // Phase 0 compose pins the verbose-success header
  })

  it('exit 1 → header + first line + tail within max-output-bytes; middle elided', async () => {
    const lines = ['FIRST LINE']
    for (let i = 0; i < 200; i++) lines.push(`middle line ${i} ${'x'.repeat(40)}`)
    lines.push('LAST LINE error TS2345')
    const { shell } = fakeShell(async () => shellResult({ exitCode: 1, stdout: { text: lines.join('\n'), truncated: false } }))
    const runner = createRunner({ shell, logger: console, now: () => 7 })
    const outcome = await runner.run(rule, exec(signal), { ...settings, maxOutputBytes: 512 })
    const text = outcome.block && 'text' in outcome.block ? outcome.block.text : ''
    expect(text).toContain('[auto-verify] tsc -b — exit 1 (0ms)')
    expect(text).toContain('FIRST LINE')
    expect(text).toContain('LAST LINE error TS2345')
    expect(text).not.toContain('middle line 100')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 + '[auto-verify] tsc -b — exit 1 (7ms)\n'.length + 20)
  })

  it('empty output on failure renders "no output"', async () => {
    const { shell } = fakeShell(async () => shellResult({ exitCode: 2 }))
    const runner = createRunner({ shell, logger: console, now: () => 1 })
    const outcome = await runner.run(rule, exec(signal), settings)
    expect(outcome.block && 'text' in outcome.block && outcome.block.text).toBe('[auto-verify] tsc -b — exit 2 (0ms)\nno output')
  })
})

describe('fail-soft error surface', () => {
  it('run() rejection appends nothing and logs debug', async () => {
    const debug = vi.fn()
    const { shell } = fakeShell(async () => { throw new Error('no such shell') })
    const runner = createRunner({ shell, logger: { debug }, now: () => 1 })
    const outcome = await runner.run(rule, exec(signal), settings)
    expect(outcome.block).toBeUndefined()
    expect(debug).toHaveBeenCalled()
    expect(outcome.run).toBeUndefined()
  })

  it('timeout appends nothing and surfaces timedOut:true, exitCode:null', async () => {
    const debug = vi.fn()
    const { shell } = fakeShell(async () => shellResult({ exitCode: null, timedOut: true }))
    const runner = createRunner({ shell, logger: { debug }, now: () => 1 })
    const outcome = await runner.run(rule, exec(signal), settings)
    expect(outcome.block).toBeUndefined()
    expect(debug).toHaveBeenCalled()
    expect(outcome.run).toEqual({ exitCode: null, timedOut: true })
  })

  it('signal death (exitCode null, not timed out) appends nothing', async () => {
    const { shell } = fakeShell(async () => shellResult({ exitCode: null, signal: 'SIGKILL' }))
    const runner = createRunner({ shell, logger: { debug: vi.fn() }, now: () => 1 })
    const outcome = await runner.run(rule, exec(signal), settings)
    expect(outcome.block).toBeUndefined()
  })
})

describe('burst labeling (doc §3.5)', () => {
  it('second run within the debounce window is labeled, never skipped', async () => {
    let clock = 1000
    const { shell } = fakeShell(async () => shellResult({ exitCode: 1, stdout: { text: 'boom\n', truncated: false } }))
    const runner = createRunner({ shell, logger: console, now: () => clock })
    const first = await runner.run(rule, exec(signal), settings)
    clock += 100
    const second = await runner.run(rule, exec(signal), settings)
    const firstText = first.block && 'text' in first.block ? first.block.text : ''
    const secondText = second.block && 'text' in second.block ? second.block.text : ''
    expect(firstText).not.toContain('burst')
    expect(secondText).toContain('[auto-verify] burst — result may overlap edits from 100ms ago')
    expect(secondText).toContain('— exit 1')
  })

  it('a run after the debounce window has no burst label', async () => {
    let clock = 1000
    const { shell } = fakeShell(async () => shellResult())
    const runner = createRunner({ shell, logger: console, now: () => clock })
    await runner.run(rule, exec(signal), settings)
    clock += 6000
    const later = await runner.run(rule, exec(signal), settings)
    const text = later.block && 'text' in later.block ? later.block.text : ''
    expect(text).not.toContain('burst')
    expect(text).toContain('— ok')
  })

  it('rule keys are glob+command pairs (same glob, different command → no label)', async () => {
    let clock = 1000
    const { shell } = fakeShell(async () => shellResult())
    const runner = createRunner({ shell, logger: console, now: () => clock })
    await runner.run(rule, exec(signal), settings)
    clock += 10
    const other = await runner.run({ glob: '**/*.ts', command: 'eslint' }, exec(signal), settings)
    const text = other.block && 'text' in other.block ? other.block.text : ''
    expect(text).not.toContain('burst')
  })
})

/**
 * BEHAVIOR-PINNING PROBE against the REAL shell executor (design doc §3.3):
 * a 10s sleep rule with a ~500ms timeout must come back `timedOut: true` +
 * `exitCode: null`. Executor drift (e.g. returning a real exit code, or
 * rejecting on timeout) fails loudly here.
 */
describe('timeout probe — real ShellExecutor', () => {
  it('node -e setTimeout(10s) under a 500ms budget → timedOut, exitCode null, no block', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor)
    const shell = ctx.get('shell') as ShellExecutor
    expect(shell).toBeTruthy()
    const debug = vi.fn()
    const runner = createRunner({ shell, logger: { debug }, now: () => Date.now() })
    const slow: VerifyRule = { glob: '**/*.ts', command: 'node -e "setTimeout(()=>{},10000)"', timeoutMs: 500 }
    const outcome = await runner.run(slow, exec(signal), settings)
    expect(outcome.run).toEqual({ exitCode: null, timedOut: true })
    expect(outcome.block).toBeUndefined()
  }, 20_000)
})

describe('keepOutput (pure)', () => {
  it('keeps everything within budget', () => {
    expect(keepOutput('abc\n', 'def\n', 4096)).toBe('abc\ndef')
  })

  it('under budget with empty stderr returns stdout alone', () => {
    expect(keepOutput('only stdout\n', '', 4096)).toBe('only stdout')
  })

  it('first line + tail within budget, middle dropped', () => {
    const lines = ['head']
    for (let i = 0; i < 50; i++) lines.push(`mid-${i}`)
    lines.push('tail')
    const kept = keepOutput(lines.join('\n'), '', 40)
    expect(kept.startsWith('head\n')).toBe(true)
    expect(kept.endsWith('tail')).toBe(true)
    expect(kept).not.toContain('mid-0')
  })
})
