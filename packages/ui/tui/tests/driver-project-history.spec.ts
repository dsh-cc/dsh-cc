import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { loadHistory, saveHistory } from '@dsh-cc/tui/history.ts'
import { readProjectSessionIds } from '@dsh-cc/tui/project-sessions.ts'

/**
 * Per-project composer history: boot buckets history under
 * `$DSH_HOME/tui/projects/<key>`, cold-cuts the legacy globals, and /resume
 * rebinds the bucket onto the switched session's project. Every cwd in this
 * spec is a non-git temp dir, so the project key is the sha256[:16] of the
 * resolved directory itself (the resolveProject fallback) — no git needed.
 */

/** sha256[:16] of the resolved path — mirrors project.ts's fallback key. */
const keyOf = (cwd: string): string =>
  createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)

const bucketOf = (home: string, cwd: string): string =>
  join(home, 'tui', 'projects', keyOf(cwd))

interface FakeSession {
  id: string
  cwd: string
  events?: unknown[]
  status?: string
}

function makeCtx(opts: {
  createSession: FakeSession
  resumeSessions?: Record<string, FakeSession>
}): { ctx: Record<string, unknown> } {
  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: {},
    session: { id: s.id, header: { cwd: s.cwd }, events: s.events ?? [] , snapshotEvents() { return this.events } },
    id: `agent-${s.id}`,
    status: s.status ?? 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => ({ agent: makeAgent(opts.createSession), dispose: async () => {} }),
      resume: async (req: { resumeSessionId: string }) => {
        const s = opts.resumeSessions?.[req.resumeSessionId]
        if (s === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return { agent: makeAgent(s), dispose: async () => {} }
      },
    },
  }
  return { ctx }
}

describe('createDriver per-project history', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-projhist-home-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('buckets a submitted prompt under projects/<key> when no historyDir is given', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-projhist-a-'))
    const { ctx } = makeCtx({ createSession: { id: 's-a', cwd } })
    const driver = await createDriver(ctx as never, { cwd })

    await driver.submit('hello project a')
    expect(driver.promptHistory).toEqual(['hello project a'])
    expect(loadHistory(bucketOf(tempHome, cwd))).toEqual(['hello project a'])
    // Nothing leaks into the legacy global location.
    expect(existsSync(join(tempHome, 'tui', 'history.txt'))).toBe(false)
    // The session is pinned in the project's sidecar index.
    expect(readProjectSessionIds(bucketOf(tempHome, cwd)).has('s-a')).toBe(true)
  })

  it('cold-cuts legacy global history files at boot', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-projhist-a-'))
    const tuiDir = join(tempHome, 'tui')
    saveHistory(['legacy prompt'], tuiDir)
    writeFileSync(join(tuiDir, 'bash-history.txt'), '"legacy cmd"\n')

    const { ctx } = makeCtx({ createSession: { id: 's-a', cwd } })
    const driver = await createDriver(ctx as never, { cwd })

    expect(existsSync(join(tuiDir, 'history.txt'))).toBe(false)
    expect(existsSync(join(tuiDir, 'bash-history.txt'))).toBe(false)
    expect(existsSync(join(tuiDir, 'history.global.bak'))).toBe(true)
    expect(existsSync(join(tuiDir, 'bash-history.global.bak'))).toBe(true)
    // The cold cut does NOT migrate: the fresh project bucket starts empty.
    expect(driver.promptHistory).toEqual([])
  })

  it('an explicit historyDir skips the history bucket, the cold cut, and rebinding', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-projhist-a-'))
    const dir = mkdtempSync(join(tmpdir(), 'dsh-projhist-explicit-'))
    const tuiDir = join(tempHome, 'tui')
    saveHistory(['legacy prompt'], tuiDir)

    const otherCwd = mkdtempSync(join(tmpdir(), 'dsh-projhist-b-'))
    const { ctx } = makeCtx({
      createSession: { id: 's-a', cwd },
      resumeSessions: { 's-b': { id: 's-b', cwd: otherCwd } },
    })
    const driver = await createDriver(ctx as never, { cwd, historyDir: dir })

    // No cold cut, and history never lands in any project bucket (the
    // picker-side sidecar index MAY still record session ids — it is not
    // gated by the history override).
    expect(existsSync(join(tuiDir, 'history.txt'))).toBe(true)
    expect(loadHistory(bucketOf(tempHome, cwd))).toEqual([])

    await driver.submit('pinned')
    expect(loadHistory(dir)).toEqual(['pinned'])

    // Switching projects must not rebind away from the explicit dir.
    await driver.switchSession('s-b')
    await driver.submit('still pinned')
    expect(loadHistory(dir)).toEqual(['pinned', 'still pinned'])
    expect(loadHistory(bucketOf(tempHome, otherCwd))).toEqual([])
  })

  it('/resume rebinds history onto the switched session\'s project', async () => {
    const cwdA = mkdtempSync(join(tmpdir(), 'dsh-projhist-a-'))
    const cwdB = mkdtempSync(join(tmpdir(), 'dsh-projhist-b-'))
    saveHistory(['b prompt'], bucketOf(tempHome, cwdB))

    const { ctx } = makeCtx({
      createSession: { id: 's-a', cwd: cwdA },
      resumeSessions: { 's-b': { id: 's-b', cwd: cwdB } },
    })
    const driver = await createDriver(ctx as never, { cwd: cwdA })
    expect(driver.promptHistory).toEqual([])

    await driver.switchSession('s-b')
    // Recall now reads project B's bucket.
    expect(driver.promptHistory).toEqual(['b prompt'])

    // New prompts persist into project B's bucket, not A's.
    await driver.submit('b follow-up')
    expect(loadHistory(bucketOf(tempHome, cwdB))).toEqual(['b prompt', 'b follow-up'])
    expect(loadHistory(bucketOf(tempHome, cwdA))).toEqual([])
  })

  it('/resume within the same project keeps the live history (no rebind)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-projhist-a-'))
    const { ctx } = makeCtx({
      createSession: { id: 's-a', cwd },
      resumeSessions: { 's-b': { id: 's-b', cwd } },
    })
    const driver = await createDriver(ctx as never, { cwd })
    await driver.submit('a prompt')
    const before = driver.promptHistory

    await driver.switchSession('s-b')
    // Same array identity: no reload replaced the live history.
    expect(driver.promptHistory).toBe(before)
    expect(driver.promptHistory).toEqual(['a prompt'])
  })
})
