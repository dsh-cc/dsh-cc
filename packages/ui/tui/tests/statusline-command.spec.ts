import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStatusLineCommand, type StatusLineCommandDeps } from '../src/harness/statusline-command.ts'
import type { ShellExecutorLike, ShellRunResultLike } from '../src/state/driver-types.ts'

const DEBOUNCE_MS = 300
const TIMEOUT_MS = 60_000
const MAX_BYTES = 64 * 1024

/** One recorded resolve+run with a deferred settle the test controls. */
type RecordedRun = {
  request: { command: string; stdin?: string; env?: Record<string, string>; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number }
  spec: Record<string, unknown>
  signal: AbortSignal
  settle: (result: Partial<ShellRunResultLike> | Error) => void
}


interface Harness {
  runs: RecordedRun[]
  executor: ShellExecutorLike
  settled: string[]
  runner: ReturnType<typeof createStatusLineCommand>
}

function ok(stdout = 'line1\nline2\n'): Partial<ShellRunResultLike> {
  return { exitCode: 0, timedOut: false, stdout: { text: stdout }, stderr: { text: '' } }
}

function harness(deps: Partial<StatusLineCommandDeps> = {}): Harness {
  const runs: RecordedRun[] = []
  const settled: string[] = []
  const executor: ShellExecutorLike = {
    resolve(request) {
      const signal = (request as { signal?: AbortSignal }).signal ?? new AbortController().signal
      const spec = { ...request, workdir: request.workdir ?? '/repo' }
      let settle!: (result: Partial<ShellRunResultLike> | Error) => void
      const done = new Promise<ShellRunResultLike>((resolvePromise, reject) => {
        settle = (result) => {
          if (result instanceof Error) reject(result)
          else resolvePromise({
            exitCode: 0,
            timedOut: false,
            stdout: { text: '' },
            stderr: { text: '' },
            ...result,
          } as ShellRunResultLike)
        }
      })
      runs.push({ request: request as RecordedRun['request'], spec, signal, settle })
      void done.then(
        (result) => { settled.push(result.stdout.text) },
        () => { /* spawn throws surface as rejections; the runner must not crash */ },
      )
      return {
        spec,
        promise: done,
      } as unknown as ReturnType<ShellExecutorLike['resolve']>
    },
    async execute(spec) {
      return {
        result: () => (spec as unknown as { promise: Promise<ShellRunResultLike> }).promise,
      }
    },
  }
  const runner = createStatusLineCommand({
    executor,
    terminalSize: () => ({ columns: 100, rows: 40 }),
    onSettled: () => { /* per-test override */ },
    ...deps,
  })
  return { runs, executor, settled, runner }
}

describe('statusline command runner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces 5 rapid updates into exactly 1 spawn', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) h.runner.update({ command: 'cmd' }, { n: i })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(h.runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.request.command).toBe('cmd')
    h.runner.dispose()
  })

  it('kills the in-flight child before scheduling the replacement', async () => {
    const h = harness()
    h.runner.update({ command: 'a' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const first = h.runs[0]!
    expect(first.signal.aborted).toBe(false)
    h.runner.update({ command: 'b' }, {})
    // Kill happens at trigger time, not at the next spawn.
    expect(first.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.runs).toHaveLength(2)
    h.runner.dispose()
  })

  it('discards a stale generation-N settle once N+1 has landed', async () => {
    const settledValues: string[] = []
    const h = harness({ onSettled: (line: string) => { settledValues.push(line) } })
    h.runner.update({ command: 'a' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const first = h.runs[0]!
    h.runner.update({ command: 'b' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    const second = h.runs[1]!
    second.settle(ok('new\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('new')
    // The stale run settles late: it must not clobber the newer output.
    first.settle(ok('old\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('new')
    expect(settledValues).toEqual(['new'])
    h.runner.dispose()
  })

  it('update({ immediate: true }) bypasses the debounce', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {}, { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs).toHaveLength(1)
    h.runner.dispose()
  })

  it('sets COLUMNS/LINES from the terminal-size getter at spawn time', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.runs[0]!.request.env).toMatchObject({ COLUMNS: '100', LINES: '40' })
    h.runner.dispose()
  })

  it('sends the JSON payload plus a newline on stdin and the workdir', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, { session_id: 's1' }, { workdir: '/repo/sub' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.runs[0]!.request.stdin).toBe(JSON.stringify({ session_id: 's1' }) + '\n')
    expect(h.runs[0]!.request.workdir).toBe('/repo/sub')
    h.runner.dispose()
  })

  it('uses the 60s hard cap and 64KiB stdout cap in the request', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.runs[0]!.request.timeoutMs).toBe(TIMEOUT_MS)
    expect(h.runs[0]!.request.stdoutMaxBytes).toBe(MAX_BYTES)
    h.runner.dispose()
  })

  it('keeps ANSI bytes verbatim and trimEnd-s each row', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('\x1b[32mgreen line\x1b[0m\nsecond row\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('\x1b[32mgreen line\x1b[0m\nsecond row')
    h.runner.dispose()
  })

  it('keeps up to 3 rows in order, joined by newline, and notifies onSettled', async () => {
    const settledValues: string[] = []
    const h = harness({ onSettled: (line: string) => { settledValues.push(line) } })
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('row1\nrow2\nrow3\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('row1\nrow2\nrow3')
    expect(settledValues).toEqual(['row1\nrow2\nrow3'])
    h.runner.dispose()
  })

  it('caps 4+ rows to the first 3', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('a\nb\nc\nd\ne\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('a\nb\nc')
    h.runner.dispose()
  })

  it('drops trailing empty and whitespace-only rows', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('a\n \n\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('a')
    h.runner.dispose()
  })

  it('preserves interior empty rows', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('a\n\nb\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('a\n\nb')
    h.runner.dispose()
  })

  it('trimEnds each row individually', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('  a  \nb \n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('  a\nb')
    h.runner.dispose()
  })

  it('blanks when stdout is only whitespace or newlines', async () => {
    const settledValues: string[] = []
    const h = harness({ onSettled: (line: string) => { settledValues.push(line) } })
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('  \n\t\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('')
    expect(settledValues).toEqual([''])
    h.runner.dispose()
  })

  it('keeps single-line output byte-identical to the v1 first-line behavior', async () => {
    const h = harness()
    h.runner.update({ command: 'cmd' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runs[0]!.settle(ok('only row\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('only row')
    h.runner.dispose()
  })

  it('blanks on every failure class', async () => {
    const nonZero = harness()
    nonZero.runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    nonZero.runs[0]!.settle({ exitCode: 3, timedOut: false, stdout: { text: 'ignored\n' }, stderr: { text: '' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(nonZero.runner.latest()).toBe('')
    nonZero.runner.dispose()

    const killed = harness()
    killed.runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    killed.runs[0]!.settle({ exitCode: null, timedOut: false, stdout: { text: 'ignored\n' }, stderr: { text: '' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(killed.runner.latest()).toBe('')
    killed.runner.dispose()

    const timedOut = harness()
    timedOut.runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    timedOut.runs[0]!.settle({ exitCode: null, timedOut: true, stdout: { text: '' }, stderr: { text: '' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(timedOut.runner.latest()).toBe('')
    timedOut.runner.dispose()

    const empty = harness()
    empty.runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    empty.runs[0]!.settle(ok('\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(empty.runner.latest()).toBe('')
    empty.runner.dispose()
  })

  it('blanks when the executor throws on resolve/run', async () => {
    let boom = false
    const executor: ShellExecutorLike = {
      resolve(request) {
        if (boom) throw new Error('spawn failed')
        return { ...request, workdir: '/repo', timeoutMs: TIMEOUT_MS, stdoutMaxBytes: MAX_BYTES } as ReturnType<ShellExecutorLike['resolve']>
      },
      async execute() { return { result: async () => ok('never\n') as ShellRunResultLike } },
    }
    const runner = createStatusLineCommand({
      executor,
      terminalSize: () => ({ columns: 80, rows: 24 }),
      onSettled: () => {},
    })
    runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    boom = true
    runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.latest()).toBe('')
    runner.dispose()
  })

  it('cuts a hung run at the 60s hard cap', async () => {
    const h = harness()
    h.runner.update({ command: 'c' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(h.runs[0]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    expect(h.runs[0]!.signal.aborted).toBe(true)
    expect(h.runner.latest()).toBe('')
    h.runner.dispose()
  })

  it('dispose() aborts in-flight, clears the debounce, and quiets later settles', async () => {
    const h = harness()
    h.runner.update({ command: 'a' }, {})
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    h.runner.update({ command: 'b' }, {})
    h.runner.dispose()
    // The in-flight run was aborted at dispose.
    expect(h.runs[0]!.signal.aborted).toBe(true)
    // The pending debounce never spawns.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10)
    expect(h.runs).toHaveLength(1)
    // A late settle from the disposed generation is a quiet no-op.
    expect(() => { h.runs[0]!.settle(ok('late\n')) }).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runner.latest()).toBe('')
  })
})
