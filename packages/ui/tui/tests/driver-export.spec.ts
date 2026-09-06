import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { rowsToMarkdown } from '@dsh-cc/tui/export-markdown.ts'

/**
 * Minimal ctx stub (same shape the notice/todos specs use) with a seedable
 * durable event list — the driver folds these at boot, which is how the
 * transcript gets user/assistant rows without a live agent.
 */
function makeCtx(events: unknown[]) {
  const agent = {
    options: {},
    session: { id: 's-export', header: {}, events },
    id: 'agent-s-export',
    status: 'idle',
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
      return undefined
    },
    on: () => () => {},
    agents: { create: async () => handle, resume: async () => handle },
  }
  return ctx
}

/** One user turn plus one assistant reply, folded into rows at boot. */
const CONVERSATION = [
  { type: 'user/message', data: { text: 'export me', source: { kind: 'user' } } },
  { type: 'assistant/chunk', data: { type: 'text', text: 'Here you go.' } },
]

describe('/export-md and /copy (driver slash paths)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-export-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  describe('/export-md', () => {
    it('writes the markdown transcript to an explicit path and notices it', async () => {
      const target = join(tempHome, 'exported.md')
      const driver = await createDriver(makeCtx(CONVERSATION) as never, {
        cwd: tempHome,
        branchProbe: async () => undefined,
      })
      await driver.submit(`/export-md ${target}`)
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe(rowsToMarkdown(driver.state.rows))
      expect(driver.state.notice).toBe(`Exported to ${target}`)
      await driver.dispose()
    })

    it('resolves a relative path against the session cwd', async () => {
      const driver = await createDriver(makeCtx(CONVERSATION) as never, {
        cwd: tempHome,
        branchProbe: async () => undefined,
      })
      await driver.submit('/export-md out-rel.md')
      const target = join(tempHome, 'out-rel.md')
      expect(existsSync(target)).toBe(true)
      expect(driver.state.notice).toBe(`Exported to ${target}`)
      await driver.dispose()
    })

    it('without an argument writes <sessionId>-<ts>.md under the export dir', async () => {
      const exportDir = join(tempHome, 'exports')
      const driver = await createDriver(makeCtx(CONVERSATION) as never, {
        cwd: tempHome,
        exportDir,
        branchProbe: async () => undefined,
      })
      await driver.submit('/export-md')
      const names = readdirSync(exportDir)
      expect(names).toHaveLength(1)
      expect(names[0]).toMatch(/^s-export-.+\.md$/)
      expect(readFileSync(join(exportDir, names[0]), 'utf8'))
        .toBe(rowsToMarkdown(driver.state.rows))
      expect(driver.state.notice).toBe(`Exported to ${join(exportDir, names[0])}`)
      await driver.dispose()
    })

    it('reports a failed write as a notice instead of throwing', async () => {
      const blocker = join(tempHome, 'blocker')
      writeFileSync(blocker, 'not a directory')
      const driver = await createDriver(makeCtx(CONVERSATION) as never, {
        cwd: tempHome,
        branchProbe: async () => undefined,
      })
      await driver.submit(`/export-md ${join(blocker, 'child', 'out.md')}`)
      expect(driver.state.notice).toMatch(/^Export failed: /)
      await driver.dispose()
    })
  })

  describe('/copy', () => {
    it('emits an OSC 52 clipboard sequence carrying the latest assistant reply', async () => {
      const copyWrite = vi.fn()
      const driver = await createDriver(makeCtx(CONVERSATION) as never, {
        cwd: tempHome,
        copyWrite,
        branchProbe: async () => undefined,
      })
      await driver.submit('/copy')
      const expected = Buffer.from('Here you go.', 'utf8').toString('base64')
      expect(copyWrite).toHaveBeenCalledTimes(1)
      expect(copyWrite).toHaveBeenCalledWith(`\x1b]52;c;${expected}\x07`)
      expect(driver.state.notice).toBe('Copied latest reply')
      await driver.dispose()
    })

    it('copies the LAST assistant reply, not the first', async () => {
      const copyWrite = vi.fn()
      const events = [
        { type: 'user/message', data: { text: 'one', source: { kind: 'user' } } },
        { type: 'assistant/chunk', data: { type: 'text', text: 'first reply' } },
        { type: 'user/message', data: { text: 'two', source: { kind: 'user' } } },
        { type: 'assistant/chunk', data: { type: 'text', text: 'second reply' } },
      ]
      const driver = await createDriver(makeCtx(events) as never, {
        cwd: tempHome,
        copyWrite,
        branchProbe: async () => undefined,
      })
      await driver.submit('/copy')
      const expected = Buffer.from('second reply', 'utf8').toString('base64')
      expect(copyWrite).toHaveBeenCalledWith(`\x1b]52;c;${expected}\x07`)
      await driver.dispose()
    })

    it('degrades to a notice when no assistant reply exists', async () => {
      const copyWrite = vi.fn()
      const driver = await createDriver(makeCtx([]) as never, {
        cwd: tempHome,
        copyWrite,
        branchProbe: async () => undefined,
      })
      await driver.submit('/copy')
      expect(copyWrite).not.toHaveBeenCalled()
      expect(driver.state.notice).toBe('Nothing to copy yet — no assistant reply in the transcript.')
      await driver.dispose()
    })
  })
})
