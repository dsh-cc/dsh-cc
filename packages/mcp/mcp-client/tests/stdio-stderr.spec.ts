import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createTransport } from '@dsh-cc/mcp-client/src/transport.ts'
import {
  BoundedTail,
  STDERR_WARN_CAPACITY,
  STDIO_LOG_MAX_BYTES,
  attachStdioStderrDrain,
  createStdioStderrSink,
  formatStdioStderrForWarn,
  stdioStderrTail,
} from '@dsh-cc/mcp-client/src/stdio-stderr.ts'
import type { Config } from '@dsh-cc/mcp-client'

// TIMEOUT-BUDGET: keep byte-identical across spec files.
// scale: DSH_TEST_TIMEOUT_SCALE (debug override), else 2 on GitHub Actions, else 1.
// Must be an integer in [1,4]; anything else → 1. Values >2 exceed what R4 was sized for.
const raw = Number(process.env.DSH_TEST_TIMEOUT_SCALE ?? (process.env.CI === 'true' ? 2 : 1))
const scale = Number.isInteger(raw) && raw >= 1 && raw <= 4 ? raw : 1

// File outer is flat 30s (R4: worst per-test nesting below is one 5s×scale
// helper wait, so 30s outer keeps strict headroom at every allowed scale).
vi.setConfig({ testTimeout: 30_000 })

const SESSION_HEADER = `--- dsh-cc pid ${process.pid}`

function stdioConfig(): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: process.execPath,
    args: ['-e', 'process.stderr.write("banner-line\\n")'],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

describe('BoundedTail', () => {
  it('drops the oldest characters past capacity', () => {
    const tail = new BoundedTail(4)
    tail.push('abc')
    tail.push('def')
    expect(tail.snapshot()).toBe('cdef')
  })
})

describe('formatStdioStderrForWarn', () => {
  it('returns undefined for empty or whitespace tails', () => {
    expect(formatStdioStderrForWarn('')).toBeUndefined()
    expect(formatStdioStderrForWarn('  \n  ')).toBeUndefined()
  })

  it('collapses newlines and keeps at most 1 KB', () => {
    expect(formatStdioStderrForWarn('a\nb\r\nc')).toBe('a⏎b⏎c')
    const long = `${'x'.repeat(STDERR_WARN_CAPACITY)}y`
    expect(formatStdioStderrForWarn(long)).toBe(`${'x'.repeat(STDERR_WARN_CAPACITY - 1)}y`)
  })
})

describe('stdioStderrTail', () => {
  it('returns empty string for transports with no attached drain', () => {
    expect(stdioStderrTail({} as Transport)).toBe('')
  })

  it('does not throw when the SDK mock has no stderr stream', () => {
    expect(() => attachStdioStderrDrain({} as never, 'srv')).not.toThrow()
  })
})

describe('createTransport stdio stderr capture', () => {
  let logDir = ''

  afterEach(() => {
    if (logDir !== '') rmSync(logDir, { recursive: true, force: true })
    logDir = ''
  })

  it('does not create the log file before start (lazy open on first chunk)', () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    createTransport(stdioConfig(), { logDir })
    expect(existsSync(join(logDir, 'srv.log'))).toBe(false)
  })

  it('drains piped stderr into the ring and an append-only log file', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    const transport = createTransport(stdioConfig(), { logDir })
    expect((transport as { stderr: unknown }).stderr).not.toBeNull()
    await transport.start()
    try {
      await viWaitForLog(join(logDir, 'srv.log'), 'banner-line')
      expect(stdioStderrTail(transport)).toContain('banner-line')
      const log = readFileSync(join(logDir, 'srv.log'), 'utf8')
      expect(log).toContain(`--- dsh-cc pid ${process.pid}`)
      expect(log).toContain('banner-line')
    } finally {
      await transport.close()
    }
  })

  it('appends a second session header across sequential generations', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    const first = createTransport(stdioConfig(), { logDir })
    await first.start()
    await first.close()

    const second = createTransport(stdioConfig(), { logDir })
    await second.start()
    try {
      // Two generations → two headers proves flags: 'a' (never 'w'). The
      // poll itself certifies the first generation's header was flushed
      // before close, so no separate pre-close wait is needed (R4 nesting).
      await viWaitForCondition(() => countHeaders() >= 2)
      expect(countHeaders()).toBe(2)
    } finally {
      await second.close()
    }
  })

  /** Count session headers currently flushed to the log file (missing file → 0). */
  function countHeaders(): number {
    try {
      return readFileSync(join(logDir, 'srv.log'), 'utf8')
        .split(`--- dsh-cc pid ${process.pid}`).length - 1
    } catch {
      return 0
    }
  }
})

describe('stdio stderr log rotation', () => {
  let logDir = ''

  afterEach(() => {
    if (logDir !== '') rmSync(logDir, { recursive: true, force: true })
    logDir = ''
  })

  it('exports the default cap of 4 MiB', () => {
    expect(STDIO_LOG_MAX_BYTES).toBe(4 * 1024 * 1024)
  })

  /** A stdio config whose child writes the given lines with gaps between them. */
  function childConfig(lines: string[]): Config {
    const body = lines
      .map((line, i) => `setTimeout(() => process.stderr.write(${JSON.stringify(line)}), ${i * 60})`)
      .join(';') + ';setTimeout(() => process.exit(0), ' + lines.length * 60 + ')'
    return { ...stdioConfig(), args: ['-e', body] }
  }

  function logPath(): string {
    return join(logDir, 'srv.log')
  }

  function backupPath(): string {
    return join(logDir, 'srv.log.1')
  }

  function readOr(path: string, fallback = ''): string {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return fallback
    }
  }

  it('rotates an oversized log at open time, moving old content to .log.1', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    writeFileSync(logPath(), `${'x'.repeat(100)}OLD-MARKER`)
    const transport = createTransport(childConfig(['banner\n']), { logDir, maxBytes: 64 })
    await transport.start()
    try {
      // Predicate covers BOTH asserted files: the fresh header (the
      // rotation's open-time header flushes asynchronously) and the child
      // marker; the backup assertion is separately polled below.
      await viWaitForCondition(() =>
        readOr(logPath()).includes('banner') && readOr(logPath()).startsWith(SESSION_HEADER))
      expect(readOr(backupPath())).toContain('OLD-MARKER')
      expect(readOr(logPath()).startsWith(`--- dsh-cc pid ${process.pid}`)).toBe(true)
      expect(readOr(logPath())).not.toContain('OLD-MARKER')
    } finally {
      await transport.close()
    }
  })

  it('seeds the byte tally from the pre-existing size so a first chunk can cross the cap', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    writeFileSync(logPath(), 'x'.repeat(60))
    const transport = createTransport(childConfig(['A'.repeat(10) + '\n']), { logDir, maxBytes: 64 })
    await transport.start()
    try {
      // The rename creates .log.1 immediately; the boundary chunk flushes
      // into it asynchronously (the old stream's fd follows the inode).
      // Poll covers BOTH asserted files: the boundary chunk's backup flush
      // and the fresh generation's asynchronously queued header.
      await viWaitForCondition(() =>
        readOr(backupPath()).includes('A'.repeat(10)) &&
        readOr(logPath()).startsWith(SESSION_HEADER))
      // The pre-existing file had a session header appended when opened; the
      // tally is seeded from the PRE-HEADER size, so a first small chunk
      // still crosses the cap.
      const backup = readOr(backupPath())
      expect(backup.startsWith('x'.repeat(60))).toBe(true)
      expect(backup).toContain('A'.repeat(10))
      expect(readOr(logPath()).startsWith(`--- dsh-cc pid ${process.pid}`)).toBe(true)
    } finally {
      await transport.close()
    }
  })

  it('conserves every byte and both markers under real-pipe delivery', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    const childBytes = `PRE-MARKER\n${'y'.repeat(120)}POST-MARKER\n`.length
    const transport = createTransport(childConfig(['PRE-MARKER\n', 'y'.repeat(120), 'POST-MARKER\n']), {
      logDir,
      maxBytes: 128,
    })
    await transport.start()
    try {
      // A real pipe may coalesce the child's 60ms-spaced writes, so only
      // invariants hold here: each marker exists SOMEWHERE and no byte is
      // lost. Routing-placement claims live in the deterministic seam tests
      // below (F4.2).
      const somewhere = (needle: string): boolean =>
        readOr(logPath()).includes(needle) || readOr(backupPath()).includes(needle)
      await viWaitForCondition(() =>
        somewhere('PRE-MARKER') && somewhere('POST-MARKER') && somewhere(SESSION_HEADER))
      const backup = readOr(backupPath())
      const fresh = readOr(logPath())
      // Total bytes conserved: headers + child output, nothing silently dropped.
      expect(backup.length + fresh.length).toBeGreaterThanOrEqual(childBytes)
      // A fresh session header marks the new generation.
      expect(fresh).toContain(SESSION_HEADER)
    } finally {
      await transport.close()
    }
  })

  describe('deterministic chunk routing (createStdioStderrSink seam)', () => {
    // Routing placement driven by childConfig's 60ms spacing is timing-
    // dependent: delayed pipe consumption coalesces writes. Here chunk
    // boundaries are synthetic inputs into the same production routing the
    // pipe data handler runs (F4.2, D2: deterministic seam).

    function sink(maxBytes: number): ReturnType<typeof createStdioStderrSink> {
      return createStdioStderrSink(logPath(), maxBytes)
    }

    it('routes each synthetic chunk per production rules; never splits a chunk', async () => {
      writeFileSync(logPath(), 'x'.repeat(60))
      const s = sink(64)
      s.write('A'.repeat(10) + '\n') // tally 71 ≥ 64 → rotates; chunk stays in old generation
      s.write('B'.repeat(20))
      s.write('C'.repeat(20))
      await s.close()
      const backup = readOr(backupPath())
      expect(backup).toContain('A')
      expect(backup).not.toContain('B')
      expect(backup).not.toContain('C')
      const fresh = readOr(logPath())
      expect(fresh).toContain('B')
      expect(fresh).toContain('C')
      // One header per generation, exactly once per generation.
      expect(backup.split(SESSION_HEADER).length - 1).toBe(1)
      expect(fresh.split(SESSION_HEADER).length - 1).toBe(1)
    })

    it('POST-MARKER lands in the fresh generation after the boundary chunk', async () => {
      const s = sink(128)
      s.write('PRE-MARKER\n')
      s.write('y'.repeat(120)) // crosses maxBytes; this chunk stays in the old generation
      s.write('POST-MARKER\n')
      await s.close()
      const backup = readOr(backupPath())
      const fresh = readOr(logPath())
      expect(backup).toContain('PRE-MARKER')
      expect(backup).not.toContain('POST-MARKER')
      expect(fresh).toContain('POST-MARKER')
      expect(fresh).toContain(SESSION_HEADER)
      expect(backup.length + fresh.length).toBeGreaterThanOrEqual(
        `PRE-MARKER\n${'y'.repeat(120)}POST-MARKER\n`.length)
    })

    it('coalesced delivery loses no bytes and no markers', async () => {
      const coalesced = `PRE-MARKER\n${'y'.repeat(120)}POST-MARKER\n`
      const s = sink(128)
      s.write(coalesced) // one chunk crossing the boundary: never split
      await s.close()
      const backup = readOr(backupPath())
      const fresh = readOr(logPath())
      expect(backup).toContain('PRE-MARKER')
      expect(backup).toContain('POST-MARKER')
      expect(backup.length + fresh.length).toBeGreaterThanOrEqual(coalesced.length)
      expect(fresh).not.toContain('y'.repeat(10))
      expect(fresh).toContain(SESSION_HEADER)
    })

    it('coalesced A/B/C chunk rotates exactly once and keeps B/C out of the backup', async () => {
      writeFileSync(logPath(), 'x'.repeat(60))
      const coalesced = 'A'.repeat(10) + '\n' + 'B'.repeat(20) + 'C'.repeat(20)
      const s = sink(64)
      s.write(coalesced)
      await s.close()
      const backup = readOr(backupPath())
      const fresh = readOr(logPath())
      expect(backup).toContain('A')
      expect(backup).toContain('B')
      expect(backup).toContain('C')
      expect(fresh).not.toContain('B')
      expect(fresh).not.toContain('C')
      expect(fresh).toContain(SESSION_HEADER)
      expect(backup.split(SESSION_HEADER).length - 1).toBe(1)
      expect(fresh.split(SESSION_HEADER).length - 1).toBe(1)
    })
  })

  it('keeps exactly one backup generation — the previous .log.1 is discarded', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    writeFileSync(backupPath(), 'SENTINEL')
    writeFileSync(logPath(), `${'x'.repeat(100)}OLD-MARKER`)
    const transport = createTransport(childConfig(['banner\n']), { logDir, maxBytes: 64 })
    await transport.start()
    try {
      // Predicate covers the asserted backup content; the fresh header is
      // polled so the startsWith assertion below is already satisfied.
      await viWaitForCondition(() =>
        readOr(backupPath()).includes('OLD-MARKER') &&
        readOr(logPath()).includes('banner'))
      const backup = readOr(backupPath())
      expect(backup).toContain('OLD-MARKER')
      expect(backup).not.toContain('SENTINEL')
    } finally {
      await transport.close()
    }
  })

  it('survives an unrenamable backup path: appends continue and the process closes cleanly', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    mkdirSync(backupPath())
    writeFileSync(logPath(), 'x'.repeat(100))
    const transport = createTransport(childConfig(['A'.repeat(30), 'B'.repeat(30), 'C'.repeat(30)]), {
      logDir,
      maxBytes: 64,
    })
    await transport.start()
    try {
      // Rotation is disabled after the rename failure; appends continue unbounded.
      await viWaitForCondition(() => readOr(logPath()).includes('C'))
      expect(statSync(backupPath()).isDirectory()).toBe(true)
      expect(readOr(logPath())).toContain('C')
      expect(existsSync(join(backupPath(), 'srv.log'))).toBe(false)
    } finally {
      await transport.close()
    }
  })

  it('maxBytes 0 disables rotation entirely', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-stderr-'))
    writeFileSync(logPath(), 'x'.repeat(10))
    const transport = createTransport(childConfig(['A'.repeat(200)]), { logDir, maxBytes: 0 })
    await transport.start()
    try {
      await viWaitForCondition(() => (statSync(logPath()).size) > 64)
      expect(existsSync(backupPath())).toBe(false)
    } finally {
      await transport.close()
    }
  })
})

async function viWaitForCondition(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000 * scale
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error('timed out waiting for condition')
}

async function viWaitForLog(path: string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000 * scale
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      expect(readFileSync(path, 'utf8')).toContain(needle)
      return
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    }
  }
  throw lastError ?? new Error(`timed out waiting for ${needle} in ${path}`)
}
