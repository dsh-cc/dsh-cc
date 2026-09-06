import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BASH_OUTPUT_LINE_CAP,
  BASH_STDOUT_MAX_BYTES,
  BASH_TIMEOUT_MS,
  createDriver,
} from '@dsh-cc/tui/harness/driver.ts'

/**
 * Driver-level contract for the `!` bash mode: a composer text with a leading
 * `!` is a LOCAL shell command — executed through the mounted shell executor
 * (or a direct child process when none is mounted), rendered into status rows,
 * never sent to the agent, never written to the session log, and kept in a
 * bash-only history stack.
 */

interface FakeSpec {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
}

interface FakeResult {
  exitCode: number | null
  timedOut: boolean
  stdout: { text: string }
  stderr: { text: string }
}

/** Scriptable shell-executor double recording every resolved spec it runs. */
function makeShellService(script: FakeResult[] = []) {
  const specs: FakeSpec[] = []
  const service = {
    resolve(request: { command: string; timeoutMs?: number; stdoutMaxBytes?: number }) {
      return {
        command: request.command,
        workdir: '/resolved-workdir',
        timeoutMs: request.timeoutMs ?? 30_000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 1_024,
      }
    },
    async run(spec: FakeSpec): Promise<FakeResult> {
      specs.push(spec)
      const next = script.shift()
      return next ?? { exitCode: 0, timedOut: false, stdout: { text: '' }, stderr: { text: '' } }
    },
  }
  return { service, specs }
}

/**
 * Minimal ctx stub (same shape the other driver specs use) with an optional
 * shell service and a seedable agent status — `running` boots the driver busy.
 */
function makeCtx(options: { shell?: unknown; status?: string } = {}) {
  const agent = {
    options: {},
    session: { id: 's-bash', header: {}, events: [] },
    id: 'agent-s-bash',
    status: options.status ?? 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const handle = { agent, dispose: async () => {} }
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'shell') return options.shell
      return undefined
    },
    on: () => () => {},
    agents: { create: async () => handle, resume: async () => handle },
  }
  return { ctx, agent }
}

/** The last status row in the transcript (bash output always lands last). */
function lastStatus(driver: { state: { rows: readonly { kind: string }[] } }): { kind: string; text: string; error?: boolean } {
  const rows = driver.state.rows as { kind: string; text: string; error?: boolean }[]
  const row = rows[rows.length - 1]!
  expect(row.kind).toBe('status')
  return row
}

describe('`!` bash mode (driver)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-bash-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('runs a leading-! submit through the shell service with the stripped command and a bounded spec', async () => {
    const { service, specs } = makeShellService([
      { exitCode: 0, timedOut: false, stdout: { text: 'hi\n' }, stderr: { text: '' } },
    ])
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!echo hi')

    expect(specs).toHaveLength(1)
    expect(specs[0]!.command).toBe('echo hi')
    expect(specs[0]!.timeoutMs).toBe(BASH_TIMEOUT_MS)
    expect(specs[0]!.stdoutMaxBytes).toBe(BASH_STDOUT_MAX_BYTES)
    // Output: an `$ cmd` echo row followed by the captured stdout.
    const rows = driver.state.rows as { kind: string; text: string; error?: boolean }[]
    const echoIndex = rows.findIndex(row => row.text === '$ echo hi')
    expect(echoIndex).toBeGreaterThan(-1)
    expect(rows[echoIndex + 1]!.text).toBe('hi')
    expect(rows[echoIndex + 1]!.error).toBeFalsy()
    // The command never reaches the agent or the composer history.
    await driver.dispose()
  })

  it('executes locally even while the agent is busy — no queueing, no prompt', async () => {
    const { service, specs } = makeShellService([
      { exitCode: 0, timedOut: false, stdout: { text: 'busy-ok\n' }, stderr: { text: '' } },
    ])
    const { ctx, agent } = makeCtx({ shell: service, status: 'running' })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })
    expect(driver.state.busy).toBe(true)

    await driver.submit('!echo busy')

    expect(specs).toHaveLength(1)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
    expect(lastStatus(driver).text).toBe('busy-ok')
    await driver.dispose()
  })

  it('marks the output row as an error on a non-zero exit and includes stderr', async () => {
    const { service } = makeShellService([
      { exitCode: 3, timedOut: false, stdout: { text: 'partial\n' }, stderr: { text: 'boom\n' } },
    ])
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!false-tool')

    const row = lastStatus(driver)
    expect(row.error).toBe(true)
    expect(row.text).toContain('partial')
    expect(row.text).toContain('boom')
    expect(row.text).toContain('exit code 3')
    await driver.dispose()
  })

  it('renders a timed-out command as an error row', async () => {
    const { service } = makeShellService([
      { exitCode: null, timedOut: true, stdout: { text: 'started\n' }, stderr: { text: '' } },
    ])
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!sleep forever')

    const row = lastStatus(driver)
    expect(row.error).toBe(true)
    expect(row.text).toContain('started')
    expect(row.text).toContain('timed out')
    await driver.dispose()
  })

  it(`caps displayed output at ${BASH_OUTPUT_LINE_CAP} lines with a hidden-remainder trailer`, async () => {
    const lines = Array.from({ length: BASH_OUTPUT_LINE_CAP + 5 }, (_, i) => `line-${i}`)
    const { service } = makeShellService([
      { exitCode: 0, timedOut: false, stdout: { text: `${lines.join('\n')}\n` }, stderr: { text: '' } },
    ])
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!seq 30')

    const row = lastStatus(driver)
    const rendered = row.text.split('\n')
    expect(rendered).toHaveLength(BASH_OUTPUT_LINE_CAP + 1)
    expect(rendered[0]).toBe('line-0')
    expect(rendered[BASH_OUTPUT_LINE_CAP - 1]).toBe(`line-${BASH_OUTPUT_LINE_CAP - 1}`)
    expect(rendered[BASH_OUTPUT_LINE_CAP]).toContain('+5')
    expect(row.text).not.toContain('line-25')
    await driver.dispose()
  })

  it('falls back to a direct child process when no shell service is mounted', async () => {
    const { ctx } = makeCtx()
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!echo fallback-ok')

    expect(lastStatus(driver).text).toBe('fallback-ok')
    expect(lastStatus(driver).error).toBeFalsy()
    await driver.dispose()
  })

  it('treats a pasted multi-word !line identically (normalization at submit)', async () => {
    const { service, specs } = makeShellService([
      { exitCode: 0, timedOut: false, stdout: { text: 'norm\n' }, stderr: { text: '' } },
    ])
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!echo   spaced  out')

    expect(specs[0]!.command).toBe('echo   spaced  out')
    expect(lastStatus(driver).text).toBe('norm')
    await driver.dispose()
  })

  it('ignores a bare `!` (and trailing whitespace) without touching the shell', async () => {
    const { service, specs } = makeShellService()
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })
    const bootRows = driver.state.rows.length

    await driver.submit('!')
    await driver.submit('!   ')

    expect(specs).toEqual([])
    expect(driver.state.rows).toHaveLength(bootRows)
    await driver.dispose()
  })

  it('keeps a separate bash history: newest-first recall, own file, prompt history untouched', async () => {
    const historyDir = mkdtempSync(join(tmpdir(), 'dsh-driver-bash-hist-'))
    const { service } = makeShellService()
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, {
      cwd: tempHome,
      historyDir,
      branchProbe: async () => undefined,
    })

    await driver.submit('!echo one')
    await driver.submit('!echo two')

    expect(driver.bashHistory).toEqual(['echo two', 'echo one'])
    // The bash commands live in their own file (oldest→newest), never in the
    // composer prompt history or its file.
    const raw = readFileSync(join(historyDir, 'bash-history.txt'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string)
    expect(raw).toEqual(['echo one', 'echo two'])
    expect(driver.promptHistory).toEqual([])
    expect(existsSync(join(historyDir, 'history.txt'))).toBe(false)
    await driver.dispose()
  })

  it('suppresses consecutive duplicate commands in the bash history', async () => {
    const { service } = makeShellService()
    const { ctx } = makeCtx({ shell: service })
    const driver = await createDriver(ctx as never, { cwd: tempHome, branchProbe: async () => undefined })

    await driver.submit('!echo same')
    await driver.submit('!echo same')

    expect(driver.bashHistory).toEqual(['echo same'])
    await driver.dispose()
  })

  it('seeds bash history from the persisted file at boot (newest-first)', async () => {
    const historyDir = mkdtempSync(join(tmpdir(), 'dsh-driver-bash-seed-'))
    const { ctx } = makeCtx()
    // Simulate a previous session's persisted history (oldest→newest on disk).
    await createDriver(ctx as never, {
      cwd: tempHome,
      historyDir,
      branchProbe: async () => undefined,
    }).then(async driver => {
      await driver.submit('!echo old')
      await driver.submit('!echo new')
      await driver.dispose()
    })

    const second = await createDriver(ctx as never, {
      cwd: tempHome,
      historyDir,
      branchProbe: async () => undefined,
    })
    expect(second.bashHistory).toEqual(['echo new', 'echo old'])
    await second.dispose()
  })
})
